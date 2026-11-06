# WhitePay: coverage against business needs

Checked 2026-11-04 against the project document. The verification column says how each item was checked:

- **contract:** Hardhat contract tests (64).
- **e2e:** `tests/e2e/core.js` (44 steps).
- **sdk:** `sdks/test-all.sh`.
- **browser:** manual check in the browser.
- **onchain:** dry runs on Whitechain testnet.

Legend: ✅ met · 🟡 partly met · ⬜ not started · † needs a partner or legal work.

## 1. Target users (doc §1.3)

| User | Main need | Status | What exists | Biggest gap |
|---|---|---|---|---|
| Online merchants | Checkout + automated fulfilment | ✅ | Hosted checkout, payment links/QR, **embeddable widget** (`/widget.js`: no-code button, popup or modal) with verified status events; `payment.fulfillable` webhook at the merchant's chosen finality; exceptions queue (e2e, browser) | E-commerce plugins (WooCommerce is PHP, so skipped for now; Shopify needs a partner app); React/Vue wrappers |
| Remote studios & contractors | Global invoices, paid on time | ✅ | Invoices with tax, Net terms, partial and multi-payer payments, late fees, discounts, AR aging, printable PDF, 7 languages; **invoice, reminder and receipt emails + WhatsApp in the client's language** (e2e, notify test) | Real provider delivery not exercised (adapters tested against a mock). Recurring invoices and credit notes are done (e2e-ext) |
| SaaS businesses | Recurring billing, failed renewals | ✅ | **On-chain plans** (merchant sets price, payer sets cap); **free trials, intro pricing, pause/resume** (a payer's pause can't be lifted by the merchant); **upgrade with prorated charge / downgrade at next period**; no back-to-back catch-up charges; **dunning** (past_due → smart retries → unpaid after grace, recovery), **pre-renewal and at-risk alerts**; **MRR, ARR, churn, recovery** metrics; allowance view + one-click revoke (contract, e2e, browser) | Seat-based and usage/metered billing |
| Marketplaces & platforms | Seller onboarding, fees, payouts | 🟡 | **Multi-merchant server**: platform onboarding API, per-merchant API keys (hashed, rotatable), quote signers (AES-GCM encrypted), webhooks + secrets, branding, notifications; on-chain registration links automatically; full data isolation (e2e: 14 checks) | **Split payouts:** `PayoutSplitter` (platform fee paid at once, seller share held, arbiter can return held funds), created from the dashboard's Marketplace tab with the seller's own wallet, suggested at onboarding via `PLATFORM_FEE_*`; e2e-tested through pay, sweep, return and release. Per-seller contracts are not deployed on testnet |
| Finance teams | Reconcile, export, audit | ✅ | Append-only double-entry ledger tied to each tx; reconciliation against the chain (holds after reorgs); CSV; AR aging; reason codes (e2e) | Tally; Xero/QuickBooks are CSV journal imports, not live API sync. Excel/PDF statements, period close and the read-only auditor role are done (e2e-ext) |
| Developers | Integrate quickly, test failures safely | ✅ | Versioned REST API `/api/v1` + OpenAPI; SDKs in **TypeScript, Python, Go, Ruby, Java, PHP**; idempotency keys; cursor pagination; HMAC webhooks with replay; local devnet; simulated reorg in tests (sdk, e2e) | PHP SDK not run here; CLI with webhook forwarding and a local-chain test clock are done (test-cli-mcp); all six SDKs wrap the new endpoints (live tests pass in TS, Python, Go, Ruby and Java; PHP unrun) |
| Paying customers | Pay easily, verify receipts, control subscriptions | ✅ | Wallet or gasless (one signature, no WBT) checkout; receipts verified in the browser; signed refund requests; cancel anytime; 7 languages incl. RTL (browser, e2e) | Done: allowance view/revoke, wallet deep links, payment-history portal (`/portal.html`), PWA (browser-checked only in Arabic/English) |
| AI agents | Pay or get paid within limits | ⬜ | Contract-enforced subscription caps would suit agent budgets | MCP server, x402, agent spending policies |

## 2. Product principles (doc §1.4)

| Principle | Status | Evidence |
|---|---|---|
| Non-custodial | ✅ | Funds go payer → merchant wallet in the same transaction; contract balance stays 0 (contract tests assert it) |
| Contract-enforced | ✅ | Exact amounts, expiry, refund caps, operator limits, subscription caps, payout timelock, and a pause that can't block refunds or cancellations: all onchain (21 contract tests) |
| Finality-aware | ✅ | Per-payment seen/safe/finalized/auto policy; real L1-based `safe`/`finalized` tags on Whitechain; reorg reverses ledger and un-fulfils |
| Verifiable | ✅ | Receipt and refund pages re-check the chain from the customer's browser; reconciliation re-derives totals from raw logs |
| Failure-ready | ✅ | Defined paths for expiry (requote), reorg, direct/wrong-token transfers, blocked payer (signed refund route), failed charges, RPC/sequencer stalls, retries without duplicates, crash-safe API errors |
| One core | ✅ | Dashboard, checkout, invoices, SDKs and webhooks all use the same API and ledger |

## 3. Languages and tooling (doc §3)

**Customer and merchant languages (§3.1).**

- **Done:** checkout, receipts and invoices in English, Hindi, Tamil, Telugu, Marathi, Bengali and Arabic, with an RTL layout, auto-detection, a switcher, `?lang=` links and locale formats.
- **Done (phrase-level):** demo store, subscription page, payer portal and the dashboard's headings, table headers and main buttons. Longer dashboard sentences and the new Finance tab are still English.
- **Translation quality:** the translations need review by native speakers.

**Developer languages (§3.2).**

| SDK | Status |
|---|---|
| TypeScript, Python, Go, Ruby, Java | ✅ Built and passing the shared webhook cases + live API tests |
| PHP | 🟡 Built; **not executed** (no PHP runtime on this machine) |
| C#/.NET, Rust, Elixir | ⬜ "Additional, based on demand" in the doc |
| REST + OpenAPI | ✅ `/api/v1`, `/openapi.json`, contract-checked against the server (`tests/checks/openapi.js`) |
| GraphQL | ⬜ |

**Platforms (§3.3).**

| Platform | Status | Notes |
|---|---|---|
| Web | ✅ | Hosted checkout, invoices, receipts, dashboard |
| Mobile | 🟡 | Installable PWA (manifest, offline shell), wallet deep links. No native SDKs |
| CLI | ✅ | `cli/whitepay.js` |
| Commerce plugins | 🟡 | WooCommerce plugin written, **not run** (no PHP); React and Vue wrappers (loader unit-tested, components not rendered) |
| Desktop, Messaging, POS | ⬜ | |
| AI agents | ⬜ | |

## 4. Release plan exit conditions (doc §10)

| Phase | Exit condition | Status |
|---|---|---|
| 1. Hackathon | Real test USDT payment shown end to end | 🟡 **Blocked on test USDT.** Full flow proven locally (44 e2e steps). On Whitechain testnet the contract is deployed (`0xb026038aaB3E7f6843B52DAD019291D1564DfcBB` (v3)) and dry runs against the real USDT pass every check except balance. |
| 2. Pilot | Pilot merchants complete real workflows on testnet | 🟡 Invoices ✅, subscriptions ✅, reconciliation ✅, multilingual checkout ✅, embeddable widget ✅, notifications ✅. Plugins and PWA ⬜. Testnet is on v3 (`0xb026…fcBB`) with plans, trials, pause and plan changes. |
| 3–5 | Production, platform, ecosystem | ⬜ Needs audits, KMS, monitoring and compliance partners † |

## 5. Hardening done in this review

- **API key check:** constant-time comparison (previously `!==`).
- **Crash safety:** async route errors no longer hang requests or crash the process (Node exits on unhandled rejections). All errors are JSON, including bad JSON (400) and oversize bodies (413).
- **Rate limits:** per-IP limit on public endpoints that create work: invoice pay, requote, relay, refund requests, demo checkout and faucet. Tested: a burst of 40 gets 30 answers, then 429.
- **API versioning:** stable `/api/v1` base and a `WhitePay-Version` header.
- **Pagination:** cursor pagination (`limit`, `starting_after`, `WhitePay-Next-Cursor`).
- **Webhook replay:** replaying an unknown webhook now returns 404 instead of 200.
- **Demo webhook receiver:** now verifies the raw body, the timestamp window and a constant-time HMAC, so merchants copying it copy safe code.

## 6. Added in the "complete remaining" round

- **Subscription lifecycle:**
  - **Contract:** `createPlan`, `subscribeToPlan`, `pauseSubscription`/`resumeSubscription`, `changePlan`, plus 8 new contract tests (29 in total).
  - **Server:** a subscriptions module with dunning, alerts and metrics.
  - **Pages:** a customer portal and the merchant plan manager.
- **Notifications:** one outbox for Slack, Telegram, WhatsApp Cloud API and email (Resend). Customer emails are localized into the 7 languages. Unconfigured channels are logged instead of dropped. Retries and dedupe are tested against a mock provider (`scripts/test-notify.js`).
- **Checkout widget:** `web/public/widget.js` plus a demo at `/widget-demo`. Status messages are accepted only from the WhitePay origin and the exact checkout window the widget opened; a forged message was tested and ignored.
- **Multi-merchant:** a merchant registry and onboarding API, with everything scoped by merchant. Reconciliation now also counts upgrade proration.
- **RPC range limits:** found while running on testnet. After downtime, Ankr rejected a 1,312-block `getLogs` range. Log fetching now splits rejected ranges automatically, and the indexer caught up in one tick.

## 7. Highest-impact gaps, in order

1. **Get test USDT and record one real testnet payment.** This is the Phase 1 exit condition and what judges will ask for.
2. **Run the PHP SDK tests** on a machine with PHP 8.1+.
3. ✅ Redeployed to testnet as v3 (`0xb026038aaB3E7f6843B52DAD019291D1564DfcBB`).
4. **Connect real notification providers** (Resend/WhatsApp/Slack/Telegram credentials) and send one of each.
5. **Marketplace money flows:** split payments, platform fee and delayed payouts (contract work).
6. **E-commerce plugin:** WooCommerce once PHP is in scope.
7. **Native-speaker review** of the six translations.
8. **Production readiness:** audit, KMS for the signer and relayer keys, Postgres, monitoring †.

## SaaS layer
A Next.js web app (`web/`) is the front door: product website, pricing, signup, sign-in, a full merchant console (payments with partial and bulk refunds, invoices, subscriptions and plans, refund requests and operators, finance and exports, ledger and reconciliation, marketplace splits, developers, plan and usage) and an operator console. Customer-facing checkout pages stay as light, embeddable HTML served by the API. Keys live in httpOnly cookies and never reach browser code; writes are origin-checked. Behind it: plans with monthly limits and feature gates, per-tenant rate limits, upgrade by paying in USDT, suspension, and Docker deployment of both services (built and run together here). Tested: `tests/e2e/saas.js` (34 checks), `tests/e2e/web.js` (34 checks), and the wallet flows (partial refund, subscription refund, wallet registration) driven through the UI with a mock wallet. Gaps: SQLite means a single node, no email verification or password login (the API key is the credential), plan billing is crypto-only, the web app is English-only, and the wallet screens were exercised with a mock wallet, not MetaMask.

## Refunds: what is and is not covered
- **Payments:** full and partial refunds, reason codes, operator limits, bulk, payer-signed reroute (contract and dashboard).
- **Credit notes after payment:** the invoice reports `refundDue` and a `refundPlan` (which payments, how much, newest first); the dashboard's "Refund … (credit note)" button executes it from the owner wallet. The server never moves funds itself.
- **Subscriptions:** `refundSubscription(subId, amount, reason)` refunds charges (any amount up to what was charged, same owner/operator rules, works while paused or after cancelling). `GET /api/v1/subscriptions/{id}/refund-quote` suggests the unused part of the period. Earlier docs said a subscription charge could be refunded like a payment: that was wrong, and this function is the fix. It needs contract v5.
- **Marketplace holds:** `returnHeld` refunds funds still in a seller's hold; fee shares already paid out cannot be clawed back.
- Not done: automatic refund execution (a human wallet always signs), and refund-quote in the six SDKs (use HTTP).
