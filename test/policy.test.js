import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, compilePolicyOffline, DECISION } from "../src/policy.js";
import { DEFAULT_POLICY, DEFAULT_POLICY_TEXT } from "../src/store.js";

const spend = (o = {}) => ({ month_spent: 0, month_remaining: 300, by_category: {}, known_merchants: ["freshcart"], purchases_last_hour: 0, ...o });
const cart = (...items) => ({ items: items.map(([product_id, qty = 1]) => ({ product_id, qty })) });

test("small purchase from a known merchant is auto-approved", () => {
  const r = evaluate(cart(["fc-001"], ["fc-002"]), DEFAULT_POLICY, spend());
  assert.equal(r.decision, DECISION.AUTO);
  assert.equal(r.amount, 6.78);
});

test("new merchant escalates to a human", () => {
  const r = evaluate(cart(["ph-002"]), DEFAULT_POLICY, spend());
  assert.equal(r.decision, DECISION.HUMAN);
});

test("blocked category is denied", () => {
  const r = evaluate(cart(["vc-001"]), DEFAULT_POLICY, spend({ known_merchants: ["vinecellar"] }));
  assert.equal(r.decision, DECISION.DENY);
});

test("prompt-injected low-trust merchant is denied even if the model is fooled", () => {
  const r = evaluate(cart(["md-002", 10]), DEFAULT_POLICY, spend());
  assert.equal(r.decision, DECISION.DENY);
  const failed = r.checks.filter((c) => c.outcome === "fail").map((c) => c.rule);
  for (const rule of ["Blocked category", "Merchant trust", "Per-purchase limit", "Monthly budget"]) assert.ok(failed.includes(rule), rule);
});

test("monthly budget counts what's already committed", () => {
  const r = evaluate(cart(["fc-005"]), DEFAULT_POLICY, spend({ month_remaining: 5 }));
  assert.equal(r.decision, DECISION.DENY);
});

test("category cap is enforced", () => {
  const r = evaluate(cart(["fc-013"]), DEFAULT_POLICY, spend({ by_category: { groceries: 190 } }));
  assert.equal(r.decision, DECISION.DENY);
});

test("multi-merchant cart is rejected", () => {
  const r = evaluate(cart(["fc-001"], ["hb-001"]), DEFAULT_POLICY, spend());
  assert.equal(r.decision, DECISION.DENY);
});

test("offline compiler reads the default policy text", () => {
  const p = compilePolicyOffline(DEFAULT_POLICY_TEXT, DEFAULT_POLICY);
  assert.equal(p.monthly_budget, 300);
  assert.equal(p.per_purchase_limit, 120);
  assert.equal(p.approval_threshold, 60);
  assert.equal(p.min_merchant_trust, 60);
  assert.equal(p.require_approval_new_merchant, true);
  assert.deepEqual(p.blocked_categories.sort(), ["alcohol", "gift_cards"]);
  assert.equal(p.category_limits.groceries, 200);
});
