// WhitePay API server: boots the app and mounts every route area. Structure:
//   http/      Express plumbing: app construction, auth, shared helpers, error handlers
//   routes/    one file per API area; each exports mount(app)
//   services/  business logic and integrations (no Express): indexer, invoices, subscriptions, finance, notify, webhooks…
//   features/  self-contained modules that own both their logic and routes: accounts (people & access), saas (plans & limits)
const cfg = require("./config"); // first: loads the env file (DATA_DIR) before the DB opens
const merchants = require("./services/merchants");
const indexer = require("./services/indexer");
const invoices = require("./services/invoices");
const notify = require("./services/notify");
const { createApp, WEB_ORIGIN } = require("./http/app");
const { installErrorHandlers } = require("./http/errors");

merchants.bootstrap();
const app = createApp();

// Order matters where paths overlap (e.g. /invoices/aging before /invoices/:id), so keep this list in the order routes were designed.
for (const area of ["public", "payments", "invoices", "refunds", "relay", "subscriptions", "ledger", "notifications", "merchants", "webhooks"]) require(`./routes/${area}`).mount(app);
require("./features/saas").mount(app);
require("./features/accounts").mount(app);
require("./routes/extensions").mount(app);
installErrorHandlers(app); // last, so every route above is reachable

// A rejected promise in an async route must not kill the process (Node exits on unhandled rejections).
process.on("unhandledRejection", (e) => console.error("[unhandled]", e?.message || e));

// Background jobs
setInterval(() => { try { invoices.remindDue(); } catch (e) { console.error("[invoices]", e.message); } }, 60_000);
setInterval(() => { try { require("./services/recurring").run(cfg.rates); } catch (e) { console.error("[recurring]", e.message); } }, 30_000);

app.listen(cfg.port, () => {
  console.log(`WhitePay API on http://localhost:${cfg.port}   API key: ${cfg.apiKey}`);
  if (WEB_ORIGIN) console.log(`Website and console: ${WEB_ORIGIN}`);
  indexer.start();
  notify.start();
});
