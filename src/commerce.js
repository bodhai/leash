// Turns an agent's proposed cart into a policy decision and, when allowed, a
// real PayPal payment. Shared by the agent tools, the human-approval routes and
// the PayPal webhook. Every mutation persists and is broadcast via changed().
import { evaluate, DECISION } from "./policy.js";
import { state, spendSummary, newId } from "./store.js";
import { changed } from "./events.js";
import * as paypal from "./paypal.js";

const summary = (t) => ({ txn_id: t.id, merchant: t.merchant, amount: t.amount });

export async function proposePurchase({ items, rationale }, emit = () => {}, origin = null) {
  const spend = spendSummary();
  const result = evaluate({ items }, state.policy, spend);
  const txn = {
    id: newId("txn"),
    ts: Date.now(),
    merchant: result.merchant?.name ?? "—",
    merchant_id: result.merchant?.id,
    items: result.items,
    amount: result.amount,
    category: [...new Set(result.items.map((i) => i.category))].join(", "),
    rationale,
    decision: result.decision,
    checks: result.checks,
    mode: null,
    status: null,
    paypal_order_id: null,
    capture_id: null,
  };

  emit({ type: "policy", txn: { ...txn } });

  if (result.decision === DECISION.DENY) {
    txn.status = "DENIED";
    txn.mode = "blocked";
    state.ledger.unshift(txn);
    changed("blocked", summary(txn), origin);
    return {
      status: "DENIED",
      transaction_id: txn.id,
      reasons: result.checks.filter((c) => c.outcome === "fail").map((c) => c.detail),
      note: "The spending policy blocked this. Do not retry the same purchase; choose an alternative or tell the user.",
    };
  }

  const canAutopay = result.decision === DECISION.AUTO && state.mandate?.active;
  if (canAutopay) {
    try {
      const o = await paypal.chargeVault(txn, state.mandate.vault_id);
      Object.assign(txn, { status: "PAID", mode: "autonomous", paypal_order_id: o.id, capture_id: o.capture_id, paid_ts: Date.now() });
      state.ledger.unshift(txn);
      emit({ type: "payment", txn: { ...txn } });
      changed("paid_autonomous", summary(txn), origin);
      return { status: "PAID", transaction_id: txn.id, amount: txn.amount, paypal_order_id: o.id, merchant: txn.merchant };
    } catch (e) {
      emit({ type: "error", message: `Vault charge failed, falling back to human approval: ${e.message}` });
    }
  }

  // Escalate to the human: they approve in the PayPal popup (laptop or phone).
  txn.status = "PENDING_APPROVAL";
  txn.mode = "human";
  if (result.decision === DECISION.AUTO) {
    txn.checks.push({ rule: "Agent mandate", outcome: "warn",
      detail: "No active PayPal mandate yet. Approving this purchase also authorizes the agent for future in-policy buys." });
  }
  state.ledger.unshift(txn);
  state.approvals[txn.id] = txn;
  emit({ type: "approval_needed", txn: { ...txn } });
  changed("approval_needed", summary(txn), origin);
  return {
    status: "AWAITING_HUMAN_APPROVAL",
    transaction_id: txn.id,
    amount: txn.amount,
    reasons: txn.checks.filter((c) => c.outcome === "warn").map((c) => c.detail),
    note: "The user has been asked to approve this in PayPal. Continue with other tasks; do not re-submit.",
  };
}

function pendingTxn(txnId) {
  const txn = state.approvals[txnId];
  if (!txn || txn.status !== "PENDING_APPROVAL") throw new Error("This purchase is no longer waiting for approval (it may have been handled on another device).");
  return txn;
}

export async function createApprovalOrder(txnId) {
  const txn = pendingTxn(txnId);
  const o = await paypal.createApprovalOrder(txn, { vault: !state.mandate?.active });
  txn.paypal_order_id = o.id;
  return o;
}

export async function captureApproval(txnId, origin = null) {
  const txn = pendingTxn(txnId);
  if (!txn.paypal_order_id) await createApprovalOrder(txnId);
  const r = await paypal.captureOrder(txn.paypal_order_id);
  Object.assign(txn, { status: r.status === "COMPLETED" ? "PAID" : r.status, capture_id: r.capture_id, paid_ts: Date.now() });
  delete state.approvals[txnId];
  let mandateCreated = false;
  if (r.vault_id && !state.mandate?.active) {
    state.mandate = { active: true, vault_id: r.vault_id, payer: r.payer, created: Date.now(), simulated: !!r.simulated };
    mandateCreated = true;
  }
  changed("approved", { ...summary(txn), mandate_created: mandateCreated }, origin);
  return { txn: { ...txn }, mandate: state.mandate };
}

export function declineApproval(txnId, origin = null) {
  const txn = pendingTxn(txnId);
  txn.status = "DECLINED_BY_USER";
  delete state.approvals[txnId];
  changed("declined", summary(txn), origin);
  return { ...txn };
}

export async function refund(txnId, origin = null) {
  const txn = state.ledger.find((t) => t.id === txnId);
  if (!txn || txn.status !== "PAID" || !txn.capture_id) throw new Error("Only paid transactions can be refunded");
  const r = await paypal.refundCapture(txn.capture_id);
  txn.status = "REFUNDED";
  txn.refund_id = r.id;
  changed("refunded", summary(txn), origin);
  return { ...txn };
}

export async function revokeMandate(origin = null) {
  if (!state.mandate?.active) return { revoked: false };
  await paypal.revokeVault(state.mandate.vault_id);
  state.mandate = { ...state.mandate, active: false, revoked: Date.now() };
  changed("revoked", {}, origin);
  return { revoked: true };
}

/**
 * Apply a verified PayPal webhook to the ledger, so refunds and disputes made
 * outside Leash (e.g. in the PayPal dashboard) are reflected here.
 */
export function applyWebhook(event) {
  const r = event.resource || {};
  const byCapture = (id) => state.ledger.find((t) => t.capture_id && t.capture_id === id);
  const byCustom = (id) => state.ledger.find((t) => t.id === id);
  let txn = null;
  let note = "ignored";
  switch (event.event_type) {
    case "PAYMENT.CAPTURE.COMPLETED":
      txn = byCustom(r.custom_id) || byCapture(r.id);
      if (txn) { txn.capture_id ||= r.id; note = "capture confirmed"; }
      break;
    case "PAYMENT.CAPTURE.REFUNDED":
    case "PAYMENT.CAPTURE.REVERSED": {
      const capId = r.links?.find((l) => l.rel === "up")?.href?.split("/").pop() || r.id;
      txn = byCustom(r.custom_id) || byCapture(capId);
      if (txn) { txn.status = "REFUNDED"; note = "refund recorded"; }
      break;
    }
    case "CUSTOMER.DISPUTE.CREATED": {
      const capId = r.disputed_transactions?.[0]?.seller_transaction_id;
      txn = byCapture(capId);
      if (txn) { txn.status = "DISPUTED"; note = "dispute opened"; }
      break;
    }
  }
  state.webhooks.unshift({ id: event.id, type: event.event_type, ts: Date.now(), txn_id: txn?.id ?? null, note });
  state.webhooks.length = Math.min(state.webhooks.length, 50);
  changed("webhook", { event_type: event.event_type, note, ...(txn ? summary(txn) : {}) });
  return { received: true, matched: Boolean(txn), note };
}
