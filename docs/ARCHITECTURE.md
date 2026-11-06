# WhitePay: architecture and who uses what

## 1. Who uses WhitePay, and how they get in

| Person | What they do | Where they go | How they sign in |
|---|---|---|---|
| **Business owner / manager** | Sets up the business, invites the team, watches money in and out, manages the plan | `/console` | Email + password (+ authenticator code if they turned on two-step) |
| **Finance / accountant** | Invoices, credit notes, refunds, statements, period close, the ledger | `/console` (Reports, Ledger, Invoices) | Email + password, role **Finance** (or **Viewer** for an outside auditor) |
| **Support agent** | Looks up payments, creates payment links, handles refund requests, sends invoice reminders | `/console` (Payments, Refunds, Customers) | Email + password, role **Support** |
| **Developer** | Connects a website or app: API keys, webhooks, SDKs, CLI, test clock | `/console/developers`, `/openapi.json`, `sdks/`, `cli/` | Email + password for the console; an **API key** (created there) for code |
| **Customer (payer)** | Pays a link or invoice, gets a receipt, requests a refund, manages subscriptions and allowances | `/pay`, `/invoice`, `/receipt`, `/portal`, `/subscribe` (the old `.html` addresses still work) | **No account.** Their own wallet identifies them. Pages are in 7 languages |
| **Platform operator** | Runs the deployment: tenants, plans, usage, suspension, first-owner invites | `/admin` | The platform key (`PLATFORM_KEY`), short sessions |
| **AI agent** | Pays for things within limits its owner set | MCP server (`mcp/`), x402 paywalls | A wallet key governed by an onchain spending policy |

**API keys are for code, not people.** Nobody has to see or paste one to use the product. People have accounts; a developer creates an API key in *Developers* when they connect a site.

### What each role can do (enforced by the server, not just hidden in the menu)

| Area | Owner | Admin | Finance | Support | Developer | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Payments and payment links | edit | edit | view | edit | edit | view |
| Invoices, credit notes, recurring | edit | edit | edit | view (can remind) | edit | view |
| Subscriptions and plans | edit | edit | view | view | view | view |
| Refunds and refund operators | edit | edit | edit | edit | view | view |
| Reports, statements, period close | edit | edit | edit | – | – | view |
| Ledger, reconciliation, exceptions | edit | edit | edit | – | view | view |
| Marketplace payouts | edit | edit | view | – | – | view |
| Customers | view | view | view | view | view | view |
| Business settings and alerts | edit | edit | view | view | view (webhook URL only) | view |
| API keys and webhooks | edit | edit | – | – | edit | – |
| Team and roles | edit | edit | – | – | – | – |
| Plan and billing | edit | view | – | – | – | – |
| Activity log | view | view | – | – | – | – |

Other rules: only an owner can create or remove an owner; a business always keeps at least one owner; changing someone's role or removing them signs them out immediately; email confirmation is off by default so the product is easy to try (set `REQUIRE_EMAIL_VERIFICATION=1` to require a confirmed email before inviting people, creating API keys or paying for a plan). Invitations return a link the inviter can copy, so no email is needed to onboard a teammate. Every change is recorded in the **activity log** (who, what, when, from where; never passwords or keys).

Moving money onchain (refunds, plan creation, split contracts) is signed with the person's **own wallet** in the browser. The server never holds those keys, so the contract's own limits (refund operator limits, payout timelock) apply on top of the role.

## 2. System overview

```
 browser ──► web (Next.js :3001) ──► server/ API (Express :3000) ──► SQLite + Whitechain RPC
              website, console,        payments, indexer, keeper,
              operator console         webhooks, accounts, plans
              /bff proxy ─ attaches the session; /api/* and checkout pages are forwarded to the API

 customers ─► /pay, /invoice, /receipt, /portal, /subscribe, /store (Next.js pages in 7 languages; the old /pay.html style URLs are rewritten to them, so payment links, emails, the widget and plugins keep working)
 developers ► REST /api/v1 + OpenAPI, SDKs (TS, Python, Go, Ruby, Java, PHP), CLI, MCP server, webhooks
 contracts/ ► WhitePay (core), WhitePayAgent, WhitePayMetered, PayoutSplitter (Solidity, Hardhat)
```

The chain is the source of truth for money. The indexer follows contract events into an append-only double-entry ledger (reorg-safe), and reconciliation re-derives totals from raw logs to prove they match.

## 3. Repository map

```
contracts/            Solidity contracts (Hardhat)
server/               The API
  index.js              boot only: mounts routes, starts the indexer
  config.js db.js       environment and SQLite
  http/                 Express plumbing: app.js (base middleware), auth.js (who is calling), helpers.js, errors.js
  routes/               one file per API area, each exports mount(app): public, payments, invoices, refunds, relay,
                        subscriptions, ledger, notifications, merchants, webhooks, extensions
  services/             business logic and integrations, no Express: indexer, invoices, recurring, subscriptions,
                        finance, files, merchants, notify, webhooks, clock, quotes, refunds, relayer
  features/             modules that own both logic and routes: accounts (people & access), saas (plans & limits)
web/                  Next.js 16 app (TypeScript): every page people see
  app/(site)/           public pages: home, pricing, sign-up, sign-in, reset password, confirm email, invitation
  app/(customer)/       what payers see, in 7 languages: pay, invoice, receipt, portal, subscribe, store, widget-demo
  public/               widget.js (the embeddable script), service worker, manifest, icons, offline page
  app/console/          the business console, one folder per page (page.tsx = server component, Client.tsx = interactive parts)
  app/admin/            operator console
  app/auth, bff, bff-admin   route handlers: sessions in httpOnly cookies, and the proxy that attaches them
  components/           shared UI (ui.tsx primitives, forms, side nav)
  lib/                  api client, session and roles, formatting, wallet and refund helpers, i18n/ (messages.json + translator)
sdks/                 client libraries, React/Vue components
plugins/woocommerce/  WooCommerce gateway
cli/ mcp/             command-line tool and AI-agent (MCP) server
scripts/              operations: deploy, demo, build-openapi, build-i18n-pages, check-network
tests/                contracts/ (Hardhat), e2e/ (against a running stack), checks/ (i18n, openapi), run-all.sh
docs/                 this file, BUSINESS_COVERAGE.md (what is built and what isn't), SYSTEM_DESIGN.md (deep design), openapi.json (the API spec, served at /openapi.json)
```

### Rules of thumb for adding code
- A new endpoint goes in the `routes/` file for its area (or a new file mounted in `server/index.js`). Keep routes thin; put logic in `services/`.
- Anything that needs the caller's identity uses `auth` from `http/auth.js`. Add the path to `ROUTES` in `features/accounts.js` so roles apply to it.
- A new console page is a folder under `web/app/console/<name>/` and a line in the `section(...)` list in `console/layout.tsx` with the area it needs.
- Every behaviour change ships with a check in `tests/`. `tests/run-all.sh` runs everything from a clean state.

## 4. Sign-in and sessions

- People: `POST /api/account/login` returns an opaque session token (stored hashed, 30 days, 14 days idle). The web app keeps it in an **httpOnly, SameSite=Strict cookie**; page code never sees it, and browser actions go through `/bff/*`, which adds it. Writes also pass an Origin check.
- Passwords: scrypt, at least 10 characters, common passwords and names/emails rejected, five wrong attempts lock the account for 15 minutes, and an unknown email gets the same answer and timing as a wrong password.
- Two-step: optional TOTP (RFC 6238, any authenticator app) with one-time recovery codes.
- Resetting or changing a password signs out other devices. People can see and end their own sessions.
- API keys: stored as SHA-256 hashes, shown once, rotatable. An API key acts as a developer for that business's data and can't read people or the activity log.
- Email: verification, reset and invitation links are sent through the notification outbox (Resend when configured; otherwise logged, and readable at `/api/dev/mailbox` on the local chain).
