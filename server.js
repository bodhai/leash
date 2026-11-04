import "dotenv/config";
import express from "express";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { state, resetState, spendSummary, stats, loadState, saveState, flushState } from "./src/store.js";
import { bus, changed } from "./src/events.js";
import { runAgent, compilePolicy, AI_LIVE } from "./src/agent.js";
import * as paypal from "./src/paypal.js";
import * as commerce from "./src/commerce.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || "0.0.0.0"; // reachable from any device on the LAN
const PORT = Number(process.env.PORT) || 3000;
const PIN = process.env.LEASH_PIN || "";
const MODEL = process.env.LEASH_MODEL || "claude-opus-5-5";

const restored = loadState();
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));
// Serve AG Grid from node_modules so the ledger works on a LAN with no internet.
app.use("/vendor/ag-grid", express.static(path.join(__dirname, "node_modules", "ag-grid-community", "dist")));

function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e.message);
  res.status(400).json({ error: e.message });
});
const origin = (req) => String(req.get("x-leash-client") || "").slice(0, 40) || null;

// ---------------------------------------------------------------- open endpoints
app.get("/api/health", (_req, res) => res.json({ ok: true, uptime_s: Math.round(process.uptime()) }));

app.get("/api/config", (_req, res) => res.json({
  ai: AI_LIVE ? MODEL : null,
  paypal: paypal.LIVE ? "sandbox" : "simulated",
  paypalClientId: paypal.LIVE ? process.env.PAYPAL_CLIENT_ID : null,
  pinRequired: Boolean(PIN),
  lanUrls: lanUrls(),
  webhooks: Boolean(process.env.PAYPAL_WEBHOOK_ID),
}));

app.get("/api/qr", wrap(async (req, res) => {
  const text = String(req.query.text || "").slice(0, 300);
  if (!/^https?:\/\//.test(text)) throw new Error("text must be an http(s) URL");
  const svg = await QRCode.toString(text, { type: "svg", margin: 1, color: { dark: "#0b1f3a", light: "#ffffff" } });
  res.type("image/svg+xml").send(svg);
}));

// PayPal calls this directly, so it is exempt from the PIN; it is verified by signature instead.
app.post("/api/paypal/webhook", wrap(async (req, res) => {
  const verified = await paypal.verifyWebhook(req.headers, req.body).catch(() => false);
  if (!verified && process.env.LEASH_ALLOW_UNVERIFIED_WEBHOOKS !== "1") {
    return res.status(401).json({ error: "Webhook signature not verified (set PAYPAL_WEBHOOK_ID)" });
  }
  res.json(commerce.applyWebhook(req.body));
}));

// ---------------------------------------------------------------- PIN guard
// Anything on the LAN can reach the server, so an optional PIN protects every other API.
app.use("/api", (req, res, next) => {
  if (!PIN) return next();
  const given = req.get("x-leash-pin") || req.query.pin;
  if (given === PIN) return next();
  res.status(401).json({ error: "PIN required", pin: true });
});

app.get("/api/state", (_req, res) => res.json({
  policyText: state.policyText,
  policy: state.policy,
  mandate: state.mandate,
  ledger: state.ledger,
  spend: spendSummary(),
  stats: stats(),
  redteam: state.redteam,
  agentRunning: running,
  webhooks: state.webhooks.slice(0, 10),
}));

// Live updates for every open screen (laptop, phone, projector).
app.get("/api/stream", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 25e3);
  bus.on("event", send);
  req.on("close", () => { clearInterval(ping); bus.off("event", send); });
});

app.post("/api/policy", wrap(async (req, res) => {
  const text = String(req.body.text || "").slice(0, 2000);
  if (!text.trim()) throw new Error("Policy text is empty");
  const out = await compilePolicy(text);
  state.policyText = text;
  state.policy = out.policy;
  changed("policy", {}, origin(req));
  res.json(out);
}));

app.post("/api/redteam", (req, res) => {
  state.redteam = Boolean(req.body.enabled);
  changed("redteam", { enabled: state.redteam }, origin(req));
  res.json({ redteam: state.redteam });
});

// Agent run, streamed to the requesting browser as server-sent events over a POST response.
let running = false;
app.post("/api/agent", async (req, res) => {
  const message = String(req.body.message || "").slice(0, 2000);
  if (!message.trim()) return res.status(400).json({ error: "message required" });
  if (running) return res.status(409).json({ error: "The agent is already working on something." });
  running = true;
  bus.emit("event", { type: "agent", running: true, message, origin: origin(req) });
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const emit = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  emit.origin = origin(req);
  try {
    await runAgent(message, emit);
  } catch (e) {
    console.error(e);
    emit({ type: "error", message: e.message });
  } finally {
    running = false;
    saveState();
    bus.emit("event", { type: "agent", running: false, origin: origin(req) });
    emit({ type: "done" });
    res.end();
  }
});

app.post("/api/approvals/:id/order", wrap(async (req, res) => res.json(await commerce.createApprovalOrder(req.params.id))));
app.post("/api/approvals/:id/capture", wrap(async (req, res) => res.json(await commerce.captureApproval(req.params.id, origin(req)))));
app.post("/api/approvals/:id/decline", wrap(async (req, res) => res.json(commerce.declineApproval(req.params.id, origin(req)))));
app.post("/api/ledger/:id/refund", wrap(async (req, res) => res.json(await commerce.refund(req.params.id, origin(req)))));
app.post("/api/mandate/revoke", wrap(async (req, res) => res.json(await commerce.revokeMandate(origin(req)))));
app.post("/api/reset", (req, res) => {
  if (running) return res.status(409).json({ error: "Wait for the agent to finish." });
  resetState();
  changed("reset", {}, origin(req));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- start
const server = app.listen(PORT, HOST, () => {
  const line = "─".repeat(58);
  console.log(`\n${line}\n  Leash is running\n${line}`);
  console.log(`  This PC:      http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  On your LAN:  ${u}        (phone wallet: ${u}/phone.html)`);
  console.log(`  AI:           ${AI_LIVE ? `Claude (${MODEL})` : "offline planner — set ANTHROPIC_API_KEY for Claude"}`);
  console.log(`  PayPal:       ${paypal.LIVE ? "sandbox (Orders v2 + Vault v3)" : "simulated — set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET"}`);
  console.log(`  LAN PIN:      ${PIN ? "on" : "off (set LEASH_PIN to require one)"}`);
  console.log(`  State:        ${restored ? "restored from data/state.json" : "fresh"}`);
  console.log(`${line}\n  Press Ctrl+C to stop.\n`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { flushState(); process.exit(0); });

server.on("error", (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.error(`\nPort ${PORT} is already in use (is Leash already running in another window?).`);
  console.error(`Stop the other process, or pick another port:`);
  console.error(process.platform === "win32"
    ? `  PowerShell:  $env:PORT=${PORT + 1}; npm start\n  cmd:         set PORT=${PORT + 1} && npm start`
    : `  PORT=${PORT + 1} npm start`);
  process.exit(1);
});
