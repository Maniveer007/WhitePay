// SaaS layer: plans and limits, self-serve signup, per-tenant rate limits, suspension, upgrade-by-payment
// and the operator (platform) console API.
//
// Principles
//  - The tenant's credential is still its API key. No passwords are stored.
//  - Limits stop NEW work (payments, invoices, recurring schedules). They never block a customer paying,
//    refunds, webhooks, or the indexer: money already in flight is always processed.
//  - Suspension is a flag, not a status change: the indexer keeps following the merchant's on-chain payments.
//    A suspended tenant is read-only so it can still export its data.
//  - Upgrades are paid in USDT through WhitePay itself (the platform's own merchant), so the platform dogfoods its product.
const { ethers } = require("ethers");
const { db } = require("../db");
const cfg = require("../config");
const merchants = require("../services/merchants");
const accounts = require("./accounts");
const { now } = require("../services/clock");

// null = unlimited. price is USD per 30 days, paid in USDT.
const DEFAULT_PLANS = {
  free:    { name: "Free",    price: 0,   payments: 100,   invoices: 10,   recurring: 0,   finance: false, rpm: 60 },
  starter: { name: "Starter", price: 29,  payments: 1000,  invoices: 100,  recurring: 5,   finance: true,  rpm: 300 },
  growth:  { name: "Growth",  price: 99,  payments: 10000, invoices: 1000, recurring: 50,  finance: true,  rpm: 1200 },
  scale:   { name: "Scale",   price: 299, payments: null,  invoices: null, recurring: null, finance: true, rpm: 6000 },
};
const PLANS = (() => {
  if (!process.env.PLANS_JSON) return DEFAULT_PLANS;
  try { return JSON.parse(process.env.PLANS_JSON); } catch { console.error("[saas] PLANS_JSON is not valid JSON; using defaults"); return DEFAULT_PLANS; }
})();
const PLATFORM_PLAN = { name: "Platform", price: 0, payments: null, invoices: null, recurring: null, finance: true, rpm: 100000 };
const DAY = 86400, PERIOD = 30 * DAY;

for (const col of ["email TEXT", "plan TEXT DEFAULT 'free'", "plan_until INTEGER", "suspended INTEGER DEFAULT 0", "suspended_reason TEXT"]) {
  try { db.exec(`ALTER TABLE merchants ADD COLUMN ${col}`); } catch {}
}
db.exec(`CREATE TABLE IF NOT EXISTS saas_orders (
  public_id TEXT PRIMARY KEY, uid TEXT, plan TEXT, months INTEGER, amount_usd REAL, status TEXT DEFAULT 'pending', created_at INTEGER, activated_at INTEGER
)`);

const bad = (status, code, message) => Object.assign(new Error(message), { status, code });
const bearer = (req) => (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

/** The plan a tenant is on right now. An expired paid plan falls back to free. */
function effectivePlan(m) {
  if (m.uid === "mer_default") return { id: "platform", ...PLATFORM_PLAN };
  const id = m.plan && PLANS[m.plan] && (m.plan === "free" || (m.plan_until || 0) > now()) ? m.plan : "free";
  return { id, ...PLANS[id] };
}

const monthStart = (t = now()) => { const d = new Date(t * 1000); return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000); };
const monthEnd = (t = now()) => { const d = new Date(t * 1000); return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000); };

/** Usage for the current calendar month (UTC). Payments count when created, so a limit cannot be dodged by not paying. */
function usage(m, t = now()) {
  const from = monthStart(t);
  const mid = m.onchain_id;
  if (mid == null) return { payments: 0, invoices: 0, recurring: 0 };
  return {
    payments: db.prepare("SELECT COUNT(*) n FROM intents WHERE merchant_id=? AND created_at>=?").get(mid, from).n,
    invoices: db.prepare("SELECT COUNT(*) n FROM invoices WHERE merchant_id=? AND created_at>=?").get(mid, from).n,
    recurring: db.prepare("SELECT COUNT(*) n FROM recurring_invoices WHERE merchant_id=? AND status='active'").get(mid).n,
  };
}

const planView = (id, p) => ({ id, name: p.name, priceUsd: p.price, limits: { paymentsPerMonth: p.payments, invoicesPerMonth: p.invoices, recurringSchedules: p.recurring, requestsPerMinute: p.rpm }, finance: p.finance });

function usageView(m) {
  const p = effectivePlan(m), u = usage(m);
  return {
    plan: planView(p.id, p), planUntil: p.id === "free" || p.id === "platform" ? null : m.plan_until,
    period: { from: monthStart(), to: monthEnd() }, usage: u,
    remaining: { payments: p.payments == null ? null : Math.max(0, p.payments - u.payments), invoices: p.invoices == null ? null : Math.max(0, p.invoices - u.invoices),
      recurring: p.recurring == null ? null : Math.max(0, p.recurring - u.recurring) },
    suspended: !!m.suspended, suspendedReason: m.suspended ? m.suspended_reason : null,
  };
}

// ───────── Per-tenant request rate limit (token bucket, per minute, by plan) ─────────
const buckets = new Map();
function takeToken(uid, rpm) {
  const t = Date.now(), b = buckets.get(uid) || { tokens: rpm, at: t };
  b.tokens = Math.min(rpm, b.tokens + ((t - b.at) / 60000) * rpm); b.at = t;
  if (b.tokens < 1) { buckets.set(uid, b); return false; }
  b.tokens -= 1; buckets.set(uid, b);
  if (buckets.size > 20000) buckets.clear();
  return true;
}

const limitError = (res, what, p, used) => res.status(402).json({ error: { code: "plan_limit_exceeded",
  message: `Your ${p.name} plan allows ${p[what]} ${what} per ${what === "recurring" ? "account" : "month"} (${used} used). Upgrade at POST /api/v1/saas/upgrade.`,
  limit: what, plan: p.id, upgrade: "/api/v1/saas/upgrade" } });

/** Runs before every /api route. Looks the tenant up from its key itself, because the route's own auth runs later. */
function gate(req, res, next) {
  if (!req.path.startsWith("/api/")) return next();
  const k = bearer(req);
  if (!k) return next();
  if (req.path.startsWith("/api/account/")) return next(); // signing in, out and managing your own account must work even on a limited or suspended plan
  const sess = k.startsWith("wps_") ? accounts.resolveSession(k) : null;
  const m = sess ? merchants.byUid(sess.merchantUid) : merchants.byApiKey(k) || merchants.byAuditorKey(k);
  if (!m) return next(); // the route's auth answers 401
  const p = effectivePlan(m);
  res.set("WhitePay-Plan", p.id);
  if (!takeToken(m.uid, p.rpm)) { res.set("Retry-After", "5"); return res.status(429).json({ error: { code: "rate_limited", message: `Rate limit for the ${p.name} plan is ${p.rpm} requests per minute` } }); }
  if (m.suspended && req.method !== "GET") return res.status(403).json({ error: { code: "account_suspended", message: "This account is suspended and read-only" + (m.suspended_reason ? `: ${m.suspended_reason}` : "") } });
  if (req.method === "POST") {
    const path = req.path;
    if (path === "/api/intents" && p.payments != null) { const n = usage(m).payments; if (n >= p.payments) return limitError(res, "payments", p, n); }
    else if (path === "/api/invoices" && p.invoices != null) { const n = usage(m).invoices; if (n >= p.invoices) return limitError(res, "invoices", p, n); }
    else if (path === "/api/recurring-invoices" && p.recurring != null) { const n = usage(m).recurring; if (n >= p.recurring) return limitError(res, "recurring", p, n); }
  }
  if (!p.finance && /^\/api\/(statements|periods|auditor-key)/.test(req.path))
    return res.status(402).json({ error: { code: "plan_feature", message: `Statements, period close and the auditor key need a paid plan (you are on ${p.name})`, upgrade: "/api/v1/saas/upgrade" } });
  next();
}

// ───────── Upgrade by payment ─────────
/** Activate every upgrade whose payment has reached the finality the platform requires. Safe to call repeatedly. */
function sweep() {
  const rows = db.prepare("SELECT * FROM saas_orders WHERE status='pending'").all();
  for (const o of rows) {
    const i = db.prepare("SELECT fulfillable, finality FROM intents WHERE public_id=?").get(o.public_id);
    if (!i) continue;
    if (i.finality === "reorged") continue;
    if (!i.fulfillable) continue;
    const m = merchants.byUid(o.uid);
    if (!m) continue;
    const base = m.plan === o.plan && (m.plan_until || 0) > now() ? m.plan_until : now(); // renewing the same plan extends it
    db.prepare("UPDATE merchants SET plan=?, plan_until=? WHERE uid=?").run(o.plan, base + o.months * PERIOD, o.uid);
    db.prepare("UPDATE saas_orders SET status='active', activated_at=? WHERE public_id=?").run(now(), o.public_id);
    buckets.delete(o.uid); // the new plan's rate limit applies immediately
  }
}

function mount(app) {
  const { err, send, rateLimit } = require("../http/helpers");
  const { auth, platform } = require("../http/auth");
  const { createIntent } = require("../services/quotes");
  setInterval(() => { try { sweep(); } catch (e) { console.error("[saas] sweep", e.message); } }, 15000).unref();

  // Public: plans and whether signup is open (drives the pricing/signup page).
  app.get("/api/saas/plans", (_req, res) => res.json({ signupOpen: process.env.SIGNUP_OPEN === "1",
    plans: Object.entries(PLANS).map(([id, p]) => planView(id, p)), currency: "USDT", periodDays: 30 }));

  // Tenant: plan, limits and usage for this month.
  app.get("/api/saas/usage", auth, (req, res) => { try { sweep(); } catch {} res.json(usageView(req.m)); });

  // Tenant: buy or renew a plan. Returns a normal WhitePay checkout; the plan activates when the payment is final.
  app.post("/api/saas/upgrade", auth, async (req, res) => {
    try {
      if (req.readOnly) throw bad(403, "read_only", "Read-only key");
      if (req.m.uid === "mer_default") throw bad(400, "platform_account", "The platform account has no plan");
      const plan = String(req.body?.plan || ""), months = Math.min(12, Math.max(1, Number(req.body?.months) || 1));
      if (!PLANS[plan] || !(PLANS[plan].price > 0)) throw bad(400, "invalid_plan", `plan must be one of ${Object.keys(PLANS).filter((k) => PLANS[k].price > 0).join(", ")}`);
      const price = PLANS[plan].price * months;
      const ref = `saas_${req.m.uid}_${plan}_${Date.now()}`;
      const r = await createIntent({ amount: price, currency: "USD", orderRef: ref, description: `WhitePay ${PLANS[plan].name} plan, ${months} month${months > 1 ? "s" : ""} (${req.m.uid})`, policy: process.env.SAAS_UPGRADE_POLICY || "safe" },
        merchants.byUid("mer_default"));
      db.prepare("INSERT INTO saas_orders(public_id,uid,plan,months,amount_usd,created_at) VALUES(?,?,?,?,?,?)").run(r.body.id, req.m.uid, plan, months, price, now());
      res.status(201).json({ plan, months, priceUsd: price, paymentId: r.body.id, checkoutUrl: r.body.checkoutUrl,
        note: "The plan activates automatically once the payment is confirmed." });
    } catch (e) { err(res, e.status || 500, e.code || "internal", e.message); }
  });

  // ───────── Operator console ─────────
  const tenantView = (m) => ({ ...merchants.publicView(m), email: m.email, plan: effectivePlan(m).id, planUntil: m.plan_until || null, suspended: !!m.suspended, suspendedReason: m.suspended_reason || null, usage: usage(m) });

  app.get("/api/platform/tenants", platform, (_req, res) => res.json(db.prepare("SELECT * FROM merchants WHERE uid<>'mer_default' ORDER BY created_at DESC").all().map(tenantView)));

  app.get("/api/platform/overview", platform, (_req, res) => {
    const all = db.prepare("SELECT * FROM merchants WHERE uid<>'mer_default'").all();
    const byPlan = {}; let mrr = 0, pending = 0, suspended = 0;
    for (const m of all) {
      const p = effectivePlan(m);
      byPlan[p.id] = (byPlan[p.id] || 0) + 1; mrr += p.price;
      if (m.status !== "active") pending++;
      if (m.suspended) suspended++;
    }
    const from = monthStart();
    const paid = db.prepare("SELECT amount FROM intents WHERE created_at>=? AND payer IS NOT NULL AND finality<>'reorged' AND merchant_id IS NOT (SELECT onchain_id FROM merchants WHERE uid='mer_default')").all(from);
    const volume = paid.reduce((a, r) => a + BigInt(r.amount), 0n);
    res.json({ tenants: all.length, byPlan, pendingOnchain: pending, suspended, mrrUsd: mrr,
      thisMonth: { from, paidPayments: paid.length, volumeUsdt: ethers.formatUnits(volume, 6) },
      pendingUpgrades: db.prepare("SELECT COUNT(*) n FROM saas_orders WHERE status='pending'").get().n, signupOpen: process.env.SIGNUP_OPEN === "1" });
  });

  const tenant = (req) => { const m = merchants.byUid(req.params.uid); if (!m || m.uid === "mer_default") throw bad(404, "not_found", "Unknown tenant"); return m; };
  app.post("/api/platform/tenants/:uid/suspend", platform, (req, res) => send(res, () => {
    const m = tenant(req);
    db.prepare("UPDATE merchants SET suspended=1, suspended_reason=? WHERE uid=?").run(String(req.body?.reason || "").slice(0, 200) || null, m.uid);
    return tenantView(merchants.byUid(m.uid));
  }));
  app.post("/api/platform/tenants/:uid/resume", platform, (req, res) => send(res, () => {
    const m = tenant(req);
    db.prepare("UPDATE merchants SET suspended=0, suspended_reason=NULL WHERE uid=?").run(m.uid);
    return tenantView(merchants.byUid(m.uid));
  }));
  // Grant a plan without payment (comps, annual contracts invoiced elsewhere, support fixes).
  app.post("/api/platform/tenants/:uid/plan", platform, (req, res) => send(res, () => {
    const m = tenant(req), plan = String(req.body?.plan || "");
    if (!PLANS[plan]) throw bad(400, "invalid_plan", `plan must be one of ${Object.keys(PLANS).join(", ")}`);
    const days = Math.min(3650, Math.max(1, Number(req.body?.days) || 30));
    db.prepare("UPDATE merchants SET plan=?, plan_until=? WHERE uid=?").run(plan, plan === "free" ? null : now() + days * DAY, m.uid);
    buckets.delete(m.uid);
    return tenantView(merchants.byUid(m.uid));
  }));
}

module.exports = { mount, gate, sweep, effectivePlan, usage, usageView, PLANS };
