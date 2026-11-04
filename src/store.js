// State for a single household, persisted to data/state.json so a restart keeps
// the ledger, policy and mandate. Swap for a real database in production.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_POLICY_TEXT =
  "Monthly budget $300. Never spend more than $120 in one purchase. Ask me before anything over $60 " +
  "or from a merchant we haven't used before. Groceries up to $200 a month. No alcohol, no gift cards. " +
  "Only buy from merchants with a trust score of at least 60.";

export const DEFAULT_POLICY = {
  monthly_budget: 300,
  per_purchase_limit: 120,
  approval_threshold: 60,
  require_approval_new_merchant: true,
  min_merchant_trust: 60,
  blocked_categories: ["alcohol", "gift_cards"],
  category_limits: { groceries: 200 },
  blocked_merchants: [],
  max_quantity_per_item: 20,
  velocity_limit_per_hour: 6,
  currency: "USD",
};

function fresh() {
  return {
    policyText: DEFAULT_POLICY_TEXT,
    policy: structuredClone(DEFAULT_POLICY),
    // The mandate is the agent's standing permission to charge a vaulted PayPal
    // payment method without the buyer present. Null until the first approved purchase.
    mandate: null,
    ledger: [],
    // Merchants this household already pays through PayPal (seeded history).
    knownMerchants: ["freshcart", "homebase", "bookloft"],
    approvals: {},
    conversation: [],
    redteam: false,
    webhooks: [],
  };
}

export const state = fresh();

export function resetState() {
  Object.assign(state, fresh());
}

// ---------------------------------------------------------------- persistence
const DATA_DIR = process.env.LEASH_DATA_DIR
  || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const FILE = path.join(DATA_DIR, "state.json");
const PERSIST = process.env.LEASH_PERSIST !== "0";

export function loadState() {
  if (!PERSIST || !fs.existsSync(FILE)) return false;
  try {
    Object.assign(state, fresh(), JSON.parse(fs.readFileSync(FILE, "utf8")));
    return true;
  } catch (e) {
    console.warn(`Could not read ${FILE} (${e.message}); starting fresh.`);
    return false;
  }
}

let saveTimer;
export function flushState() {
  clearTimeout(saveTimer);
  if (!PERSIST) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Write-then-rename so a crash mid-write never leaves a corrupt file.
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(state));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (e) {
    console.warn(`Could not save state: ${e.message}`);
  }
}

export function saveState() {
  if (!PERSIST) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushState, 150);
}

// ---------------------------------------------------------------- derived views
export function newId(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function monthStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export function spendSummary() {
  const since = monthStart();
  // Pending approvals count as committed so the agent can't queue up an overspend.
  const committed = state.ledger.filter((t) => ["PAID", "PENDING_APPROVAL"].includes(t.status) && t.ts >= since);
  const total = committed.reduce((s, t) => s + t.amount, 0);
  const byCategory = {};
  for (const t of committed) for (const it of t.items) byCategory[it.category] = (byCategory[it.category] || 0) + it.price * it.qty;
  return {
    month_spent: round(total),
    month_remaining: round(state.policy.monthly_budget - total),
    by_category: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, round(v)])),
    known_merchants: [...new Set([...state.knownMerchants, ...state.ledger.filter((t) => t.status === "PAID").map((t) => t.merchant_id)])],
    purchases_last_hour: state.ledger.filter((t) => t.status === "PAID" && t.ts > Date.now() - 3600e3).length,
  };
}

/** Headline numbers for the KPI strip and the pitch: what the leash did. */
export function stats() {
  const L = state.ledger;
  const agg = (pred) => {
    const rows = L.filter(pred);
    return { count: rows.length, amount: round(rows.reduce((s, t) => s + t.amount, 0)) };
  };
  const blocked = agg((t) => t.status === "DENIED");
  const declined = agg((t) => t.status === "DECLINED_BY_USER");
  return {
    autonomous: agg((t) => t.status === "PAID" && t.mode === "autonomous"),
    human: agg((t) => t.status === "PAID" && t.mode === "human"),
    pending: agg((t) => t.status === "PENDING_APPROVAL"),
    blocked,
    declined,
    refunded: agg((t) => t.status === "REFUNDED"),
    injections_blocked: L.filter((t) => t.checks?.some((c) => c.rule === "Listing integrity" && c.outcome === "fail")).length,
    protected_amount: round(blocked.amount + declined.amount),
  };
}

export const round = (n) => Math.round(n * 100) / 100;
