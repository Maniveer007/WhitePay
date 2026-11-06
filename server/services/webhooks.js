const crypto = require("crypto");
const { db } = require("../db");
const cfg = require("../config");

const BACKOFF = [5, 30, 120, 600, 3600]; // seconds

function sign(body, t = Math.floor(Date.now() / 1000), secret = cfg.webhookSecret) {
  const v1 = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

const listeners = [];
/** Subscribe to every NEW event (fires once per event_id, after it's stored). Used by notifications. */
function on(fn) { listeners.push(fn); }

/** Enqueue an event for one merchant. event_id is deterministic so re-indexing never double-sends.
 *  The merchant is `data.merchantId` (every payload carries it); events without one belong to the default merchant. */
function emit(eventId, type, data) {
  const now = Math.floor(Date.now() / 1000);
  const mid = Number(data?.merchantId ?? cfg.dep.merchantId);
  const payload = JSON.stringify({ id: eventId, type, created: now, merchantId: mid, data });
  const r = db.prepare("INSERT OR IGNORE INTO webhooks(event_id,type,payload,created_at,next_attempt,merchant_id) VALUES(?,?,?,?,?,?)")
    .run(eventId, type, payload, now, now, mid);
  if (r.changes) for (const fn of listeners) { try { fn({ id: eventId, type, created: now, merchantId: mid, data }); } catch (e) { console.error("[listener]", e.message); } }
}

async function deliverDue() {
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare(`SELECT w.*, m.uid AS m_uid, m.webhook_url AS m_url, m.webhook_secret AS m_secret FROM webhooks w
    LEFT JOIN merchants m ON m.onchain_id = w.merchant_id WHERE w.status='pending' AND w.next_attempt<=? LIMIT 20`).all(now);
  for (const w of rows) {
    // The default merchant falls back to the built-in demo receiver; other merchants need their own endpoint.
    const url = w.m_url || (w.m_uid === "mer_default" || !w.m_uid ? `http://127.0.0.1:${cfg.port}/api/_demo_webhook` : null);
    if (!url) { db.prepare("UPDATE webhooks SET status='no_endpoint' WHERE id=?").run(w.id); continue; }
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-whitepay-signature": sign(w.payload, undefined, w.m_secret || cfg.webhookSecret) },
        body: w.payload, signal: AbortSignal.timeout(5000),
      });
      if (r.ok) db.prepare("UPDATE webhooks SET status='delivered',attempts=attempts+1,last_status=? WHERE id=?").run(r.status, w.id);
      else throw Object.assign(new Error("HTTP " + r.status), { status: r.status });
    } catch (e) {
      const attempts = w.attempts + 1;
      const done = attempts >= BACKOFF.length;
      db.prepare("UPDATE webhooks SET attempts=?,status=?,next_attempt=?,last_status=?,last_error=? WHERE id=?")
        .run(attempts, done ? "failed" : "pending", now + BACKOFF[attempts - 1], e.status || 0, String(e.message), w.id);
    }
  }
}

function replay(id) {
  db.prepare("UPDATE webhooks SET status='pending',attempts=0,next_attempt=? WHERE id=?").run(Math.floor(Date.now() / 1000), id);
}

module.exports = { emit, on, deliverDue, replay, sign };
