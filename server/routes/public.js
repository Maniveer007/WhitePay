// Public endpoints: chain config, health, price list, payment lookup and re-quote, faucet and the demo store backend.
const { ethers } = require("ethers");
const cfg = require("../config");
const { db, kv } = require("../db");
const indexer = require("../services/indexer");
const subscriptions = require("../services/subscriptions");
const merchants = require("../services/merchants");
const { now } = require("../services/clock");
const { auth } = require("../http/auth");
const { rateLimit, RL, err } = require("../http/helpers");
const { signQuote, createIntent, domain } = require("../services/quotes");
const { REFUND_REASONS } = require("../services/refunds");
const { relayer } = require("../services/relayer");

function mount(app) {
  app.get("/api/config", (_req, res) => {
    const d = cfg.dep;
    res.json({
      chainId: d.chainId, rpcUrl: cfg.rpcUrl, pay: d.pay, token: d.token, mockToken: d.mockToken, merchantId: d.merchantId,
      explorer: d.explorer, domain, confirmations: cfg.confirmations, payoutDelay: d.payoutDelay,
      merchantOwner: d.merchantOwner, payout: d.payout, signerAddress: d.signerAddress, deployBlock: d.deployBlock,
      gasless: !!relayer, refundReasons: REFUND_REASONS, merchant: cfg.merchant, tokenDomain: { ...cfg.tokenDomain, chainId: d.chainId, verifyingContract: d.token },
    });
  });

  app.get("/api/status", (_req, res) => {
    const real = Math.floor(Date.now() / 1000); // real time: the off-chain test clock must not make the chain look stalled
    const lag = real - Number(kv.get("lastSync", 0));
    // Whitechain makes a block every ~1s: an old head block means the sequencer (or our RPC) is stalled.
    const blockAge = real - Number(kv.get("headTs", 0));
    const sequencerStalled = blockAge > Number(process.env.STALL_SECONDS || 30);
    res.json({ head: Number(kv.get("head", 0)), cursor: Number(kv.get("cursor", 0)), rpcOk: kv.get("rpcOk") === "1",
      safeHead: Number(kv.get("safeHead", 0)) || null, finalizedHead: Number(kv.get("finalizedHead", 0)) || null,
      lagSeconds: lag, blockAgeSeconds: blockAge, sequencerStalled,
      degraded: kv.get("rpcOk") !== "1" || lag > 30 || sequencerStalled });
  });

  // Customer-side view of their own subscriptions (all fields are public onchain anyway).
  app.get("/api/customers/:address/subscriptions", (req, res) => {
    let a; try { a = ethers.getAddress(req.params.address); } catch { return err(res, 400, "invalid_address", "Bad address"); }
    res.json(db.prepare("SELECT * FROM subs WHERE lower(payer)=lower(?) ORDER BY id DESC").all(a).map(subscriptions.toApi));
  });

  // Public price list (what customers can subscribe to).
  app.get("/api/plans", (req, res) => {
    const mid = Number(req.query.merchant || cfg.dep.merchantId);
    res.json(db.prepare("SELECT * FROM plans WHERE merchant_id=? AND active=1 ORDER BY CAST(amount AS INTEGER)").all(mid).map(subscriptions.planApi));
  });

  // Re-issue an expired or unused quote at the current rate (late payment / outage recovery).
  // Safe to expose publicly: it only ever pays the merchant's onchain payout wallet, and only if unpaid.
  app.post("/api/intents/:id/requote", rateLimit(RL), async (req, res) => {
    const r = db.prepare("SELECT * FROM intents WHERE public_id=?").get(req.params.id);
    if (!r) return err(res, 404, "not_found", "Unknown payment");
    if (r.finality !== "created" && r.finality !== "reorged") return err(res, 409, "already_paid", "This payment is already paid");
    const q = await signQuote(merchants.byOnchainId(r.merchant_id), r.fiat_amount, r.currency, r.id);
    db.prepare("UPDATE intents SET amount=?,rate=?,expiry=?,signature=?,finality='created' WHERE id=?").run(String(q.amount), q.rate, q.expiry, q.sig, r.id);
    res.json(indexer.toApi(db.prepare("SELECT * FROM intents WHERE id=?").get(r.id)));
  });

  app.get("/api/intents/:id", (req, res) => {
    const r = db.prepare("SELECT * FROM intents WHERE public_id=? OR id=?").get(req.params.id, req.params.id);
    if (!r) return err(res, 404, "not_found", "Unknown payment");
    const out = indexer.toApi(r);
    out.signature = r.signature;
    out.merchant = merchants.branding(merchants.byOnchainId(r.merchant_id));
    out.quote = { merchantId: r.merchant_id, intentId: r.id, token: r.token, amount: r.amount, expiry: r.expiry };
    out.confirmations = r.block_number ? Number(kv.get("head", 0)) - r.block_number + 1 : 0;
    out.refundedAmount = r.refunded;
    out.refunds = indexer.refundsOf(r.id);
    out.refundRequests = db.prepare("SELECT id,amount,reason,status,created_at,resolution FROM refund_requests WHERE intent_id=? ORDER BY id DESC").all(r.id);
    res.json(out);
  });

  app.post("/api/faucet", rateLimit(RL), async (req, res) => {
    if (!cfg.dep.mockToken || !cfg.faucetKey) return err(res, 403, "faucet_disabled", "Faucet only available with the mock token");
    try {
      const w = new ethers.Wallet(cfg.faucetKey, indexer.provider);
      const t = new ethers.Contract(cfg.dep.token, ["function mint(address,uint256)"], w);
      await (await t.mint(ethers.getAddress(req.body.address), 500_000_000n)).wait();
      res.json({ ok: true });
    } catch (e) { err(res, 400, "faucet_error", e.shortMessage || e.message); }
  });

  // Demo store backend: stands in for the merchant's own server, so the API key never reaches the browser.
  const CATALOG = { sticker: [12, "USD", "Sticker pack"], hoodie: [49, "USD", "Hoodie"], pass: [999, "INR", "Conference pass"] };
  app.post("/api/demo/checkout", rateLimit(RL), async (req, res) => {
    if (process.env.DEMO_STORE === "0") return err(res, 404, "not_found", "Demo store disabled");
    const item = CATALOG[req.body?.item];
    if (!item) return err(res, 400, "invalid_item", "Unknown item");
    try {
      const r = await createIntent({ amount: item[0], currency: item[1], description: item[2], policy: req.body.policy || "auto" }, merchants.byUid("mer_default"));
      res.status(r.status).json({ checkoutUrl: r.body.checkoutUrl });
    } catch (e) { err(res, e.status || 500, e.code || "internal", e.message); }
  });
}

module.exports = { mount };
