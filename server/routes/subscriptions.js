// Subscriptions: list, metrics, refund quote for the unused period, and plan labels.
const { db } = require("../db");
const subscriptions = require("../services/subscriptions");
const { now } = require("../services/clock");
const { auth } = require("../http/auth");
const { paginate, err } = require("../http/helpers");

function mount(app) {
  app.get("/api/subscriptions", auth, (req, res) => {
    const rows = db.prepare("SELECT * FROM subs WHERE merchant_id=? ORDER BY id DESC").all(req.mid).map(subscriptions.toApi);
    res.json(paginate(req, res, req.query.status ? rows.filter((r) => r.status === req.query.status) : rows, (r) => String(r.id)));
  });

  // Suggested refund for the unused part of the current period. The merchant's wallet executes it with refundSubscription().
  app.get("/api/subscriptions/:id/refund-quote", auth, (req, res) => {
    const sub = db.prepare("SELECT * FROM subs WHERE id=? AND merchant_id=?").get(Number(req.params.id), req.mid);
    if (!sub) return err(res, 404, "not_found", "Unknown subscription");
    const last = db.prepare("SELECT amount FROM chain_events WHERE ref=? AND name='SubscriptionCharged' AND status='active' ORDER BY block_number DESC, log_index DESC LIMIT 1").get(`sub:${sub.id}`);
    const refunded = db.prepare("SELECT amount FROM chain_events WHERE ref=? AND name='SubscriptionRefunded' AND status='active'").all(`sub:${sub.id}`).reduce((a, r) => a + BigInt(r.amount), 0n);
    const charged = BigInt(sub.charged || 0), maxRefundable = charged > refunded ? charged - refunded : 0n;
    const t = Number(req.query.at) || now(), periodEnd = sub.next_charge, periodStart = periodEnd - sub.period;
    const unused = !last || t >= periodEnd ? 0 : Math.max(0, Math.min(1, (periodEnd - Math.max(t, periodStart)) / sub.period));
    let suggested = last ? (BigInt(last.amount) * BigInt(Math.round(unused * 1e6))) / 1000000n : 0n;
    if (suggested > maxRefundable) suggested = maxRefundable;
    res.json({ subscriptionId: sub.id, payer: sub.payer, lastCharge: last?.amount || "0", periodStart, periodEnd, unusedFraction: unused,
      suggested: String(suggested), maxRefundable: String(maxRefundable), alreadyRefunded: String(refunded) });
  });
  app.get("/api/subscriptions/metrics", auth, (req, res) => res.json(subscriptions.metrics(req.mid)));
  app.get("/api/plans/all", auth, (req, res) => res.json(db.prepare("SELECT * FROM plans WHERE merchant_id=? ORDER BY id DESC").all(req.mid).map(subscriptions.planApi)));
  // Display name is off-chain metadata (prices and terms live on-chain and can't be edited here).
  app.post("/api/plans/:id/name", auth, (req, res) => {
    const r = db.prepare("UPDATE plans SET name=? WHERE id=? AND merchant_id=?").run(String(req.body?.name || "").slice(0, 80), Number(req.params.id), req.mid);
    if (!r.changes) return err(res, 404, "not_found", "Unknown plan (create it on-chain first)");
    res.json({ ok: true });
  });
}

module.exports = { mount };
