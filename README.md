# WhitePay — non-custodial USDT business payments on Whitechain
ETHGlobal Mumbai · Whitechain track. Phase-1 scope of the product doc: checkout, API/SDK-style intents, webhooks,
merchant-selected finality, refunds, subscriptions, verifiable receipts, double-entry ledger, reconciliation, CSV export, dashboard.

## What's enforced on-chain (`contracts/WhitePay.sol`)
- **Exact, expiring, signed quotes** (EIP-712). Tampering with the amount invalidates the signature.
- **Non-custodial**: payer → merchant payout wallet directly; balance-delta check rejects fee-on-transfer tokens.
- **Refunds capped at amount paid**, only by merchant owner/refunders; payer-signed (EIP-712/1271) alternate address for blacklisted payers.
- **Subscriptions**: payer sets amount, period, end and lifetime cap; any keeper can charge; payer cancels without the merchant.
- **Stolen API key can't redirect funds**: the key is only a quote signer. Payout change is owner-only and timelocked.

## Off-chain
Express API · indexer (confirmations → seen/safe/finalized, reorg detection + ledger reversal) · HMAC webhooks with retries/replay ·
append-only double-entry ledger linked to tx hash + log index · chain-vs-ledger reconciliation · receipts that re-verify from the browser via RPC.

## Run it
Everything runs against the **Whitechain testnet** (chain 1874, Sepolia-settled). There is no local chain.
```bash
npm run web:install          # once
npm run testnet              # API :3000 + website :3001, talking to the testnet RPC and the contracts in data-testnet/
```
Open http://localhost:3001. The header badge says **Testnet**. Your wallet needs a little testnet WBT for gas (the app adds the network to MetaMask); test USDT comes from the **Get 500 test USDT** button on checkout. The first run generates the keeper and relayer keys, funds them from the deployer, and adds `MERCHANT_SECRETS_KEY`, `PLATFORM_KEY` and the first owner login to `.env.testnet`: back that file up.

```bash
npm run deploy:testnet       # fresh contracts + a mintable test USDT (unset TOKEN_ADDRESS in .env.testnet)
npm run test:all             # every automated check, on the testnet
npm test                     # contract rules (in-memory EVM: no node, no network; covers 30-day timers)
```
The test USDT is a mintable token with the same 6 decimals and gasless-signature support as the real one, because the testnet's own Tether has no faucet. To run on the real testnet USDT instead, set `TOKEN_ADDRESS` to it and redeploy; payments then need real testnet USDT from a wallet that holds some.

**Testing on a public chain:** "safe" and "finalized" take about 8 and 37 minutes, so tests use the fast "seen" level. The blockchain's own clock can't be moved, so contract timers in tests are short (subscription periods of 20s, a 60s payout delay, a 40s splitter hold). The optional off-chain test clock (`TEST_CLOCK=1`) only moves invoice and reminder time. Reorgs can't be forced on a public chain.

## Whitechain testnet / mainnet
Testnet settings live in `.env.testnet` (git-ignored, data in `data-testnet/`), so the local demo is unaffected.
```bash
npm run check:testnet    # RPC, chain ID, deployer WBT balance, token checks
npm run deploy:testnet   # deploys WhitePay against the real testnet USDT
npm run start:testnet    # server + indexer on http://localhost:3000
```
**Live deployment (Whitechain testnet, chain 1874)**: v5, the current version (v4 plus `refundSubscription` for subscription refunds)
- WhitePay: [`0x508f49C01576dAFbf6699DE471121b8Bb8Ea7308`](https://explorer.testnet.whitechain.io/address/0x508f49C01576dAFbf6699DE471121b8Bb8Ea7308) (deploy block 12306401)
- WhitePayAgent `0x7FcC2D0D420B057C811e976800057d470d15A6B0`, WhitePayMetered `0xBc8FA37558788d4452fb86B87f24e946Fdae44B7`. `PayoutSplitter` is created per seller (Console → Marketplace, or `scripts/deploy-splitter.js`); none is deployed on testnet.
- Superseded: v4 `0x523D0005a979b1B72881980C339284E7e35f13A4`, v3 `0xb026038aaB3E7f6843B52DAD019291D1564DfcBB`, v2 `0xaf66C49aaD4053705dFCAb9f276f7ac7d166464e`, v1 `0x7D5d7cE0Bdc2ED8e24f473c6E17ACD7791220405`
- Token: USDT [`0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`](https://explorer.testnet.whitechain.io/address/0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7)
- Merchant #1 owner and payout: `0xAFE08919dAC82E79ae274eb94441AA2447Bb13b6`. Quote signer is a separate key, `0x3B88b81DCEB395e0de1659C93eEd700536913BB2`. Payout timelock: 300s.
- `scripts/deploy.js` refuses to deploy if the quote signer key equals the owner key.
- v3/v4 server smoke test against testnet: config, plans, usage and extensions endpoints answer in SaaS mode. No test payment was made with real testnet USDT (the deployer holds 0 USDT).
- v3 dry runs: `createPlan` works (would create plan #1), `subscribeToPlan` on a missing plan is rejected, payment stops only at the empty balance.
- Dry runs against the real token (v1 and v2): wallet pay and gasless pay both pass every WhitePay and signature check and stop only at "transfer amount exceeds balance". A gasless signature for a different quote is rejected by the token ("TetherToken: invalid signature"). Tampered amounts are rejected with `BadSigner`.

Verified on-chain (Nov 2026):
- Testnet chain ID **1874** (`https://rpc.ankr.com/whitechain_testnet`), mainnet **1875** (`https://rpc.whitechain.io`). OP Stack, WBT gas.
- USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`: "Tether USD", **6 decimals**, upgradeable proxy, supports **EIP-2612 permit** and EIP-3009.
- Permit2 and ERC-4337 EntryPoint v0.6/v0.7 are deployed on testnet.
- Finality on testnet/mainnet uses the RPC `safe` / `finalized` block tags (~8 min / ~37 min behind head on testnet), not confirmation counts.

## Embeddable checkout
`<script src="https://YOUR-HOST/widget.js" async></script>` + `<button data-whitepay-payment="pay_…">`, or `WhitePay.checkout(id, { mode: "modal", onPaid })`. Demo at `/widget-demo.html`.

## Multi-merchant
Set `PLATFORM_KEY` and `MERCHANT_SECRETS_KEY`, then `POST /api/v1/platform/merchants`. Each merchant gets its own API key, quote signer, webhook secret and branding. The merchant registers on-chain with its own owner wallet, and WhitePay links the two automatically.

## Run it as a SaaS
One server hosts many businesses (tenants). People sign in with **email and password** and have a **role**; API keys are for developers' code. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for who uses what, the role table, and the repository map.

- **API** (`server/`, Express): payments, indexer, keeper, webhooks, accounts and plans. No HTML: it serves JSON and `/openapi.json`.
- **Web app** (`web/`, Next.js 16, TypeScript): every page. The website (`/`, `/pricing`), sign-up and sign-in, the business **console** (`/console/*`), the **operator console** (`/admin`), and the pages **customers** use (checkout `/pay`, `/invoice`, `/receipt`, `/portal`, `/subscribe`, `/store`) in 7 languages. The old `/pay.html`-style URLs are rewritten to them, so existing payment links, emails, the widget and the WooCommerce plugin keep working. It is the public entry point: `/api/*` is forwarded to the API, so one origin serves everything.

```bash
npm run testnet              # see "Run it" above. Then open http://localhost:3001
#   first owner login for the platform's own business: BOOTSTRAP_OWNER_EMAIL / BOOTSTRAP_OWNER_PASSWORD in .env.testnet
#   operator console: /admin with PLATFORM_KEY from .env.testnet
#   emails (confirm, reset, invite) are readable at http://localhost:3000/api/dev/mailbox?to=<email> while DEV_MAILBOX=1 (set by `npm run testnet`)
```

**For people (owners, finance, support, auditors)**
- **Sign up** with a business name, your name, email and password (`SIGNUP_OPEN=1`). Confirm your email from the link we send. Then connect your payout wallet: one step in the console, or "Activate demo account" on a local chain.
- **Team and roles:** Owner, Admin, Finance, Support, Developer, Viewer. Invite by email; roles are enforced by the server. Changing a role or removing someone signs them out at once. One person can belong to several businesses (an accountant) and switch between them.
- **Security:** two-step sign-in with any authenticator app (plus recovery codes), password reset by email, lockout after repeated wrong passwords, a list of signed-in devices you can end, and an **activity log** of who did what.
- **Plain-language console:** payment links with a QR code and WhatsApp/email sharing, invoices, customers, refunds, reports with Excel/PDF/Xero/QuickBooks export, business profile and alert recipients (email, WhatsApp, Slack, Telegram), all without touching code.

**For developers**
- **API keys and webhooks** live in *Developers* (owner, admin and developer roles). Keys are shown once and can be replaced. The REST API is documented at `/openapi.json`; there are SDKs in six languages, a CLI that forwards webhooks to localhost, and a test clock.

**For the platform operator**
- **Plans and limits:** Free, Starter ($29), Growth ($99), Scale ($299) per 30 days, paid in USDT. Plans cap payments, invoices and recurring schedules per month and API requests per minute, and gate statements, period close and the auditor key (override with `PLANS_JSON`). Over a limit the API answers `402 plan_limit_exceeded`. Limits only stop *new* work: customers can always pay, and refunds, webhooks and indexing never stop. Upgrades are paid in USDT through WhitePay itself and activate automatically.
- **Operator console:** `/admin` with `PLATFORM_KEY`: tenants, plans, usage, MRR, volume, suspend/resume, grant a plan, invite a tenant's first owner. Suspending makes a tenant read-only; its on-chain payments are still indexed.
- **Test-only settings** (set by `npm run testnet`; leave unset in production): `DEV_MAILBOX` (read emails over HTTP), `TEST_CLOCK` (off-chain time only), `SAAS_UPGRADE_POLICY=seen`, `WEB_ORIGIN`. Real deployments configure email (`RESEND_API_KEY`, `EMAIL_FROM`) and set `BOOTSTRAP_OWNER_EMAIL/PASSWORD` for the first owner.
- **Deploy:** `docker compose up -d` runs `web` (public, port 3000) and `whitepay` (the API, internal). Put TLS in front of `web` with a proxy that sets `X-Forwarded-For`. Set `PUBLIC_URL` to the public address (links in emails use it), and configure `RESEND_API_KEY` + `EMAIL_FROM`, or no email will actually be sent. `API_ORIGIN` must match at build and run time. Back up `./data`.
- **Not included yet:** card or fiat billing for plans, sign-in with Google or a company directory (SSO), Postgres (SQLite means one node), translations of the web app (the checkout pages are in 7 languages; the website and console are English), and hosted/managed deployment.

## Repository layout
`contracts/` Solidity · `server/` API (`http/`, `routes/`, `services/`, `features/`) · `web/` Next.js site and consoles · `sdks/` `cli/` `mcp/` `plugins/` integrations · `scripts/` operations (deploy, demo, builds) · `tests/` all automated checks · `docs/`. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## API and SDKs
Versioned REST API at `/api/v1` with an OpenAPI spec at [`/openapi.json`](docs/openapi.json). SDKs for TypeScript, Python, Go, Ruby, Java and PHP are in [`sdks/`](sdks/README.md).

## Extensions
- **Recurring invoices and credit notes**: `POST /api/v1/recurring-invoices` (weekly to yearly schedules, calendar-aware, no back-billing after a pause), `POST /api/v1/invoices/{id}/credit-notes`.
- **Payer portal and PWA**: `/portal` shows a wallet's payments, subscriptions, USDT allowances (one-click revoke), usage meters and AI-agent policies, straight from the chain. Installable, offline shell, wallet deep links (MetaMask, Trust, Coinbase, Rainbow) on checkout.
- **Finance**: `GET /api/v1/statements?format=xlsx|pdf|csv|xero|quickbooks`, period close with snapshot hash and drift detection, read-only auditor key (`POST /api/v1/auditor-key`). Console → Finance.
- **Developer tools**: `cli/whitepay.js` (`whitepay listen --forward-to http://localhost:4242/hook` forwards signed webhooks; `whitepay clock advance --days 30` is a test clock for the local chain, enabled by `TEST_CLOCK=1`, set by `npm run demo`).
- **Embeds and plugins**: `sdks/react`, `sdks/vue` (pay button around `widget.js`), `plugins/woocommerce` (not yet run in a live WordPress).
- **Marketplace money flows** (`contracts/PayoutSplitter.sol`): platform fee and other splits paid immediately, seller share held for a dispute window, then released. Immutable rules, set as the seller's payout wallet. Console → Marketplace creates one from the seller's wallet and manages it (split, release, return held funds); set `PLATFORM_FEE_WALLET` / `PLATFORM_FEE_BPS` to suggest a fee to every new seller. CLI route: `scripts/deploy-splitter.js`.
- **Refunds beyond payments:** credit notes on paid invoices return a refund plan with one-click execution; subscription refunds (`refundSubscription`) with a prorated suggestion at `GET /api/v1/subscriptions/{id}/refund-quote`.
- **Seat and usage billing** (`contracts/WhitePayMetered.sol`): the payer fixes the seat price, unit price, per-period usage budget and lifetime cap; the contract enforces them. `POST /api/v1/meters/{id}/usage` reports usage idempotently.
- **AI agents** (`contracts/WhitePayAgent.sol`, `mcp/server.js`): an owner grants an agent address a per-payment limit, daily limit, expiry and optional merchant allowlist; the agent pays from the owner's wallet, refunds go back to the owner. The MCP server exposes payment/invoice tools and an x402 client (`fetch_paid_resource`); `GET /api/v1/x402/demo` is a paywalled example (HTTP 402 with a signed quote).
```bash
npm test                 # 64 contract tests, in-memory (34 core + 30 extensions)
node tests/e2e/extensions.js # extension e2e on the testnet
node tests/e2e/saas.js # SaaS layer e2e: signup, limits, gates, suspension, upgrade by payment
node tests/e2e/accounts.js # people and access: accounts, roles, invitations, 2FA, audit log
node tests/e2e/web.js # web app: gating, cookies, CSRF, proxy, signup, roles in the console, reset, invitations
node tests/e2e/cli-mcp.js
```

## Coverage and design
Coverage against business needs is in [docs/BUSINESS_COVERAGE.md](docs/BUSINESS_COVERAGE.md).
See [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md). It covers architecture, the payment state machine, every failure mode and its handling, a feature-by-feature coverage matrix against the full spec, known limitations, and next steps.
