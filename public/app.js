import { $, esc, usd, pretty, api, apiStream, liveUpdates, toast, describeChange, renderApprove, CLIENT_ID, STATUS_LABEL } from "./common.js";

let config = {};
let snapshot = { ledger: [] };
let grid;
let busy = false;
const approvalQueue = [];

const POLICY_TEMPLATES = {
  family:
    "Monthly budget $300. Never spend more than $120 in one purchase. Ask me before anything over $60 or from a merchant we haven't used before. " +
    "Groceries up to $200 a month. No alcohol, no gift cards. Only buy from merchants with a trust score of at least 60.",
  strict:
    "Monthly budget $150. Never spend more than $40 in one purchase. Ask me before anything over $20 or from a merchant we haven't used before. " +
    "Groceries up to $100 a month. No alcohol, no gift cards, no electronics. Only buy from merchants with a trust score of at least 80.",
  business:
    "Monthly budget $1,000. Never spend more than $300 in one purchase. Ask me before anything over $150 or from a merchant we haven't used before. " +
    "Household up to $400 a month. No alcohol, no gift cards. Only buy from merchants with a trust score of at least 70.",
};

// ---------------------------------------------------------------- boot
init().catch((e) => sysMsg(`Could not start: ${e.message}`, "bad"));

async function init() {
  config = await api("/api/config");
  $("#ai-pill").textContent = config.ai ? `AI: ${config.ai}` : "AI: offline planner";
  $("#ai-pill").classList.toggle("on", !!config.ai);
  $("#pp-pill").textContent = config.paypal === "sandbox" ? "PayPal: sandbox" : "PayPal: simulated";
  $("#pp-pill").classList.toggle("on", config.paypal === "sandbox");
  $("#foot-urls").textContent = config.lanUrls.length ? `LAN: ${config.lanUrls.join("  ·  ")}` : "Not on a LAN";
  setupGrid();
  await refresh();
  $("#policy-text").value = snapshot.policyText;
  bind();
  liveUpdates(onLive, (ok) => $("#live-pill").classList.toggle("off", !ok));
}

async function refresh() {
  snapshot = await api("/api/state");
  renderRules(snapshot.policy);
  renderWallet();
  renderMandate();
  renderKpis();
  grid.setGridOption("rowData", snapshot.ledger);
  $("#redteam").checked = snapshot.redteam;
  // An approval handled on another device closes the dialog here.
  const open = $("#approval");
  if (open.open && open.dataset.txn && !snapshot.ledger.some((t) => t.id === open.dataset.txn && t.status === "PENDING_APPROVAL")) {
    open.close();
    if (!busy) nextApproval();
  }
}

let refreshTimer;
const softRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 120); };

function onLive(ev) {
  if (ev.type === "changed") {
    softRefresh();
    if (ev.origin !== CLIENT_ID) {
      const d = describeChange(ev);
      if (d) toast(...d);
      if (ev.reason === "approved") sysMsg(`✅ ${ev.merchant} · ${usd(ev.amount)} approved on another device${ev.mandate_created ? " — agent mandate granted" : ""}.`, "good");
    }
  } else if (ev.type === "agent" && ev.origin !== CLIENT_ID && ev.running) {
    toast(`🤖 Agent started on another device: “${ev.message}”`);
  }
}

function bind() {
  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); send($("#input").value); });
  $("#suggestions").addEventListener("click", (e) => { if (e.target.tagName === "BUTTON") send(e.target.textContent); });
  $("#templates").addEventListener("click", (e) => {
    const t = e.target.closest("button")?.dataset.t;
    if (!t) return;
    $("#policy-text").value = POLICY_TEMPLATES[t];
    compile();
  });
  $("#compile-btn").addEventListener("click", compile);
  $("#revoke-btn").addEventListener("click", revoke);
  $("#reset-btn").addEventListener("click", async () => {
    if (!confirm("Reset the demo? This clears the ledger, mandate and policy.")) return;
    try { await api("/api/reset", {}); location.reload(); } catch (e) { toast(e.message, "bad"); }
  });
  $("#redteam").addEventListener("change", (e) => setRedteam(e.target.checked));
  $("#export-btn").addEventListener("click", () => grid.exportDataAsCsv({ fileName: `leash-ledger-${new Date().toISOString().slice(0, 10)}.csv` }));
  $("#phone-btn").addEventListener("click", openPhone);
  $("#tour-btn").addEventListener("click", startTour);
  $("#tour-next").addEventListener("click", tourNext);
  $("#tour-exit").addEventListener("click", endTour);
}

async function setRedteam(on) {
  await api("/api/redteam", { enabled: on });
  $("#redteam").checked = on;
  sysMsg(on ? "Red-team mode on: a simulated compromised agent now shops, obeying any instructions it finds in listings. The policy engine is the only safeguard."
    : "Red-team mode off: suspicious listings are sanitized before the model sees them.", on ? "bad" : "");
}

// ---------------------------------------------------------------- KPIs
function renderKpis() {
  const s = snapshot.stats;
  $("#k-auto").textContent = usd(s.autonomous.amount);
  $("#k-auto-n").textContent = `${s.autonomous.count} purchase${s.autonomous.count === 1 ? "" : "s"} · no human needed`;
  $("#k-human").textContent = usd(s.human.amount);
  $("#k-human-n").textContent = `${s.human.count} purchase${s.human.count === 1 ? "" : "s"} you approved`;
  $("#k-pending").textContent = String(s.pending.count);
  $("#k-pending-n").textContent = `${usd(s.pending.amount)} held against budget`;
  $("#k-protected").textContent = usd(s.protected_amount);
  $("#k-protected-n").textContent = `${s.blocked.count} blocked · ${s.injections_blocked} injection${s.injections_blocked === 1 ? "" : "s"} stopped`;
}

// ---------------------------------------------------------------- policy
const RULE_LABELS = [
  ["monthly_budget", "Monthly budget", usd],
  ["per_purchase_limit", "Per-purchase cap", usd],
  ["approval_threshold", "Ask me above", usd],
  ["min_merchant_trust", "Min merchant trust", (v) => `${v}/100`],
  ["require_approval_new_merchant", "New merchants", (v) => (v ? "ask me" : "allowed")],
  ["max_quantity_per_item", "Max qty per item", (v) => v],
  ["velocity_limit_per_hour", "Purchases / hour", (v) => `≤ ${v}`],
];

function renderRules(p, flash = false) {
  const f = flash ? "flash" : "";
  const items = RULE_LABELS.map(([k, label, fmt]) => `<li class="${f}"><span>${label}</span><strong>${esc(fmt(p[k]))}</strong></li>`);
  for (const [c, v] of Object.entries(p.category_limits || {})) items.push(`<li class="${f}"><span>${esc(pretty(c))} / month</span><strong>${usd(v)}</strong></li>`);
  if (p.blocked_categories?.length) items.push(`<li class="block ${f}"><span>Blocked</span><strong>${p.blocked_categories.map(pretty).map(esc).join(", ")}</strong></li>`);
  if (p.blocked_merchants?.length) items.push(`<li class="block ${f}"><span>Blocked merchants</span><strong>${p.blocked_merchants.map(esc).join(", ")}</strong></li>`);
  $("#rules").innerHTML = items.join("");
}

async function compile() {
  const btn = $("#compile-btn");
  btn.disabled = true;
  btn.textContent = config.ai ? "Compiling with Claude…" : "Compiling…";
  try {
    const out = await api("/api/policy", { text: $("#policy-text").value });
    $("#policy-explain").textContent = out.explanation;
    await refresh();
    renderRules(snapshot.policy, true);
    sysMsg("Spending policy updated — the agent is bound by the new rules immediately.", "good");
  } catch (e) { sysMsg(`Policy error: ${e.message}`, "bad"); }
  btn.disabled = false;
  btn.textContent = "Compile rules";
}

// ---------------------------------------------------------------- wallet + mandate
function renderWallet() {
  const { spend, policy } = snapshot;
  const pct = Math.min(100, (spend.month_spent / policy.monthly_budget) * 100);
  $("#spent-label").textContent = `${usd(spend.month_spent)} committed`;
  $("#left-label").textContent = `${usd(Math.max(0, spend.month_remaining))} of ${usd(policy.monthly_budget)} left`;
  const fill = $("#budget-fill");
  fill.style.width = `${pct}%`;
  fill.className = `fill ${pct > 90 ? "over" : pct > 70 ? "hot" : ""}`;
  const cats = new Set([...Object.keys(policy.category_limits || {}), ...Object.keys(spend.by_category)]);
  $("#cat-meters").innerHTML = [...cats].map((c) => {
    const used = spend.by_category[c] || 0;
    const cap = policy.category_limits?.[c];
    const w = Math.min(100, (used / (cap || policy.monthly_budget)) * 100);
    return `<div><div class="meter-label"><span>${esc(pretty(c))}</span><span>${usd(used)}${cap ? ` / ${usd(cap)}` : ""}</span></div>
      <div class="meter"><div class="fill ${w > 90 ? "over" : w > 70 ? "hot" : ""}" style="width:${w}%"></div></div></div>`;
  }).join("");
}

function renderMandate() {
  const m = snapshot.mandate;
  const pill = $("#mandate-pill");
  pill.classList.remove("on", "off");
  if (m?.active) {
    pill.textContent = `Mandate: active${m.simulated ? " (sim)" : ""}`;
    pill.title = `Vaulted PayPal ${m.payer || ""} · token ${m.vault_id}`;
    pill.classList.add("on");
  } else if (m && !m.active) {
    pill.textContent = "Mandate: revoked";
    pill.classList.add("off");
  } else {
    pill.textContent = "Mandate: none yet";
    pill.title = "Approve the agent's first purchase in PayPal to grant it a policy-bound mandate.";
  }
  $("#revoke-btn").hidden = !m?.active;
}

async function revoke() {
  try {
    await api("/api/mandate/revoke", {});
    await refresh();
    sysMsg("Agent mandate revoked. The PayPal vault token is deleted — the agent can no longer pay without you.", "bad");
  } catch (e) { toast(e.message, "bad"); }
}

// ---------------------------------------------------------------- chat + agent stream
function addMsg(cls, text) {
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.textContent = text;
  $("#messages").appendChild(el);
  $("#messages").scrollTop = 1e9;
  return el;
}
const sysMsg = (t, tone = "") => addMsg(`system ${tone}`, t);

async function send(text) {
  text = String(text || "").trim();
  if (!text || busy) return;
  setBusy(true);
  $("#input").value = "";
  addMsg("user", text);
  const typing = addMsg("agent typing", "Working on it…");
  trace("divider", "New task", `<b>${esc(text)}</b>`);
  try {
    await apiStream("/api/agent", { message: text }, (ev) => onEvent(ev, typing));
  } catch (e) {
    sysMsg(`Error: ${e.message}`, "bad");
  }
  typing.remove();
  setBusy(false);
  await refresh();
  nextApproval();
}

function setBusy(on) {
  busy = on;
  $("#send-btn").disabled = on;
  $("#tour-next").disabled = on;
  document.body.classList.toggle("busy", on);
}

function onEvent(ev, typing) {
  switch (ev.type) {
    case "status": typing.textContent = ev.text; break;
    case "thinking": trace("thinking", "Reasoning", esc(ev.text)); break;
    case "text": addMsg("agent", ev.text); $("#messages").appendChild(typing); break;
    case "tool_call":
      typing.textContent = { search_products: "Searching merchants…", propose_purchase: "Submitting purchase to policy engine…", get_wallet_status: "Checking wallet…" }[ev.name] || "Working…";
      trace("tool", `Tool · ${ev.name}`, `<code>${esc(JSON.stringify(ev.input))}</code>`);
      break;
    case "tool_result": trace("result", "Result", esc(ev.summary)); break;
    case "injection":
      trace("injection", "⚠ Prompt injection detected",
        `${esc(ev.merchant)} listing “${esc(ev.product)}” contains instructions aimed at AI agents. ${ev.sanitized ? "Withheld from the model." : "<b>Red-team mode: passed to the model unfiltered.</b>"}<div class="excerpt">${esc(ev.excerpt)}…</div>`);
      break;
    case "policy": policyEvent(ev.txn); break;
    case "payment":
      trace("payment", "Paid via PayPal mandate", `${usd(ev.txn.amount)} to ${esc(ev.txn.merchant)} · order <span class="mono">${esc(ev.txn.paypal_order_id)}</span> — no human needed`);
      sysMsg(`💸 Paid ${usd(ev.txn.amount)} to ${ev.txn.merchant} autonomously (within policy).`, "good");
      break;
    case "approval_needed": approvalQueue.push(ev.txn); break;
    case "error": trace("error", "Error", esc(ev.message)); break;
  }
}

function policyEvent(t) {
  const label = { AUTO_APPROVE: "Allowed", NEEDS_APPROVAL: "Needs your OK", DENY: "Blocked" }[t.decision];
  trace(`policy ${t.decision}`, "",
    `<div class="head"><strong>Policy check · ${esc(t.merchant)} · ${usd(t.amount)}</strong><span class="badge ${t.decision}">${label}</span></div>
     <ul class="checks">${t.checks.map((c) => `<li class="${c.outcome}"><span><b>${esc(c.rule)}</b> — ${esc(c.detail)}</span></li>`).join("")}</ul>`);
  if (t.decision === "DENY") sysMsg(`🛑 Blocked ${usd(t.amount)} at ${t.merchant}: ${t.checks.find((c) => c.outcome === "fail").detail}`, "bad");
}

function trace(cls, label, html) {
  const list = $("#trace");
  list.querySelector(".trace-empty")?.remove();
  const li = document.createElement("li");
  li.className = `ev ${cls}`;
  li.innerHTML = `${label ? `<span class="label">${label}</span>` : ""}${html}`;
  list.appendChild(li);
  list.scrollTop = 1e9;
}

// ---------------------------------------------------------------- approvals
function nextApproval() {
  if ($("#approval").open) return;
  // Skip anything already handled (from the ledger, or on another device).
  const pending = new Set(snapshot.ledger.filter((x) => x.status === "PENDING_APPROVAL").map((x) => x.id));
  let t;
  while ((t = approvalQueue.shift()) && !pending.has(t.id));
  if (t) openApproval(t);
}

function openApproval(t) {
  const dlg = $("#approval");
  dlg.dataset.txn = t.id;
  $("#ap-title").textContent = `${t.merchant} · ${usd(t.amount)}`;
  $("#ap-rationale").textContent = t.rationale ? `Agent: “${t.rationale}”` : "";
  $("#ap-items").innerHTML = t.items.map((i) => `<li><span>${i.qty} × ${esc(i.name)}</span><span>${usd(i.price * i.qty)}</span></li>`).join("");
  $("#ap-total").textContent = usd(t.amount);
  $("#ap-checks").innerHTML = t.checks.filter((c) => c.outcome !== "pass").map((c) => `<li class="${c.outcome}"><span><b>${esc(c.rule)}</b> — ${esc(c.detail)}</span></li>`).join("");
  $("#ap-fine").textContent = !snapshot.mandate?.active
    ? "Approving saves your PayPal for this agent (PayPal Vault). Future purchases that pass every rule will pay automatically — you can revoke any time."
    : "Your PayPal mandate is active; this one needed you because it tripped a rule.";
  renderApprove($("#ap-approve"), t, config, {
    onDone: (out) => finishApproval(t, out),
    onError: (e) => sysMsg(`Payment failed: ${e.message}`, "bad"),
  });
  $("#ap-decline").onclick = async () => {
    try { await api(`/api/approvals/${t.id}/decline`, {}); sysMsg(`Declined ${usd(t.amount)} at ${t.merchant}.`); }
    catch (e) { toast(e.message, "bad"); }
    dlg.close();
    await refresh();
    nextApproval();
  };
  dlg.showModal();
}

async function finishApproval(t, out) {
  const hadMandate = snapshot.mandate?.active;
  $("#approval").close();
  sysMsg(`✅ You approved ${usd(t.amount)} at ${t.merchant} — captured via PayPal.`, "good");
  if (!hadMandate && out.mandate?.active) sysMsg("🔐 Agent mandate granted: in-policy purchases will now pay automatically through your vaulted PayPal.", "good");
  trace("payment", "Human-approved payment", `${usd(t.amount)} to ${esc(t.merchant)} · capture <span class="mono">${esc(out.txn.capture_id || "")}</span>`);
  await refresh();
  nextApproval();
}

// ---------------------------------------------------------------- phone pairing
async function openPhone() {
  const base = config.lanUrls[0] || location.origin;
  const url = `${base}/phone.html`;
  $("#qr").src = `/api/qr?text=${encodeURIComponent(url)}`;
  $("#phone-url").textContent = url;
  $("#phone-fine").textContent = config.lanUrls.length
    ? "If the phone can't connect, allow Node.js through Windows Firewall on Private networks (see the guide)."
    : "No LAN address found — connect this PC to Wi-Fi or Ethernet first.";
  $("#phone").showModal();
}

// ---------------------------------------------------------------- guided demo tour
const SUGGEST = () => [...document.querySelectorAll("#suggestions button")].map((b) => b.textContent);
const TOUR = [
  { text: "Meet <b>Leash</b>. On the left are spending rules written in plain English; on the right, everything the agent thinks and does. The KPIs above count what the leash did. Click <b>Next</b> to give the agent a real task." },
  { text: "The agent plans a birthday party across several merchants. Watch the trace: it spots a listing that tries to hijack AI agents, and every cart goes through the policy engine.", run: () => send(SUGGEST()[0]) },
  { text: "Two orders need you — there's no mandate yet, and PartyHaus is a new merchant. Approve them here, or tap <b>📱 Phone</b> and approve on your phone. The first approval saves your PayPal (Vault) as the agent's mandate.", run: () => nextApproval() },
  { text: "A routine restock: known merchant, under the $60 threshold, within budget — so it's <b>paid autonomously</b> through the vaulted PayPal. No popup.", run: () => send(SUGGEST()[1]) },
  { text: "Something against the rules: alcohol is <b>blocked</b> before any money moves, and the agent explains why.", run: () => send(SUGGEST()[2]) },
  { text: "<b>Red-team:</b> a simulated compromised agent obeys the hidden instructions and tries to buy $1,000 of gift cards — and the policy engine still blocks it on five rules.", run: async () => { await setRedteam(true); await send(SUGGEST()[3]); } },
  { text: "That's Leash. Click any ledger row for the rule-by-rule audit, refund with one click, export the ledger, or <b>Revoke agent</b> to delete the vault token instantly.", run: () => setRedteam(false) },
];
let tourAt = -1;

function startTour() {
  tourAt = -1;
  $("#tour").hidden = false;
  tourNext();
}

async function tourNext() {
  if (busy) return;
  tourAt++;
  if (tourAt >= TOUR.length) return endTour();
  const step = TOUR[tourAt];
  $("#tour-step").textContent = `Step ${tourAt + 1} of ${TOUR.length}`;
  $("#tour-text").innerHTML = step.text;
  $("#tour-next").textContent = tourAt === TOUR.length - 1 ? "Finish ✓" : "Next ▶";
  if (step.run) await step.run();
}

function endTour() {
  $("#tour").hidden = true;
  tourAt = -1;
}

// ---------------------------------------------------------------- ledger (AG Grid)
function setupGrid() {
  const modeLabel = { autonomous: "🤖 Autonomous", human: "🙋 Human-approved", blocked: "🛑 Policy" };
  grid = agGrid.createGrid($("#grid"), {
    theme: agGrid.themeQuartz.withParams({ fontFamily: "Inter, system-ui, sans-serif", headerFontWeight: 600, accentColor: "#12b48c", borderRadius: 8, wrapperBorderRadius: 10 }),
    rowData: [],
    getRowId: (p) => p.data.id,
    animateRows: true,
    pagination: true,
    paginationPageSize: 20,
    paginationPageSizeSelector: false,
    defaultColDef: { sortable: true, filter: true, resizable: true },
    overlayNoRowsTemplate: '<span style="color:#8593a8">No transactions yet — every agent purchase attempt lands here.</span>',
    columnDefs: [
      { field: "ts", headerName: "Time", width: 125, sort: "desc", filter: false,
        valueFormatter: (p) => new Date(p.value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) },
      { field: "merchant", width: 170 },
      { headerName: "Items", colId: "items", flex: 2, minWidth: 220, valueGetter: (p) => p.data.items.map((i) => `${i.qty}× ${i.name}`).join(", "), tooltipValueGetter: (p) => p.value },
      { field: "category", width: 150 },
      { field: "amount", width: 110, type: "numericColumn", valueFormatter: (p) => usd(p.value), filter: "agNumberColumnFilter" },
      { field: "status", width: 140, valueFormatter: (p) => STATUS_LABEL[p.value] || p.value,
        cellRenderer: (p) => `<span class="badge ${p.data.status}">${STATUS_LABEL[p.data.status] || p.data.status}</span>` },
      { field: "mode", headerName: "Decided by", width: 165, valueFormatter: (p) => modeLabel[p.value] || p.value },
      { headerName: "Why", colId: "why", flex: 1, minWidth: 200, tooltipValueGetter: (p) => p.value,
        valueGetter: (p) => (p.data.checks.find((c) => c.outcome === "fail") || p.data.checks.find((c) => c.outcome === "warn") || { detail: "All rules passed" }).detail },
      { field: "paypal_order_id", headerName: "PayPal order", width: 170, cellClass: "mono" },
      { headerName: "", colId: "actions", width: 110, sortable: false, filter: false, pinned: "right",
        cellRenderer: (p) => p.data.status === "PAID" ? '<button class="act" data-act="refund">Refund</button>'
          : p.data.status === "PENDING_APPROVAL" ? '<button class="act go" data-act="approve">Review</button>' : "" },
    ],
    defaultCsvExportParams: { columnKeys: ["ts", "merchant", "items", "category", "amount", "status", "mode", "why", "paypal_order_id"],
      processCellCallback: (p) => p.column.getColId() === "ts" ? new Date(p.value).toISOString() : p.value },
    onCellClicked: async (e) => {
      const act = e.event.target?.dataset?.act;
      if (act === "refund") {
        try { await api(`/api/ledger/${e.data.id}/refund`, {}); sysMsg(`↩️ Refunded ${usd(e.data.amount)} from ${e.data.merchant} via PayPal.`); }
        catch (err) { sysMsg(`Refund failed: ${err.message}`, "bad"); }
        await refresh();
      } else if (act === "approve") {
        openApproval(e.data);
      } else {
        openAudit(e.data);
      }
    },
  });
}

function openAudit(t) {
  const b = $("#au-badge");
  b.className = `badge ${t.status}`;
  b.textContent = STATUS_LABEL[t.status] || t.status;
  $("#au-title").textContent = `${t.merchant} · ${usd(t.amount)}`;
  $("#au-rationale").textContent = t.rationale ? `Agent: “${t.rationale}”` : "";
  $("#au-items").innerHTML = t.items.map((i) => `<li><span>${i.qty} × ${esc(i.name)}</span><span>${usd(i.price * i.qty)}</span></li>`).join("");
  $("#au-checks").innerHTML = t.checks.map((c) => `<li class="${c.outcome}"><span><b>${esc(c.rule)}</b> — ${esc(c.detail)}</span></li>`).join("");
  $("#au-meta").innerHTML = [["Transaction", t.id], ["PayPal order", t.paypal_order_id], ["Capture", t.capture_id], ["Refund", t.refund_id],
    ["Decision", t.decision], ["Time", new Date(t.ts).toLocaleString()]]
    .filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
  $("#audit").showModal();
}
