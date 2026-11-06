// Small helpers shared by every route file: errors, JSON replies, pagination, per-IP rate limiting.
const invoices = require("../services/invoices");
const { now } = require("../services/clock");

/** Per-IP token bucket for public endpoints that create work (quotes, requests, faucet mints). */
const buckets = new Map();
const rateLimit = (perMinute) => (req, res, next) => {
  const k = `${req.ip}:${req.route?.path || req.path}`, t = Date.now();
  const b = buckets.get(k) || { tokens: perMinute, at: t };
  b.tokens = Math.min(perMinute, b.tokens + ((t - b.at) / 60000) * perMinute); b.at = t;
  if (b.tokens < 1) { res.set("Retry-After", "10"); return res.status(429).json({ error: { code: "rate_limited", message: "Too many requests; try again shortly" } }); }
  b.tokens -= 1; buckets.set(k, b);
  if (buckets.size > 50000) buckets.clear();
  next();
};
const RL = Number(process.env.PUBLIC_RATE_LIMIT || 30);

/** Cursor pagination over a sorted list: ?limit=1..100 & ?starting_after=<id>. Next cursor in a header so arrays stay arrays. */
function paginate(req, res, rows, idOf) {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 100));
  let start = 0;
  if (req.query.starting_after) { const i = rows.findIndex((r) => idOf(r) === req.query.starting_after); start = i < 0 ? rows.length : i + 1; }
  const page = rows.slice(start, start + limit);
  if (start + limit < rows.length && page.length) res.set("WhitePay-Next-Cursor", idOf(page[page.length - 1]));
  res.set("WhitePay-Has-More", String(start + limit < rows.length));
  return page;
}
const err = (res, status, code, message) => res.status(status).json({ error: { code, message } });

const send = (res, fn) => { try { res.json(fn()); } catch (e) { err(res, e.status || 500, e.code || "internal", e.message); } };
const ownInvoice = (req) => { const inv = invoices.state(req.params.id); return inv && inv.merchantId === req.mid ? inv : null; };
const notFound = (what) => Object.assign(new Error(`Unknown ${what}`), { status: 404, code: "not_found" });

module.exports = { rateLimit, RL, paginate, err, send, notFound, ownInvoice };
