# WhitePay web app

Next.js 16 (App Router, TypeScript). The public website, the business console and the operator console. The Express API in `../server` stays the system of record; this app talks to it over HTTP and is the single public entry point (it forwards `/api/*`, the checkout pages and `openapi.json` to the API).

```bash
npm install            # from here, or `npm run web:install` from the repo root
npm run dev            # http://localhost:3001 (needs the API on :3000: run `npm run testnet` in the repo root, which starts both)
npm run build && npm run start
npm run typecheck
```

`API_ORIGIN` (default `http://localhost:3000`) says where the API is. It is baked into the rewrites at build time, so set the same value when building and running.

## Layout

```
app/
  (site)/            public pages: home, pricing, sign-up, sign-in, forgot/reset password, confirm email, invitation
  console/           the business console. One folder per page:
                       page.tsx    server component: fetches data, decides what this role may see
                       Client.tsx  interactive parts (forms, wallet actions); named after what they do when a page has several
  admin/             operator console (platform key)
  auth/              route handlers for sessions: login, signup, logout, expired, accept-invite, switch, public/*
  bff/               proxy for the signed-in person: attaches the session cookie, forwards to /api/*
  bff-admin/         the same for the operator, limited to /api/platform/*
components/          shared UI: ui.tsx (cards, tables, badges), forms, side navigation, QR code, refund button
lib/                 api.ts (server-side client), session.ts (who is signed in, roles), format.ts, wallet.ts, refund.ts, client.ts
proxy.ts             redirects signed-out visitors away from /console and /admin
```

## Conventions
- **No credentials in browser code.** The session lives in an httpOnly cookie. Server components read data with `getJson`; client components call `bff("path")`.
- **Roles decide the page.** A page starts with `requireArea("<area>")`, which redirects people whose role can't open it. `canWrite` says whether to show edit controls. The server enforces the same rules, so hiding a button is never the only protection.
- **Plain language.** Business words (Paid, Awaiting payment), not chain words (finalized, finality). Labels for statuses live in `components/ui.tsx`.
- **Wallet actions** (refunds, plans, split contracts, registering the business) run in the browser with ethers and the person's own wallet.
