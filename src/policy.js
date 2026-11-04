// The leash. A deterministic policy engine that sits between the AI agent and
// PayPal. The model can propose anything; only this code decides what gets paid.
import { MERCHANTS, getProduct, scanForInjection } from "./catalog.js";
import { round } from "./store.js";

export const DECISION = { AUTO: "AUTO_APPROVE", HUMAN: "NEEDS_APPROVAL", DENY: "DENY" };

/**
 * @param {{merchant_id:string, items:{product_id:string, qty:number}[]}} cart
 * @param {object} policy compiled policy
 * @param {object} spend from spendSummary()
 * @returns {{decision:string, amount:number, items:object[], checks:{rule:string, outcome:"pass"|"warn"|"fail", detail:string}[]}}
 */
export function evaluate(cart, policy, spend) {
  const checks = [];
  const add = (rule, outcome, detail) => checks.push({ rule, outcome, detail });

  const items = [];
  for (const line of cart.items) {
    const p = getProduct(line.product_id);
    if (!p) { add("Product exists", "fail", `Unknown product ${line.product_id}`); continue; }
    items.push({ product_id: p.id, name: p.name, price: p.price, qty: line.qty, category: p.category, merchant_id: p.merchant });
  }
  const merchantIds = [...new Set(items.map((i) => i.merchant_id))];
  const merchant = MERCHANTS[merchantIds[0]];
  const amount = round(items.reduce((s, i) => s + i.price * i.qty, 0));

  if (merchantIds.length > 1) add("One merchant per order", "fail", "A PayPal order must settle to a single merchant.");
  if (!items.length) add("Cart not empty", "fail", "No valid items.");

  // Hard limits — any failure is a DENY.
  for (const c of new Set(items.map((i) => i.category))) {
    if (policy.blocked_categories.includes(c)) add("Blocked category", "fail", `"${c}" is blocked by your policy.`);
  }
  if (merchant) {
    if (policy.blocked_merchants.includes(merchant.id)) add("Blocked merchant", "fail", `${merchant.name} is on your blocklist.`);
    if (merchant.trust < policy.min_merchant_trust)
      add("Merchant trust", "fail", `${merchant.name} trust score ${merchant.trust} < required ${policy.min_merchant_trust}.`);
    else add("Merchant trust", "pass", `${merchant.name} trust score ${merchant.trust}.`);
    const listingHits = items.map((i) => scanForInjection(getProduct(i.product_id).description)).filter((s) => s.suspicious);
    if (listingHits.length) add("Listing integrity", "fail", "Listing contains instructions aimed at AI agents (prompt injection).");
  }
  if (amount > policy.per_purchase_limit)
    add("Per-purchase limit", "fail", `$${amount} exceeds the $${policy.per_purchase_limit} per-purchase cap.`);
  else add("Per-purchase limit", "pass", `$${amount} ≤ $${policy.per_purchase_limit}.`);

  if (amount > spend.month_remaining)
    add("Monthly budget", "fail", `$${amount} exceeds the $${spend.month_remaining} left this month.`);
  else add("Monthly budget", "pass", `$${round(spend.month_remaining - amount)} will remain of $${policy.monthly_budget}.`);

  const catTotals = {};
  for (const i of items) catTotals[i.category] = (catTotals[i.category] || 0) + i.price * i.qty;
  for (const [c, v] of Object.entries(catTotals)) {
    const cap = policy.category_limits?.[c];
    if (cap == null) continue;
    const used = spend.by_category[c] || 0;
    if (used + v > cap) add(`Category cap: ${c}`, "fail", `$${round(used + v)} would exceed the $${cap} ${c} cap.`);
    else add(`Category cap: ${c}`, "pass", `$${round(cap - used - v)} left in ${c}.`);
  }

  // Soft limits — escalate to a human.
  const bigQty = items.filter((i) => i.qty > policy.max_quantity_per_item);
  if (bigQty.length) add("Quantity sanity", "warn", `Unusual quantity: ${bigQty.map((i) => `${i.qty}× ${i.name}`).join(", ")}.`);
  if (amount > policy.approval_threshold)
    add("Approval threshold", "warn", `$${amount} is above your $${policy.approval_threshold} ask-me threshold.`);
  if (merchant && policy.require_approval_new_merchant && !spend.known_merchants.includes(merchant.id))
    add("New merchant", "warn", `First purchase from ${merchant.name}.`);
  if (spend.purchases_last_hour >= policy.velocity_limit_per_hour)
    add("Velocity", "warn", `${spend.purchases_last_hour} purchases in the last hour.`);

  const decision = checks.some((c) => c.outcome === "fail") ? DECISION.DENY
    : checks.some((c) => c.outcome === "warn") ? DECISION.HUMAN
    : DECISION.AUTO;

  return { decision, amount, items, merchant, checks };
}

// ---------------------------------------------------------------------------
// Offline policy compiler: a regex fallback used when no ANTHROPIC_API_KEY is
// set. The AI compiler in agent.js handles far messier phrasing.
const CATEGORY_WORDS = {
  alcohol: /alcohol|booze|wine|beer|liquor/i,
  gift_cards: /gift ?cards?/i,
  electronics: /electronics|gadgets/i,
  toys: /toys/i,
  groceries: /groceries|grocery|food/i,
  party_supplies: /party supplies|party/i,
  books: /books/i,
  household: /household/i,
  pet: /pet|dog|cat/i,
};

export function compilePolicyOffline(text, base) {
  const p = structuredClone(base);
  const money = (re) => { const m = text.match(re); return m ? Number(m[1].replace(/,/g, "")) : undefined; };
  p.monthly_budget = money(/(?:monthly budget|budget)[^$\d]*\$?([\d,.]+)/i) ?? p.monthly_budget;
  p.per_purchase_limit = money(/(?:more than|over|max(?:imum)?|cap(?: of)?)\s*\$([\d,.]+)\s*(?:in one|per|a) (?:purchase|order)/i) ?? p.per_purchase_limit;
  p.approval_threshold = money(/ask me[^$]*\$([\d,.]+)/i) ?? p.approval_threshold;
  p.min_merchant_trust = money(/trust score of at least (\d+)/i) ?? p.min_merchant_trust;
  p.require_approval_new_merchant = /haven'?t used|new merchant/i.test(text);
  const blocked = [];
  const noClause = text.match(/\bno ([^.]+)/gi) || [];
  for (const clause of noClause)
    for (const [cat, re] of Object.entries(CATEGORY_WORDS)) if (re.test(clause)) blocked.push(cat);
  p.blocked_categories = [...new Set(blocked)];
  p.category_limits = {};
  for (const [cat, re] of Object.entries(CATEGORY_WORDS)) {
    const m = text.match(new RegExp(`(?:${re.source})[^.$]*?(?:up to|max|limit|cap)\\s*\\$([\\d,.]+)`, "i"));
    if (m && !blocked.includes(cat)) p.category_limits[cat] = Number(m[1].replace(/,/g, ""));
  }
  return p;
}
