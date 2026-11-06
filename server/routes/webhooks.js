// Outgoing webhooks: delivery log and replay, plus a built-in demo receiver that verifies signatures the way a merchant should.
const crypto = require("crypto");
const cfg = require("../config");
const { db } = require("../db");
const wh = require("../services/webhooks");
const { now } = require("../services/clock");
const { auth } = require("../http/auth");
const { err } = require("../http/helpers");

function mount(app) {
  app.get("/api/webhooks", auth, (req, res) => {
    res.json(db.prepare("SELECT id,event_id,type,created_at,attempts,status,last_status,last_error FROM webhooks WHERE merchant_id=? ORDER BY id DESC LIMIT 100").all(req.mid));
  });
  app.post("/api/webhooks/:id/replay", auth, (req, res) => {
    if (!db.prepare("SELECT 1 FROM webhooks WHERE id=? AND merchant_id=?").get(Number(req.params.id), req.mid)) return err(res, 404, "not_found", "Unknown webhook delivery");
    wh.replay(Number(req.params.id)); res.json({ ok: true });
  });

  // Built-in demo receiver that verifies the HMAC the same way a merchant should.
  const received = [];
  app.post("/api/_demo_webhook", (req, res) => {
    // Same rules as every SDK's Webhook.verify: raw body, timestamp tolerance, constant-time compare, any v1 may match.
    const parts = String(req.headers["x-whitepay-signature"] || "").split(",").map((p) => p.trim().split("="));
    const t = Number(parts.find(([k]) => k === "t")?.[1]);
    const expect = crypto.createHmac("sha256", cfg.webhookSecret).update(`${t}.${req.rawBody || ""}`).digest();
    const valid = Number.isFinite(t) && Math.abs(now() - t) <= 300 && parts.some(([k, v]) => k === "v1" && /^[0-9a-f]{64}$/.test(v || "")
      && crypto.timingSafeEqual(Buffer.from(v, "hex"), expect));
    received.unshift({ type: req.body.type, valid, at: now() });
    received.length = Math.min(received.length, 50);
    res.status(valid ? 200 : 400).json({ valid });
  });
  app.get("/api/_demo_webhook", auth, (_req, res) => res.json(received));
}

module.exports = { mount };
