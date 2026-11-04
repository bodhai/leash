// PayPal integration: Orders v2 + Vault v3 (sandbox), with a simulated fallback
// so the app runs end-to-end without credentials.
//
// Flow:
//  1. First purchase (or anything the policy escalates): the human approves in the
//     PayPal popup. The order is created with `store_in_vault: ON_SUCCESS`, so the
//     capture returns a vault id — that becomes the agent's *mandate*.
//  2. Later purchases the policy auto-approves are charged against the vault id
//     with no buyer present: true autonomous, policy-bound agentic payments.
//  3. "Revoke" deletes the vault token, instantly cutting the agent off.
import { randomUUID } from "node:crypto";

const BASE = process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
export const LIVE = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

let tokenCache = { token: null, exp: 0 };

async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60e3) return tokenCache.token;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  tokenCache = { token: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return tokenCache.token;
}

async function pp(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": randomUUID(), // idempotency
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(`PayPal ${method} ${path} → ${res.status}: ${json.details?.[0]?.description || json.message || text}`);
    err.paypal = json;
    throw err;
  }
  return json;
}

function purchaseUnit(txn) {
  const money = (v) => ({ currency_code: "USD", value: v.toFixed(2) });
  return {
    reference_id: txn.id,
    description: `Leash agent purchase from ${txn.merchant}`.slice(0, 127),
    custom_id: txn.id,
    soft_descriptor: "LEASH AGENT",
    amount: { ...money(txn.amount), breakdown: { item_total: money(txn.amount) } },
    items: txn.items.map((i) => ({
      name: i.name.slice(0, 127),
      quantity: String(i.qty),
      unit_amount: money(i.price),
      sku: i.product_id,
      category: "PHYSICAL_GOODS",
    })),
  };
}

/** Order the human approves in the PayPal popup; vaults the wallet on success. */
export async function createApprovalOrder(txn, { vault }) {
  if (!LIVE) return { id: `SIM-${randomUUID().slice(0, 12).toUpperCase()}`, status: "CREATED", simulated: true };
  // PayPal requires return/cancel URLs whenever the order vaults the wallet. The JS SDK
  // popup flow never navigates to them, but they must be valid absolute URLs.
  const base = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
  const paypal = {
    experience_context: {
      shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW", brand_name: "Leash Agent Wallet",
      return_url: `${base}/phone.html?paypal=return`, cancel_url: `${base}/phone.html?paypal=cancel`,
    },
  };
  if (vault) paypal.attributes = { vault: { store_in_vault: "ON_SUCCESS", usage_type: "MERCHANT", customer_type: "CONSUMER" } };
  return pp("POST", "/v2/checkout/orders", { intent: "CAPTURE", purchase_units: [purchaseUnit(txn)], payment_source: { paypal } });
}

export async function captureOrder(orderId) {
  if (!LIVE) {
    return {
      id: orderId, status: "COMPLETED", simulated: true,
      capture_id: `SIMCAP-${randomUUID().slice(0, 10).toUpperCase()}`,
      vault_id: `SIMVAULT-${randomUUID().slice(0, 8).toUpperCase()}`,
      payer: "sb-buyer@personal.example.com",
    };
  }
  const o = await pp("POST", `/v2/checkout/orders/${orderId}/capture`, {});
  return normalize(o);
}

/** Merchant-initiated charge against the vaulted wallet — no buyer present. */
export async function chargeVault(txn, vaultId) {
  if (!LIVE) {
    return { id: `SIM-${randomUUID().slice(0, 12).toUpperCase()}`, status: "COMPLETED", simulated: true,
      capture_id: `SIMCAP-${randomUUID().slice(0, 10).toUpperCase()}` };
  }
  let o = await pp("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [purchaseUnit(txn)],
    payment_source: { paypal: { vault_id: vaultId, stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT" } } },
  });
  if (o.status === "APPROVED") o = await pp("POST", `/v2/checkout/orders/${o.id}/capture`, {});
  return normalize(o);
}

export async function refundCapture(captureId) {
  if (!LIVE) return { id: `SIMREF-${randomUUID().slice(0, 8).toUpperCase()}`, status: "COMPLETED", simulated: true };
  return pp("POST", `/v2/payments/captures/${captureId}/refund`, {});
}

export async function revokeVault(vaultId) {
  if (!LIVE || vaultId.startsWith("SIM")) return { revoked: true, simulated: true };
  await pp("DELETE", `/v3/vault/payment-tokens/${vaultId}`);
  return { revoked: true };
}

/**
 * Verify a webhook really came from PayPal (POST /v1/notifications/verify-webhook-signature).
 * Requires PAYPAL_WEBHOOK_ID. Returns false when verification isn't possible.
 */
export async function verifyWebhook(headers, event) {
  if (!LIVE || !process.env.PAYPAL_WEBHOOK_ID) return false;
  const r = await pp("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: headers["paypal-auth-algo"],
    cert_url: headers["paypal-cert-url"],
    transmission_id: headers["paypal-transmission-id"],
    transmission_sig: headers["paypal-transmission-sig"],
    transmission_time: headers["paypal-transmission-time"],
    webhook_id: process.env.PAYPAL_WEBHOOK_ID,
    webhook_event: event,
  });
  return r.verification_status === "SUCCESS";
}

function normalize(o) {
  const cap = o.purchase_units?.[0]?.payments?.captures?.[0];
  const src = o.payment_source?.paypal;
  return {
    id: o.id,
    status: o.status,
    capture_id: cap?.id,
    capture_status: cap?.status,
    vault_id: src?.attributes?.vault?.id,
    vault_status: src?.attributes?.vault?.status,
    payer: src?.email_address,
  };
}
