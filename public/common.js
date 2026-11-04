// Shared by the desktop console (app.js) and the phone wallet (phone.js).
export const $ = (s, root = document) => root.querySelector(s);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const usd = (n) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const pretty = (c) => String(c).replace(/_/g, " ");

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// Identifies this tab so it can ignore toasts for actions it caused itself.
// Per tab and per page (sessionStorage is shared by same-origin iframes), so the
// console and phone wallet still notify each other even when embedded side by side.
export const CLIENT_ID = (() => {
  const key = `leash.client:${location.pathname}`;
  try {
    let id = sessionStorage.getItem(key);
    if (!id) { id = Math.random().toString(36).slice(2, 10); sessionStorage.setItem(key, id); }
    return id;
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
})();

let pin = store.get("leash.pin") || "";

function headers() {
  const h = { "Content-Type": "application/json", "x-leash-client": CLIENT_ID };
  if (pin) h["x-leash-pin"] = pin;
  return h;
}

async function askPin() {
  const v = window.prompt("This Leash server is protected. Enter the LAN PIN:");
  if (v == null) throw new Error("PIN required");
  pin = v.trim();
  store.set("leash.pin", pin);
}

/** fetch wrapper: JSON in/out, PIN retry, readable errors. */
export async function api(path, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(path, { method: body ? "POST" : "GET", headers: headers(), body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) {
      const j = await res.json().catch(() => ({}));
      if (j.pin) { await askPin(); continue; }
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  }
  throw new Error("Wrong PIN");
}

/** POST that streams server-sent events back (used for agent runs). */
export async function apiStream(path, body, onEvent) {
  const res = await fetch(path, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  if (res.status === 401) { await askPin(); return apiStream(path, body, onEvent); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (chunk.startsWith("data: ")) onEvent(JSON.parse(chunk.slice(6)));
    }
  }
}

/** Subscribe to live updates from every device; reconnects automatically. */
export function liveUpdates(onEvent, onStatus = () => {}) {
  let es;
  const open = () => {
    es = new EventSource(`/api/stream${pin ? `?pin=${encodeURIComponent(pin)}` : ""}`);
    es.onopen = () => onStatus(true);
    es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch { /* ignore */ } };
    es.onerror = () => { onStatus(false); es.close(); setTimeout(open, 3000); };
  };
  open();
}

export function toast(text, tone = "") {
  let box = $("#toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    document.body.appendChild(box);
  }
  const el = document.createElement("div");
  el.className = `toast ${tone}`;
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.classList.add("out"), 4200);
  setTimeout(() => el.remove(), 4700);
}

/** Human sentence for a broadcast "changed" event (for toasts on other devices). */
export function describeChange(ev) {
  const who = ev.merchant ? `${ev.merchant} · ${usd(ev.amount)}` : "";
  return {
    approval_needed: [`🙋 Approval needed: ${who}`, "warn"],
    approved: [`✅ Approved on another device: ${who}${ev.mandate_created ? " — agent mandate granted" : ""}`, "good"],
    declined: [`Declined on another device: ${who}`, ""],
    paid_autonomous: [`💸 Paid autonomously: ${who}`, "good"],
    blocked: [`🛑 Blocked by policy: ${who}`, "bad"],
    refunded: [`↩️ Refunded: ${who}`, ""],
    revoked: ["🔒 Agent mandate revoked", "bad"],
    policy: ["Spending policy updated", ""],
    reset: ["Demo was reset", ""],
    webhook: [`PayPal webhook: ${pretty(ev.event_type || "")} ${ev.note ? `(${ev.note})` : ""}`, ""],
  }[ev.reason] || null;
}

export const STATUS_LABEL = {
  PAID: "Paid", PENDING_APPROVAL: "Awaiting you", DENIED: "Blocked", DECLINED_BY_USER: "Declined",
  REFUNDED: "Refunded", DISPUTED: "Disputed",
};

let ppSdk;
/** Load the PayPal JS SDK once (sandbox mode only). */
export function loadPayPal(clientId) {
  ppSdk ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons`;
    s.onload = () => resolve(window.paypal);
    s.onerror = () => reject(new Error("Could not load the PayPal SDK (check the internet connection)."));
    document.head.appendChild(s);
  });
  return ppSdk;
}

/**
 * Render the approve control for one pending purchase: real PayPal Buttons in
 * sandbox mode, a simulated button otherwise. Resolves on success.
 */
export function renderApprove(container, txn, config, { onDone, onError }) {
  container.innerHTML = "";
  if (config.paypal === "sandbox") {
    loadPayPal(config.paypalClientId).then((paypal) => {
      paypal.Buttons({
        style: { layout: "vertical", shape: "rect", label: "pay", height: 44 },
        createOrder: async () => (await api(`/api/approvals/${txn.id}/order`, {})).id,
        onApprove: async () => {
          try { onDone(await api(`/api/approvals/${txn.id}/capture`, {})); } catch (e) { onError(e); }
        },
        onError: (err) => onError(new Error(String(err))),
      }).render(container);
    }).catch(onError);
    return;
  }
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn primary full";
  b.innerHTML = "Approve with PayPal <small>(simulated)</small>";
  b.onclick = async () => {
    b.disabled = true;
    try { onDone(await api(`/api/approvals/${txn.id}/capture`, {})); } catch (e) { onError(e); b.disabled = false; }
  };
  container.appendChild(b);
}
