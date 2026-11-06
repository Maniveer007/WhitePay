// Payments (called intents internally): create, idempotent retries, and list.
const { db } = require("../db");
const indexer = require("../services/indexer");
const { now } = require("../services/clock");
const { auth } = require("../http/auth");
const { paginate, err } = require("../http/helpers");
const { createIntent } = require("../services/quotes");

function mount(app) {
  app.post("/api/intents", auth, async (req, res) => {
    // Idempotency-Key: a retried request returns the original response instead of a second payment.
    const ik = req.headers["idempotency-key"] && `${req.mid}:${req.headers["idempotency-key"]}`; // keys are per merchant
    if (ik) {
      const hit = db.prepare("SELECT response FROM idempotency WHERE key=?").get(String(ik));
      if (hit) return res.status(200).set("idempotent-replayed", "true").json(JSON.parse(hit.response));
    }
    try {
      const r = await createIntent(req.body, req.m);
      if (ik) db.prepare("INSERT OR IGNORE INTO idempotency(key,response,created_at) VALUES(?,?,?)").run(String(ik), JSON.stringify(r.body), now());
      res.status(r.status).json(r.body);
    } catch (e) { err(res, e.status || 500, e.code || "internal", e.message); }
  });

  app.get("/api/payments", auth, (req, res) => {
    const rows = db.prepare("SELECT * FROM intents WHERE merchant_id=? ORDER BY created_at DESC, rowid DESC LIMIT 5000").all(req.mid).map(indexer.toApi);
    res.json(paginate(req, res, rows, (r) => r.id));
  });
}

module.exports = { mount };
