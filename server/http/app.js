// Express app construction: base middleware only. Routes are mounted by server/index.js.
const express = require("express");
const path = require("path");
const API_VERSION = "2026-11-01";
const WEB_ORIGIN = (process.env.WEB_ORIGIN || "").replace(/\/$/, ""); // where the website runs, when it is a separate app

/** The Express app with its base middleware: async error forwarding, /api/v1 aliasing, JSON body (raw kept for HMACs) and /openapi.json. Customer pages live in the web app. */
function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // Express 4 doesn't catch async errors: route every handler's throw/rejection to the JSON error handler.
  for (const m of ["get", "post"]) {
    const orig = app[m].bind(app);
    app[m] = (path, ...hs) => hs.length
      ? orig(path, ...hs.map((h) => (req, res, next) => { try { const r = h(req, res, next); if (r?.catch) r.catch(next); } catch (e) { next(e); } }))
      : orig(path); // app.get(setting)
  }
  // Stable, versioned base path for integrators: /api/v1/* is the documented surface (see /openapi.yaml).
  app.use((req, _res, next) => {
    if (!req.url.startsWith("/api/v1/")) return next();
    req.url = "/api/" + req.url.slice(8);
    // Public names: a "payment" is what the internal routes call an intent.
    const [p, q = ""] = req.url.split("?");
    if (p === "/api/payments" && req.method === "POST") req.url = "/api/intents" + (q ? "?" + q : "");
    else if (/^\/api\/payments\/[^/]+/.test(p)) req.url = p.replace("/api/payments/", "/api/intents/") + (q ? "?" + q : "");
    next();
  });
  // Behind the web app and/or a TLS proxy, the real client is in X-Forwarded-For. Trust private-network hops by default (override with TRUST_PROXY)
  // so per-IP rate limits see visitors, not the proxy.
  app.set("trust proxy", process.env.TRUST_PROXY || "loopback, linklocal, uniquelocal");
  app.use((_req, res, next) => { res.set("WhitePay-Version", API_VERSION); next(); });
  app.use(express.json({ limit: "100kb", verify: (req, _res, buf) => { req.rawBody = buf; } })); // raw bytes kept for webhook HMACs
  // When the website runs as its own app (WEB_ORIGIN), send people who land on the API's address to it instead of a 404 or the old demo page.
  if (WEB_ORIGIN) app.get(/^(\/|\/(console|admin|login|signup|pricing|store|pay|invoice|receipt|portal|subscribe|forgot-password|reset-password|verify-email|invite)(\/.*)?|\/(pay|invoice|receipt|portal|subscribe|index|widget-demo)\.html)$/, (req, res) => res.redirect(302, WEB_ORIGIN + req.originalUrl));
  app.get("/openapi.json", (_req, res) => res.sendFile(path.join(__dirname, "../../docs/openapi.json")));
  app.use(require("../features/saas").gate); // plan limits, per-tenant rate limit, suspension (needs the key, so it looks the tenant up itself)
  return app;
}

module.exports = { createApp, WEB_ORIGIN, API_VERSION };
