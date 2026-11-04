// Phone wallet: approve, decline, watch and revoke from any device on the LAN.
import { $, esc, usd, api, apiStream, liveUpdates, toast, describeChange, renderApprove, CLIENT_ID, STATUS_LABEL } from "./common.js";

let config = {};
let snapshot = null;
const rendered = new Set(); // pending cards already on screen (keeps PayPal buttons alive)

init().catch((e) => toast(`Could not connect: ${e.message}`, "bad"));

async function init() {
  config = await api("/api/config");
  $("#p-modes").textContent = `${config.ai ? "Claude" : "Offline planner"} · PayPal ${config.paypal}`;
  await refresh();
  liveUpdates(onLive, (ok) => $("#live-pill").classList.toggle("off", !ok));
  $("#p-revoke").onclick = revoke;
  $("#p-composer").addEventListener("submit", (e) => { e.preventDefault(); ask($("#p-input").value); });
}

function onLive(ev) {
  if (ev.type === "changed") {
    refresh();
    if (ev.origin !== CLIENT_ID) {
      const d = describeChange(ev);
      if (d) toast(...d);
      if (ev.reason === "approval_needed") navigator.vibrate?.([80, 60, 80]);
    }
  } else if (ev.type === "agent") {
    $("#p-working").hidden = !ev.running;
    if (ev.running) $("#p-working-text").textContent = `Agent is working on: “${ev.message}”`;
  }
}

async function refresh() {
  snapshot = await api("/api/state");
  const { spend, policy, stats, mandate } = snapshot;
  $("#p-left").textContent = usd(Math.max(0, spend.month_remaining));
  $("#p-spent").textContent = `${usd(spend.month_spent)} of ${usd(policy.monthly_budget)} committed`;
  const pct = Math.min(100, (spend.month_spent / policy.monthly_budget) * 100);
  $("#p-fill").style.width = `${pct}%`;
  $("#p-fill").className = `fill ${pct > 90 ? "over" : pct > 70 ? "hot" : ""}`;
  $("#p-auto").textContent = usd(stats.autonomous.amount);
  $("#p-protected").textContent = usd(stats.protected_amount);
  $("#p-blocked").textContent = String(stats.blocked.count);
  $("#p-working").hidden = !snapshot.agentRunning;

  const m = $("#p-mandate");
  m.className = `p-mandate ${mandate?.active ? "on" : mandate ? "off" : ""}`;
  $("#p-mandate-text").textContent = mandate?.active ? "Agent mandate: active — in-policy buys pay automatically"
    : mandate ? "Agent mandate: revoked" : "Agent mandate: none yet — approve a purchase to grant it";
  $("#p-revoke").hidden = !mandate?.active;

  renderPending();
  renderActivity();
}

function renderPending() {
  const pending = snapshot.ledger.filter((t) => t.status === "PENDING_APPROVAL");
  $("#p-count").textContent = String(pending.length);
  const box = $("#p-pending");
  const ids = new Set(pending.map((t) => t.id));
  for (const id of [...rendered]) if (!ids.has(id)) { box.querySelector(`[data-id="${id}"]`)?.remove(); rendered.delete(id); }
  if (!pending.length) {
    box.innerHTML = '<p class="p-empty">Nothing to approve. Purchases that need you will appear here instantly.</p>';
    return;
  }
  box.querySelector(".p-empty")?.remove();
  for (const t of pending) {
    if (rendered.has(t.id)) continue;
    rendered.add(t.id);
    const card = document.createElement("article");
    card.className = "p-card";
    card.dataset.id = t.id;
    card.innerHTML = `
      <div class="p-card-head"><strong>${esc(t.merchant)}</strong><span class="amt">${usd(t.amount)}</span></div>
      ${t.rationale ? `<p class="rationale">“${esc(t.rationale)}”</p>` : ""}
      <ul class="lines">${t.items.map((i) => `<li><span>${i.qty} × ${esc(i.name)}</span><span>${usd(i.price * i.qty)}</span></li>`).join("")}</ul>
      <ul class="checks">${t.checks.filter((c) => c.outcome !== "pass").map((c) => `<li class="${c.outcome}"><span><b>${esc(c.rule)}</b> — ${esc(c.detail)}</span></li>`).join("")}</ul>
      <div class="p-approve"></div>
      <button class="btn ghost full p-decline" type="button">Decline</button>`;
    box.prepend(card);
    renderApprove(card.querySelector(".p-approve"), t, config, {
      onDone: (out) => {
        toast(`✅ Approved ${usd(t.amount)} at ${t.merchant}${out.mandate?.active && !snapshot.mandate?.active ? " — agent mandate granted" : ""}`, "good");
        refresh();
      },
      onError: (e) => toast(e.message, "bad"),
    });
    card.querySelector(".p-decline").onclick = async () => {
      try { await api(`/api/approvals/${t.id}/decline`, {}); toast(`Declined ${t.merchant}`); } catch (e) { toast(e.message, "bad"); }
      refresh();
    };
  }
}

function renderActivity() {
  const rows = snapshot.ledger.filter((t) => t.status !== "PENDING_APPROVAL").slice(0, 10);
  $("#p-activity").innerHTML = rows.length ? rows.map((t) => `
    <li>
      <div><strong>${esc(t.merchant)}</strong><span>${esc(t.items.map((i) => i.name).join(", "))}</span></div>
      <div class="right"><b>${usd(t.amount)}</b><span class="badge ${t.status}">${STATUS_LABEL[t.status] || t.status}${t.mode === "autonomous" && t.status === "PAID" ? " · auto" : ""}</span></div>
    </li>`).join("") : '<li class="p-empty">No activity yet.</li>';
}

async function revoke() {
  if (!confirm("Revoke the agent's PayPal access? It will need your approval for every purchase.")) return;
  try { await api("/api/mandate/revoke", {}); toast("Agent access revoked", "bad"); } catch (e) { toast(e.message, "bad"); }
  refresh();
}

async function ask(text) {
  text = String(text || "").trim();
  if (!text) return;
  const btn = $("#p-send");
  btn.disabled = true;
  $("#p-input").value = "";
  const reply = $("#p-reply");
  reply.hidden = false;
  reply.textContent = "Working on it…";
  let last = "";
  try {
    await apiStream("/api/agent", { message: text }, (ev) => {
      if (ev.type === "text") last = ev.text;
      if (ev.type === "error") last = `Error: ${ev.message}`;
    });
    reply.textContent = last || "Done.";
  } catch (e) {
    reply.textContent = e.message;
  }
  btn.disabled = false;
  refresh();
}
