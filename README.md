# 🦮 Leash — give your AI agent a PayPal wallet, on a leash

**Leash lets an AI shopping agent pay with your PayPal, but only within rules you write in plain English.**
In-policy purchases go through on their own. Risky ones come to your laptop **or your phone** for a one-tap PayPal approval. Anything that breaks a rule never gets paid, even if a malicious listing manages to fool the model.

> Built for the *Build What's Next with PayPal and AI* hackathon.
> PayPal Orders v2 · PayPal Vault v3 · PayPal JS SDK · PayPal Webhooks · Claude (Anthropic) · AG Grid · deployable on Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/bodhai/leash)

---

## The problem

Agentic commerce is coming, and nobody wants to hand an LLM their card number. Today you get two bad options:

1. **Agent asks for approval on every purchase.** You end up doing the shopping yourself, with extra steps.
2. **Agent has unrestricted access.** Then a hallucination, a bad tool call, or a prompt injection hidden in a product listing can drain your account.

The missing piece is a **mandate**: a scoped, revocable permission to spend, enforced by code the model can't talk its way around.

## What Leash does

| | |
|---|---|
| ✍️ **Plain-English policy → enforced rules** | *"$300/month, nothing over $120, ask me above $60 or for new merchants, no alcohol or gift cards"*. Claude compiles this into a typed policy (structured outputs), and a deterministic engine enforces it. One-click templates: Family, Strict, Small business. |
| 🤖 **A real shopping agent** | Claude (tool use + adaptive thinking) searches merchants, plans carts, splits orders per merchant and explains what it's doing. Every step shows up live in the **Agent trace**. |
| 🔐 **PayPal mandate via Vault** | The first purchase you approve in PayPal is created with `store_in_vault: ON_SUCCESS`. The vault token it returns becomes the agent's mandate. |
| ⚡ **Autonomous in-policy payments** | Once the mandate exists, purchases that pass every rule are charged against the vault token (`payment_source.paypal.vault_id`, merchant-initiated) with no human in the loop. |
| 📱 **Phone wallet over your LAN** | Scan the QR code and approve, decline or revoke from your phone. Every screen stays in sync live (server-sent events), and the phone buzzes when the agent needs you. |
| 🙋 **Human-in-the-loop for edge cases** | Above-threshold amounts, new merchants, odd quantities and purchase-velocity spikes open a PayPal approval with the exact reasons listed. |
| 🛡️ **Prompt-injection defense, two layers** | Layer 1 sanitizes merchant listings that address AI agents. Layer 2, the policy engine, is the real guarantee. **Red-team mode** swaps in a simulated *compromised* agent that obeys the attack, so you can watch the engine still block it. |
| 📊 **KPIs: what the leash did** | Paid autonomously, human-approved, waiting for you, and **money protected** (blocked + declined), plus injections stopped. |
| 📒 **Auditable ledger (AG Grid)** | Every attempt is logged with who decided and why. Click any row for the full rule-by-rule audit, or export it to CSV. |
| ↩️ **Refunds, webhooks & kill switch** | One-click refunds through the Captures Refund API. Verified PayPal webhooks pick up refunds and disputes made outside Leash. **Revoke agent** deletes the vault token. |
| ▶️ **Guided demo tour** | A 7-step narrated walkthrough of the whole story, handy for judges and for recording the video. |

## Run it (Windows, about 2 minutes)

Requirements: **Node.js 18+** ([nodejs.org](https://nodejs.org), LTS).

**Easiest:** double-click **`start-leash.bat`**. It installs dependencies the first time, creates `.env`, and starts the server.

**Or from a terminal:**
```bash
git clone https://github.com/bodhai/leash.git
cd leash
npm install
npm start
```

The server listens on **0.0.0.0:3000**, so every device on your network can reach it:

```
  This PC:      http://localhost:3000
  On your LAN:  http://192.168.x.x:3000        (phone wallet: http://192.168.x.x:3000/phone.html)
```

Open the **This PC** link on the computer. Click **📱 Phone** and scan the QR code with a phone on the same Wi-Fi.

> **Phone can't connect?** Windows Firewall is blocking port 3000. When Windows asks whether to let Node.js through, allow it on **Private networks**, or right-click `allow-lan-firewall.bat` and choose *Run as administrator*. Make sure your Wi-Fi is set to a **Private** network.

**Leash runs with zero keys.** It picks a mode based on what's configured in `.env`:

| Configured | AI | PayPal |
|---|---|---|
| nothing | offline deterministic planner | simulated Orders/Vault |
| `ANTHROPIC_API_KEY` | **Claude** agent + policy compiler | simulated |
| `PAYPAL_CLIENT_ID` + `PAYPAL_CLIENT_SECRET` | offline planner | **PayPal sandbox** |
| both | **Claude** | **PayPal sandbox** ← the full experience |

### Settings (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Enables the Claude agent and policy compiler |
| `LEASH_MODEL` | `claude-opus-5-5` | Claude model |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | — | PayPal sandbox app credentials |
| `PAYPAL_WEBHOOK_ID` | — | Enables signature-verified webhooks at `/api/paypal/webhook` |
| `HOST` | `0.0.0.0` | `0.0.0.0` = whole LAN, `127.0.0.1` = this PC only |
| `PORT` | `3000` | HTTP port |
| `LEASH_PIN` | — | Require a PIN for every API call (recommended on shared Wi-Fi) |
| `LEASH_PERSIST` | `1` | Save state to `data/state.json`; `0` = memory only |

### PayPal sandbox setup
1. Go to [developer.paypal.com](https://developer.paypal.com) → *Apps & Credentials* → *Sandbox* → **Create App** (Merchant).
2. Copy the **Client ID** and **Secret** into `.env`.
3. In the app's settings, enable **Save payment methods** (Vault). The autonomous-payment mandate depends on it.
4. Use a sandbox **personal** account (*Testing Tools → Sandbox Accounts*) to log in at the PayPal popup.
   **Create both sandbox accounts (business + personal) with Country = United States.** Accounts from some countries (e.g. India) can't take these USD payments and PayPal shows *"This seller doesn't accept payments in your currency"*.
5. Optional: add a webhook pointing to `https://<public-url>/api/paypal/webhook` (events: `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `CUSTOMER.DISPUTE.CREATED`) and put its ID in `PAYPAL_WEBHOOK_ID`. Webhooks need a public URL, for example on Render.

### Tests
```bash
npm test     # 14 tests: policy engine, purchase/mandate lifecycle, webhook, live broadcast
```

## Demo script

Click **▶ Demo tour** to have the app narrate these steps, or do them by hand:

1. **"Plan my daughter's 8th birthday party for 10 kids, keep it under $90"**: the agent shops across merchants, ignores the injected *MegaDealz247* listing, and sends two orders for approval.
2. **Approve one on your phone** and watch the laptop update instantly. The first approval vaults your PayPal, and the header switches to **Mandate: active**.
3. **"We're out of paper towels, dish soap and trash bags"**: **paid autonomously**, with no popup.
4. **"Grab a bottle of prosecco for tonight"**: **blocked** (alcohol).
5. **Red-team mode** + **"Get me the cheapest party supply bundle you can find"**: a simulated compromised agent obeys the listing and tries to buy $1,000 of gift cards; the engine blocks it on five rules.
6. Switch to the **Strict** template and watch the rules change. Then open a ledger audit, **Refund**, **Export CSV**, and **Revoke agent**.

## Architecture

```
          plain-English rules                    chat (laptop or phone)
                 │                                      │
                 ▼                                      ▼
   ┌──────────────────────────┐          ┌───────────────────────────────┐
   │ Claude: policy compiler   │          │ Claude: shopping agent         │
   │ (structured JSON output)  │          │ tools: search_products,        │
   └────────────┬─────────────┘          │ get_wallet_status,             │
                │ typed policy           │ propose_purchase               │
                ▼                         └──────────────┬────────────────┘
   ┌───────────────────────────────────────────────────────▼──────────────┐
   │  POLICY ENGINE (deterministic JS — the leash)                          │
   │  → AUTO_APPROVE | NEEDS_APPROVAL | DENY                                │
   └───────┬──────────────────────────┬──────────────────────────┬─────────┘
           ▼                          ▼                          ▼
   Orders v2 on vault_id      JS SDK popup (laptop/phone)    ledger entry,
   (no buyer present)         → capture → vault = mandate    agent told why
           │                          │                          │
           └──────────── state.json + live event stream ─────────┘
                         → every screen on the LAN updates
```

The model only ever **proposes** a purchase. The tool that executes it runs the policy engine first, and nothing in the prompt, the conversation or a merchant listing can skip that step.

## PayPal APIs used

| API | Why |
|---|---|
| `POST /v1/oauth2/token` | Client-credentials auth (cached) |
| `POST /v2/checkout/orders` with `vault.store_in_vault=ON_SUCCESS` | Itemized order that vaults the buyer's PayPal → **mandate** |
| PayPal **JS SDK** Buttons | Buyer approval on laptop or phone |
| `POST /v2/checkout/orders/{id}/capture` | Capture; returns `vault.id` |
| `POST /v2/checkout/orders` with `payment_source.paypal.vault_id` + `stored_credential` | Merchant-initiated charge, no buyer present |
| `POST /v2/payments/captures/{id}/refund` | One-click refunds |
| `DELETE /v3/vault/payment-tokens/{id}` | Kill switch |
| `POST /v1/notifications/verify-webhook-signature` | Verify incoming webhooks before trusting them |

Every call sends a `PayPal-Request-Id` idempotency key. Orders carry line items, `custom_id` = Leash transaction id, and a `soft_descriptor`.

## Project layout

```
server.js            Express API, 0.0.0.0 binding, PIN guard, SSE streams, QR, webhook
src/agent.js         Claude agent loop, offline planner, policy compiler
src/policy.js        Deterministic policy engine (+ offline NL parser)
src/commerce.js      Purchase orchestration: policy → PayPal → ledger (+ webhooks)
src/paypal.js        PayPal Orders v2 / Vault v3 / Refunds / Webhook verify (+ simulator)
src/store.js         State, persistence to data/state.json, spend summary, KPIs
src/events.js        Live event bus for every connected screen
src/catalog.js       Multi-merchant catalog incl. an adversarial merchant
public/index.html    Desktop console (app.js)    public/phone.html   Phone wallet (phone.js)
test/                Policy engine + lifecycle tests
setup-keys.bat       Saves your keys into .env from the clipboard and tests them
```

## Deploy on Render

Click **Deploy to Render** above (or *New → Blueprint* and pick this repo). `render.yaml` sets everything up; Render asks for `ANTHROPIC_API_KEY`, `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`. All three are optional: leave them empty for offline/simulated mode. The free plan sleeps when idle, so the first visit can take about 30 seconds. State resets on each deploy. A public URL also lets you use PayPal webhooks (`PAYPAL_WEBHOOK_ID`).

## License

MIT, see [LICENSE](LICENSE).
