// Gasless checkout: relays a customer's signed EIP-3009 payment, with per-payment and per-payer limits.
const { ethers } = require("ethers");
const cfg = require("../config");
const { db, kv } = require("../db");
const indexer = require("../services/indexer");
const { now } = require("../services/clock");
const { rateLimit, RL, err, send } = require("../http/helpers");
const { relayer, relayPay } = require("../services/relayer");

function mount(app) {
  let sendQueue = Promise.resolve();          // one send at a time: nonces never collide
  const inFlight = new Set();                 // one relay per intent
  const perPayer = new Map();                 // `${day}:${payer}` -> count

  app.post("/api/intents/:id/relay", rateLimit(RL), async (req, res) => {
    if (!relayer) return err(res, 404, "gasless_disabled", "Gasless checkout is not enabled for this merchant");
    const r = db.prepare("SELECT * FROM intents WHERE public_id=?").get(req.params.id);
    if (!r) return err(res, 404, "not_found", "Unknown payment");
    if (r.finality !== "created" && r.finality !== "reorged") return err(res, 409, "already_paid", "This payment is already paid");
    if (r.expiry <= now()) return err(res, 410, "expired", "Quote expired; request a new quote");
    if (inFlight.has(r.id)) return err(res, 409, "in_flight", "This payment is already being submitted");
    const { payer, validAfter = 0, validBefore, signature } = req.body || {};
    let a;
    try {
      const sig = ethers.Signature.from(signature);
      a = { payer: ethers.getAddress(payer), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), v: sig.v, r: sig.r, s: sig.s };
    } catch { return err(res, 400, "invalid_authorization", "Malformed payer, validBefore or signature"); }
    if (a.validBefore > BigInt(r.expiry) + 60n) return err(res, 400, "invalid_authorization", "validBefore must not outlive the quote");

    // Drain protection: global daily budget + per-payer cap.
    const day = new Date().toISOString().slice(0, 10);
    const used = Number(kv.get(`relay:${day}`, 0)), mine = perPayer.get(`${day}:${a.payer}`) || 0;
    if (used >= cfg.relayDailyLimit) return err(res, 429, "relay_budget_exhausted", "Gasless checkout is busy today; pay with your wallet instead");
    if (mine >= cfg.relayPerPayerDaily) return err(res, 429, "relay_rate_limited", "Too many gasless payments from this wallet today");

    const q = [r.merchant_id, r.id, r.token, r.amount, r.expiry];
    inFlight.add(r.id);
    try {
      // Simulate first: the relayer never pays gas for a transaction that would revert.
      try { await relayPay.payWithAuthorization.staticCall(q, r.signature, a); }
      catch (e) { inFlight.delete(r.id); return err(res, 400, "authorization_rejected", indexer.reasonOf(e)); }
      const tx = await (sendQueue = sendQueue.catch(() => {}).then(async () => {
        const nonce = await indexer.provider.getTransactionCount(relayer.address, "pending");
        return relayPay.payWithAuthorization(q, r.signature, a, { nonce });
      }));
      kv.set(`relay:${day}`, used + 1);
      perPayer.set(`${day}:${a.payer}`, mine + 1);
      db.prepare("UPDATE intents SET relay_tx=? WHERE id=?").run(tx.hash, r.id);
      res.status(202).json({ txHash: tx.hash });
      tx.wait().catch(() => {}).finally(() => inFlight.delete(r.id));
    } catch (e) {
      inFlight.delete(r.id);
      err(res, 502, "relay_failed", e.shortMessage || e.message);
    }
  });

}

module.exports = { mount };
