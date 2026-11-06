// Refund requests signed by the paying wallet, and the refund operators view.
const { ethers } = require("ethers");
const { db } = require("../db");
const wh = require("../services/webhooks");
const { now } = require("../services/clock");
const { auth } = require("../http/auth");
const { rateLimit, RL, err } = require("../http/helpers");
const { REFUND_REASONS, refundRequestMessage } = require("../services/refunds");

function mount(app) {
  app.post("/api/intents/:id/refund-requests", rateLimit(RL), (req, res) => {
    const r = db.prepare("SELECT * FROM intents WHERE public_id=?").get(req.params.id);
    if (!r) return err(res, 404, "not_found", "Unknown payment");
    if (!r.payer || r.finality === "reorged") return err(res, 409, "not_paid", "Only paid payments can be refunded");
    const { amount, reason, note = "", signature } = req.body || {};
    if (!REFUND_REASONS.includes(reason)) return err(res, 400, "invalid_reason", "reason must be one of " + REFUND_REASONS.join(", "));
    let units; try { units = BigInt(amount); } catch { return err(res, 400, "invalid_amount", "amount must be an integer in base units"); }
    const left = BigInt(r.amount) - BigInt(r.refunded);
    if (units <= 0n || units > left) return err(res, 400, "invalid_amount", `amount must be between 1 and ${left}`);
    let signer;
    try { signer = ethers.verifyMessage(refundRequestMessage(r.public_id, String(units), reason), signature); }
    catch { return err(res, 400, "invalid_signature", "Malformed signature"); }
    if (signer.toLowerCase() !== r.payer.toLowerCase()) return err(res, 403, "not_payer", "Sign with the wallet that made the payment");
    if (db.prepare("SELECT 1 FROM refund_requests WHERE intent_id=? AND status='open'").get(r.id))
      return err(res, 409, "request_open", "A refund request for this payment is already open");
    const info = db.prepare(`INSERT INTO refund_requests(intent_id,amount,reason,note,requester,signature,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(r.id, String(units), reason, String(note).slice(0, 500), signer, signature, now());
    wh.emit(`evt_rr_${info.lastInsertRowid}`, "refund_request.created", { merchantId: r.merchant_id, id: Number(info.lastInsertRowid), payment: r.public_id, amount: String(units), reason });
    res.status(201).json({ id: Number(info.lastInsertRowid), status: "open" });
  });

  app.get("/api/refund-requests", auth, (req, res) => {
    res.json(db.prepare(`SELECT q.*, i.public_id, i.description, i.amount AS paid, i.refunded FROM refund_requests q
      JOIN intents i ON i.id = q.intent_id WHERE i.merchant_id=? ORDER BY (q.status='open') DESC, q.id DESC LIMIT 200`).all(req.mid));
  });
  app.post("/api/refund-requests/:id/reject", auth, (req, res) => {
    const note = String(req.body?.note || "").slice(0, 500);
    const q = db.prepare(`SELECT q.* FROM refund_requests q JOIN intents i ON i.id=q.intent_id WHERE q.id=? AND q.status='open' AND i.merchant_id=?`)
      .get(Number(req.params.id), req.mid);
    if (!q) return err(res, 404, "not_found", "No open request with that id");
    db.prepare("UPDATE refund_requests SET status='rejected',resolved_at=?,resolution=? WHERE id=?").run(now(), note, q.id);
    wh.emit(`evt_rr_${q.id}_rejected`, "refund_request.rejected", { merchantId: req.mid, id: q.id, note });
    res.json({ ok: true });
  });
  app.get("/api/refund-operators", auth, (req, res) => res.json(db.prepare("SELECT * FROM refund_operators WHERE merchant_id=? ORDER BY updated_at DESC").all(req.mid)));
}

module.exports = { mount };
