// End-to-end purchase lifecycle against the simulated PayPal backend.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.LEASH_PERSIST = "0";
delete process.env.PAYPAL_CLIENT_ID;
const { state, resetState, stats } = await import("../src/store.js");
const commerce = await import("../src/commerce.js");
const { bus } = await import("../src/events.js");

const buy = (...items) => commerce.proposePurchase({ items: items.map(([product_id, qty = 1]) => ({ product_id, qty })), rationale: "test" });

beforeEach(() => resetState());

test("first purchase needs approval, approval grants the mandate, next in-policy buy is autonomous", async () => {
  const first = await buy(["hb-001"]);
  assert.equal(first.status, "AWAITING_HUMAN_APPROVAL");
  const { mandate } = await commerce.captureApproval(first.transaction_id);
  assert.equal(mandate.active, true);

  const second = await buy(["hb-002"]);
  assert.equal(second.status, "PAID");
  assert.equal(state.ledger[0].mode, "autonomous");

  const s = stats();
  assert.equal(s.autonomous.count, 1);
  assert.equal(s.human.count, 1);
});

test("revoking the mandate sends purchases back to human approval", async () => {
  const first = await buy(["hb-001"]);
  await commerce.captureApproval(first.transaction_id);
  await commerce.revokeMandate();
  const next = await buy(["hb-002"]);
  assert.equal(next.status, "AWAITING_HUMAN_APPROVAL");
});

test("an approval can only be handled once (e.g. phone and laptop racing)", async () => {
  const p = await buy(["hb-001"]);
  await commerce.captureApproval(p.transaction_id);
  await assert.rejects(() => commerce.captureApproval(p.transaction_id), /no longer waiting/);
  await assert.rejects(() => Promise.resolve().then(() => commerce.declineApproval(p.transaction_id)), /no longer waiting/);
});

test("blocked attempts count as money protected", async () => {
  await buy(["md-002", 10]);
  const s = stats();
  assert.equal(s.blocked.count, 1);
  assert.equal(s.protected_amount, 1000);
  assert.equal(s.injections_blocked, 0); // gift card listing itself is clean; the bundle carries the payload
  await buy(["md-001"]);
  assert.equal(stats().injections_blocked, 1);
});

test("refund webhook from PayPal marks the transaction refunded", async () => {
  const p = await buy(["hb-001"]);
  await commerce.captureApproval(p.transaction_id);
  const txn = state.ledger[0];
  const out = commerce.applyWebhook({
    id: "WH-1", event_type: "PAYMENT.CAPTURE.REFUNDED",
    resource: { id: "REF-1", links: [{ rel: "up", href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${txn.capture_id}` }] },
  });
  assert.equal(out.matched, true);
  assert.equal(txn.status, "REFUNDED");
});

test("state changes are broadcast to connected screens", async () => {
  const seen = [];
  const on = (ev) => seen.push(ev.reason);
  bus.on("event", on);
  const p = await buy(["hb-001"]);
  commerce.declineApproval(p.transaction_id);
  bus.off("event", on);
  assert.deepEqual(seen, ["approval_needed", "declined"]);
});
