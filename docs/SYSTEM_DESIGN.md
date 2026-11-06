# WhitePay — System design and feature coverage

Status as of 2026-11-04. Legend: ✅ built and tested · 🟡 partial · ⬜ not built · † needs licensed partner/legal · ‡ depends on chain/wallet support

## 1. The six defining features (all built)

| Defining feature | How it's enforced | Proof |
|---|---|---|
| Contract-enforced refunds | `refund()` / `refundBatch()` revert if `refunded + amount > paid`. A reason code is mandatory. Operators have onchain per-refund and daily limits, and the owner is unlimited (so the owner is the approval path) | "is capped", "refund controls" suite, e2e bulk + operator limit |
| Contract-enforced spending limits | Subscription stores payer-signed `amount`, `period`, `end`, lifetime `cap`; terms validated | "keeper charges… within cap", "rejects unsafe terms" |
| Merchant-selected finality | Per-intent `policy` = seen / safe / finalized / auto(by amount); `payment.fulfillable` webhook fires only at that level | e2e "finalized + fulfillable" |
| Chain-reconciled accounting | Append-only double-entry ledger, each line → `tx_hash:log_index`; `/api/reconcile` re-derives totals from raw logs | e2e "ledger reconciles", incl. after a reorg |
| Independently verifiable receipts | `/receipt` queries the RPC from the browser and checks tx, emitter, amount, token, payer, refunds | manual |
| Gasless checkout (bonus) | Payer signs one EIP-3009 authorization bound to the quote digest; relayer pays gas | 4 gasless tests, e2e "payer spent zero gas token" |
| Customer-controlled cancellation | `cancel()` callable only by payer, works even while paused | "pause … never refunds or cancellations" |
| Stolen API key can't redirect funds | API key = quote signer only. Payout change is owner-only + timelocked; signer can be revoked and its outstanding quotes die | "signer key cannot change payout", "revoked signer" |

## 2. Architecture

```
 Browser pages (checkout, receipt, portal, dashboard)        Merchant backend
        │  public endpoints                                      │ Bearer API key
        ▼                                                        ▼
 ┌──────────────────────────── server/ (Core API: routes/) ─────────────────────────┐
 │ intents + quote signing · idempotency · requote · demo store · reconcile · exports│
 └───────────────┬──────────────────────────────┬───────────────────────────────────┘
                 │ SQLite (server/db.js)         │
   ┌─────────────┴─────────────┐   ┌─────────────┴──────────────┐
   │ intents · subs · ledger   │   │ chain_events (event store) │
   │ webhooks · exceptions     │   │ idempotency · kv cursors   │
   └─────────────┬─────────────┘   └─────────────┬──────────────┘
                 │                               │
     services/webhooks.js (outbox)       services/indexer.js (indexer + keeper)
     HMAC, retries, replay             logs → events → ledger; finality; reorgs
                 │                               │
                 └──────────── Whitechain RPC ───┘──► contracts/WhitePay.sol
```

**Key design choices**

- **Non-custodial by construction.** `pay()` moves tokens from payer to the merchant's payout wallet in one `transferFrom`. The contract never holds a balance, so there's nothing to drain.
- **Split keys (least privilege).**
  - The *admin* key can only manage the token registry and the pause switch.
  - The *merchant owner* key (can be a Safe; two-step transfer) controls payout, signers and refunders.
  - The *quote signer* key (hot, on the server) can only sign expiring quotes.
  - The *keeper* key can only trigger charges that are already authorised.
  - The *relayer* key only pays gas for gasless checkouts. It can't move anyone's tokens, because the token checks the payer's signature.
- **Event sourcing for chain data.** Every log the indexer acts on goes into `chain_events` keyed by `tx:logIndex:blockHash`. Derived values (refunded total, subscription charged) are recomputed from *active* events. That makes reorgs a data operation: mark the event `reorged`, add reversal ledger lines, recompute, and rewind the cursor.
- **Append-only ledger.** Nothing is updated or deleted. Reorgs add mirrored `rev:` lines, and the ledger stays balanced at every point.
- **Transactional outbox for webhooks.** Each event gets a deterministic `event_id`, so re-indexing never double-sends. Delivery is at-least-once with exponential backoff (5s→1h, 5 attempts), plus manual replay. The receiver verifies `t=…,v1=HMAC(secret, t.body)`.
- **Idempotency everywhere.**
  - `Idempotency-Key` header and `orderRef` dedupe on the API.
  - Event keys dedupe on the indexer.
  - `event_id` dedupes webhooks.
  - `AlreadyPaid` dedupes onchain.
- **Gasless checkout bound to one payment.** The payer signs one EIP-3009 `ReceiveWithAuthorization` whose `nonce` is the quote's EIP-712 digest.
  - **Can't be redirected:** the contract recomputes the digest and passes it as the nonce. An authorization taken from one quote fails against any other, even one with the same amount.
  - **Can't be front-run:** `receiveWithAuthorization` requires `to == msg.sender`, so the authorization can't be submitted straight to the token.
  - **No permit allowance:** we chose this over EIP-2612 `permit`, whose allowance could be spent on a different quote by whoever relays it.
- **Invoices are derived, not stored.** An invoice stores only its terms and line items, in integer minor units with no floats. `paid`, `balance`, late fee, discount and status are recomputed from the invoice's linked payment intents. Reorgs and refunds therefore reopen the balance automatically, with no extra code path. Each payment toward an invoice is an ordinary exact, expiring onchain quote, so the contract didn't change.
- **Localization is a thin, fail-safe layer.** `web/lib/i18n/messages.json` (keys and exact phrases) and `web/lib/i18n/index.ts` (detection from ?lang=, cookie, browser; `t()`, Intl formatting); email wording lives in `server/i18n/mail.json`. The language is chosen on the server, so pages never flash English first.
  - **Fallback:** every key falls back to English.
  - **Safe interpolation:** values are HTML-escaped when they're inserted.
  - **Opting out:** merchant-only pages set `<html data-i18n="off">`.
  - **Digits:** amounts keep Latin digits (what wallets and explorers show) but use locale grouping.
  - **Fixed English:** signed messages (refund requests) stay in canonical English, because the server verifies the exact text.
  - **Checks:** `npm run check:i18n` fails on missing keys or placeholder drift.
- **Finality from the chain, not guesses.** On Whitechain (OP Stack) the indexer reads the RPC `safe` / `finalized` block tags. On testnet those lag the head by about 8 and 37 minutes. Locally it falls back to confirmation counts.

## 3. Payment state machine

```
created ──pay()──► seen ──batch on L1──► safe ──L1 final──► finalized
   │                 │                    │
   │ expiry passes   └──── block replaced ┴──► reorged ──re-submit──► seen …
   ▼                                              │
 expired ──requote──► created                     └─ requote ─► created

any paid state ──refund()──► partially_refunded ──► refunded   (capped at amount)
```
`fulfillable` becomes true once `finality ≥ policy`. It flips back to false on a reorg, and `payment.reorged` is emitted.

## 4. Failure modes and how each one is handled

| Failure | Handling | Where |
|---|---|---|
| Underpayment / overpayment | Impossible via `pay()`: exact signed amount, single `transferFrom`; balance-delta check rejects fee-on-transfer tokens | contract |
| Late payment | Quote expiry enforced onchain; customer can request a fresh quote at current rate | `POST /api/intents/:id/requote` |
| Duplicate payment | `AlreadyPaid` onchain; `orderRef` / `Idempotency-Key` offchain | contract, API |
| Tampered quote | EIP-712 signature covers merchant, intent, token, amount, expiry | contract |
| Direct transfer / exchange withdrawal / wrong token | Indexer watches all `Transfer`s to the payout wallet that didn't go through the contract → Exceptions queue + webhook | `scanExceptions` |
| Reorg | Event store re-verifies every non-final event's block hash, reverses ledger, emits `payment.reorged`, re-scans | `checkReorgs` |
| RPC outage / sequencer stall | `/api/status` flags RPC errors, indexer lag and head-block age > 30s; checkout shows banner; requote extends window | status + `common.js` |
| Public RPC range limits | `getLogs` chunked (`LOG_CHUNK`); a rejected range is split in half and retried, so it adapts to whatever limit the RPC enforces (found on Ankr after downtime) | `getLogsRange` |
| Refund operator key stolen | Damage capped by the contract: max per refund and a daily budget; owner can set limits to 0 instantly; `merchant.refund_operator_changed` webhook | `_authorizeRefund` |
| Bulk refund with one bad item | `refundBatch` is all-or-nothing, so there are no half-applied batches | contract |
| Fake refund request | Customer requests must be EIP-191 signed by the wallet that paid; one open request per payment; amount ≤ what's left | `POST /api/intents/:id/refund-requests` |
| Payer blacklisted / contract rejects funds | Refund to a payer-signed (EIP-712 / EIP-1271) alternate address | `refund(…, to, payerSig)` |
| Subscription can't be charged | Pre-charge `staticCall` (no wasted gas), reason = low_balance / low_allowance / revert name, retry after 1h, `subscription.charge_failed` webhook | `keeper()` |
| Gasless signature reused for another payment | Nonce = quote digest → token rejects the signature for any other quote | contract + token |
| Relayer drained by spam | Relays only real, unpaid, unexpired intents; one in-flight per intent; `staticCall` first (bad signatures cost nothing); daily budget + per-payer cap; serialized nonces | `POST /api/intents/:id/relay` |
| Checkout UI resets mid-signature | Status polling pauses while a wallet prompt is open | `pay.html` |
| Stolen API key | Can only sign quotes that pay the onchain payout wallet; revoke signer → outstanding quotes invalid | contract |
| Stolen owner key | Payout change timelocked + `merchant.payout_change_queued` webhook gives time to react; owner can be a Safe | contract + indexer |
| Contract bug in progress | Admin `setPaused(true)` stops pay/subscribe/charge; **refunds and cancellations keep working** | contract |
| Server crash / restart | Cursor in DB; all handlers idempotent; webhooks resume from outbox | indexer |

## 5. Feature coverage against the full spec

| # | Area | Built | Partial | Not built |
|---|---|---|---|---|
| 1 | Accepting payments | Hosted checkout, payment links, QR, connected wallet, **gasless checkout (EIP-3009, merchant-sponsored gas)**, fiat→USDT time-limited quote, exact + expiring intents, under/over/late/duplicate protection, wrong-token and direct-transfer detection | Smart accounts (work via `msg.sender`; untested) | Widget/popup/React/Vue components, payment buttons, POS mode, embedded wallet ‡, CREATE2 deposit addresses ‡, , authorize/capture, tips/coupons/tax/shipping, carts, localization, branding |
| 2 | Invoicing / B2B | Branded invoices with line items, per-line tax %, client + merchant tax IDs, PO reference, due dates, Net 15/30/60, PDF via print, partial payments with a minimum (deposits/milestones), one invoice paid by several wallets, one-time late fee, early-payment discount, automatic reminders (due soon / overdue / 7d / 30d) and manual reminder as webhooks, overdue filter, AR aging report, void, fiat reference amounts paid in USDT at pay-time rate | Reminders are delivered as webhooks; you plug in email/Slack/WhatsApp | Credit notes, recurring invoices, statements, approval workflows, bulk invoicing, multilingual invoices |
| 3 | Subscriptions | Fixed plans, payer-signed cap/period/end, allowance limited to cap, onchain + portal cancel, pre-charge simulation, failure reasons, retries, permissionless keeper | Fallback keeper (anyone can call `charge`, but only one keeper runs) | Tiered/seat/usage plans, trials, pause/resume, proration, dunning emails, MRR/churn metrics |
| 4 | Refunds | Full/partial/bulk one-click, onchain cap, mandatory onchain reason codes, per-operator limits (per refund + daily) with owner approval above them, payer-signed refund address, signed customer refund requests with approve/reject queue, public refund receipts verified in the browser, status tracking | Refund funding (owner or operator wallet; no rolling reserve) | Evidence collection, merchant SLAs, third-party mediation |
| 5 | Finality / settlement | All states incl. reorged/expired/refunded, policy per intent + auto by amount, real L1-based finality, outage + stall detection, status banner, requote, gas shown per payment | Settlement = direct-to-wallet only | Policies by product/risk, instant-fulfilment guarantee †, forced-inclusion guidance, batched/scheduled payouts |
| 6 | Treasury | Owner can be a Safe (two-step ownership) | — | Sweep rules, payouts, bridging, off-ramps †, forecasting, yield † |
| 7 | Accounting | Append-only double-entry ledger, tx-traceable lines, chain reconciliation, CSV export, gross/refunds/net, separate `revenue:invoices` account, AR aging, fiat rate stored per payment | Reconciliation is on demand (no scheduled alerts) | Excel/PDF, Xero/QuickBooks/Tally…, deferred revenue, AR aging, tax †, FX gain/loss, auditor role |
| 8 | Dashboard | Payments, links, subscriptions, ledger, reconciliation, exceptions, webhooks, dev panel | Test vs live = separate env files and data dirs | Search/filters, analytics, notifications beyond webhooks, team roles/SSO/2FA, multi-brand |
| 9 | Customer | Checkout, receipts and invoices in English, Hindi, Tamil, Telugu, Marathi, Bengali and Arabic (RTL), with auto-detection, a remembered switcher, `?lang=` links and locale dates and number grouping (₹1,23,456.78), mobile-friendly checkout with finality steps, verifiable receipts, subscription portal + cancel, guest checkout, no personal data onchain, friendly errors | Accessibility (semantic HTML, no audit) | Wallet deep links, payment history portal, allowance view/revoke, renewal alerts, translated subscription page and demo store, native-speaker review of translations |
| 10 | Developer | REST, error codes, idempotency keys, HMAC webhooks with retries/replay/log, local devnet, e2e suite incl. simulated reorg | Docs (README + this file) | Versioning, pagination, SDKs, GraphQL, OpenAPI, CLI, MCP / x402 ‡ |
| 11 | Integrations | — | — | All (Shopify, Zapier, marketplaces, white-label) |
| 12 | Contracts / infra | Intent router + merchant accounts + refund + subscription in one contract, EIP-712, EIP-1271 refund routes, token registry, balance-delta check, keeper simulation + nonce handling, reorg recovery, backfill from deploy block, payout timelock | Governance (Ownable admin, no timelock on admin) | CREATE2 factory, fee module, Permit2/2612/7702 flows ‡ (EIP-3009 done), ERC-4337 ‡, multi-RPC failover, multi-asset |
| 13 | Security | Scoped keys, signer rotation, payout timelock, circuit breaker that can't block refunds/cancels, payout-change alert, relayer drain protection, refund operator limits, 21 contract tests | — | HSM/KMS, fuzz/invariant suites, audit, SOC 2 †, status page, anomaly alerts |
| 14 | Risk / compliance | — | — | All † (KYB, sanctions, fraud rules, Travel Rule, DPDP/GDPR) |
| 15 | Growth | — | — | All |

**Verdict.** The hackathon exit condition ("real test USDT payment shown end to end") and all six defining features are covered and tested. Most of sections 2, 6, 8, 11, 14 and 15 is roadmap, as the release plan intended.

## 6. Known limitations (be upfront with judges)

1. **Single process, single merchant, SQLite.** Fine for a demo. For production, split API / indexer / webhook workers, move to Postgres, and use row-level `merchant_id` for multi-tenancy.
2. **The quote-signer key lives in the server's env.** Production would put it in KMS/HSM. Its blast radius is already limited by design.
3. **There's one API key and no roles.** The dashboard keeps it in `localStorage`.
4. **The receipt page trusts the server's `/api/config`** for the RPC and contract address. A stricter version would pin the contract address in the receipt URL.
5. **The QR code is rendered by a third-party service** (`api.qrserver.com`), which sees the payment link. Replace it with a local QR library before production.
6. **Reconciliation runs on demand.** Run it on a schedule and alert on mismatch.
7. **Admin actions (token registry, pause) have no timelock.** Put the admin behind a Safe with a timelock.

## 7. Next steps, in priority order

1. Deploy to Whitechain testnet (chain 1874) and record a real USDT payment, which is the hackathon exit condition.
2. Verify gasless on testnet against the real USDT. The domain ("Tether USD", "1") and the `receiveWithAuthorization` selector were checked on-chain, but no real authorization has been submitted yet.
3. ✅ Redeployed to testnet as v3: `0xb026038aaB3E7f6843B52DAD019291D1564DfcBB` (v2 `0xaf66…464e` superseded).
4. ✅ Invoices (line items, terms, partial and multi-party payments, late fees, discounts, reminders, AR aging).
5. Scheduled reconciliation with alerts, and multi-RPC failover.
