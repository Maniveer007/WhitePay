// Extension routes: test clock, credit notes, recurring invoices, finance exports, period close, auditor key,
// payer portal data, seat/usage meters, agent policies and x402 paywalls.
const crypto = require("crypto");
const { ethers } = require("ethers");
const cfg = require("../config");
const { db } = require("../db");
const wh = require("../services/webhooks");
const indexer = require("../services/indexer");
const invoices = require("../services/invoices");
const recurring = require("../services/recurring");
const finance = require("../services/finance");
const merchants = require("../services/merchants");
const clock = require("../services/clock");
const { now } = clock;

const AGENT_ABI = [
  "function policies(address,address) view returns (uint128 perPayment,uint128 perDay,uint128 usedToday,uint64 day,uint64 expiry,bool restrictMerchants,bool active)",
  "function merchantAllowed(address,address,uint256) view returns (bool)",
  "event AgentPaid(address indexed owner,address indexed agent,uint256 indexed merchantId,bytes32 intentId,uint256 amount)",
];
const METER_ABI = [
  "function getMeter(uint256) view returns (tuple(uint256 merchantId,address payer,address token,uint128 seatPrice,uint128 unitPrice,uint128 usageBudget,uint128 cap,uint128 charged,uint128 usedInWindow,uint64 period,uint64 windowStart,uint64 nextSeatCharge,uint64 end,uint32 seats,uint32 pendingSeats,bool cancelled))",
  "function chargeUsage(uint256 id,uint256 units,bytes32 reportId)",
  "function chargeSeats(uint256 id)",
  "event MeterOpened(uint256 indexed meterId,uint256 indexed merchantId,address indexed payer,address token,tuple(uint128 seatPrice,uint32 seats,uint128 unitPrice,uint128 usageBudget,uint64 period,uint128 cap,uint64 end) terms)",
];
const PAID = ["seen", "safe", "finalized"];
const bad = (status, code, message) => Object.assign(new Error(message), { status, code });
const meterApi = (id, m) => ({ id: Number(id), merchantId: Number(m.merchantId), payer: m.payer, token: m.token, seatPrice: String(m.seatPrice), seats: Number(m.seats),
  pendingSeats: Number(m.pendingSeats), unitPrice: String(m.unitPrice), usageBudget: String(m.usageBudget), usedInWindow: String(m.usedInWindow), cap: String(m.cap),
  charged: String(m.charged), period: Number(m.period), nextSeatCharge: Number(m.nextSeatCharge), end: Number(m.end), cancelled: m.cancelled });

/** Optional platform fee suggested to every new seller: PLATFORM_FEE_WALLET + PLATFORM_FEE_BPS (+ SPLITTER_HOLD_DAYS, SPLITTER_ARBITER). */
function platformFee() {
  const wallet = process.env.PLATFORM_FEE_WALLET, bps = Number(process.env.PLATFORM_FEE_BPS || 0);
  if (!wallet || !ethers.isAddress(wallet) || !(bps > 0 && bps <= 10000)) return null;
  const arbiter = process.env.SPLITTER_ARBITER && ethers.isAddress(process.env.SPLITTER_ARBITER) ? process.env.SPLITTER_ARBITER : wallet;
  return { recipient: wallet, bps, holdDays: Number(process.env.SPLITTER_HOLD_DAYS || 7), arbiter };
}

function mount(app) {
  const { err, send, paginate, rateLimit, RL, ownInvoice } = require("../http/helpers");
  const { auth } = require("../http/auth");
  const { createIntent, signQuote } = require("../services/quotes");
  const agentC = cfg.dep.agent && new ethers.Contract(cfg.dep.agent, AGENT_ABI, indexer.provider);
  const meterC = cfg.dep.metered && new ethers.Contract(cfg.dep.metered, METER_ABI, indexer.provider);
  const addr = (res, a) => { try { return ethers.getAddress(a); } catch { err(res, 400, "invalid_address", "Bad address"); return null; } };

  // Which optional contracts this deployment has (the portal and agents read this).
  app.get("/api/extensions", (_req, res) => res.json({ agent: cfg.dep.agent || null, metered: cfg.dep.metered || null, chainId: cfg.dep.chainId,
    pay: cfg.dep.pay, token: cfg.dep.token, testClock: clock.enabled }));

  // ───────── Marketplace splitters (PayoutSplitter) ─────────
  // The splitter is deployed by the seller's own wallet from the dashboard; the server only serves the compiled contract and reads its state.
  const SPLIT_ABI = ["function seller() view returns (address)", "function arbiter() view returns (address)", "function holdSeconds() view returns (uint64)",
    "function recipientCount() view returns (uint256)", "function recipients(uint256) view returns (address)", "function bps(uint256) view returns (uint16)",
    "function totalSplitBps() view returns (uint16)", "function heldTotal(address) view returns (uint256)", "function trancheCount(address) view returns (uint256)"];
  app.get("/api/splitter-artifact", (_req, res) => {
    const a = require("../../artifacts/contracts/PayoutSplitter.sol/PayoutSplitter.json");
    res.json({ abi: a.abi, bytecode: a.bytecode, platformFee: platformFee() });
  });
  app.get("/api/splitters/:address", async (req, res) => {
    const a = addr(res, req.params.address); if (!a) return;
    try {
      const sp = new ethers.Contract(a, SPLIT_ABI, indexer.provider), tok = new ethers.Contract(cfg.dep.token, ["function balanceOf(address) view returns (uint256)"], indexer.provider);
      const n = Number(await sp.recipientCount());
      const [seller, arbiter, hold, total, held, bal, tranches] = await Promise.all([sp.seller(), sp.arbiter(), sp.holdSeconds(), sp.totalSplitBps(), sp.heldTotal(cfg.dep.token), tok.balanceOf(a), sp.trancheCount(cfg.dep.token)]);
      const recipients = await Promise.all(Array.from({ length: n }, async (_, i) => ({ address: await sp.recipients(i), bps: Number(await sp.bps(i)) })));
      const unswept = bal > held ? bal - held : 0n; // received but not yet split
      res.json({ address: a, seller, arbiter, holdSeconds: Number(hold), totalSplitBps: Number(total), recipients, token: cfg.dep.token,
        held: String(held), balance: String(bal), unswept: String(unswept), trancheCount: Number(tranches),
        payoutOf: merchants.payouts().filter((m) => m.payout?.toLowerCase() === a.toLowerCase()).map((m) => m.onchain_id) });
    } catch { err(res, 404, "not_a_splitter", "That address is not a PayoutSplitter on this network"); }
  });

  // ───────── Event feed (CLI webhook forwarding) ─────────
  // Same payloads that webhooks deliver, readable by polling: `whitepay listen` forwards them to localhost with a valid signature.
  app.get("/api/events", auth, (req, res) => {
    const rows = db.prepare("SELECT id,event_id,type,payload,created_at FROM webhooks WHERE merchant_id=? AND id>? ORDER BY id LIMIT ?")
      .all(req.mid, Number(req.query.after_id || 0), Math.min(100, Number(req.query.limit) || 50));
    res.json(rows.map((r) => ({ id: r.id, eventId: r.event_id, type: r.type, createdAt: r.created_at, payload: r.payload })));
  });
  app.get("/api/events/latest", auth, (req, res) => res.json({ id: db.prepare("SELECT COALESCE(MAX(id),0) m FROM webhooks WHERE merchant_id=?").get(req.mid).m }));
  // The signing secret is only handed to the merchant's main key, never to the read-only auditor key.
  app.get("/api/webhook-secret", auth, (req, res) => req.readOnly ? err(res, 403, "read_only", "Read-only key") : res.json({ secret: req.m.webhook_secret }));

  // ───────── Test clock (off-chain time only; never on mainnet) ─────────
  app.get("/api/test-clock", auth, (_req, res) => res.json(clock.state()));
  app.post("/api/test-clock/advance", auth, (req, res) => {
    if (req.readOnly) return err(res, 403, "read_only", "Read-only key");
    return clock.advance(req.body?.seconds ?? Number(req.body?.days || 0) * 86400)
      .then(async (s) => { try { invoices.remindDue(); recurring.run(cfg.rates); await indexer.tick(); } catch {} res.json(s); })
      .catch((e) => err(res, e.status || 500, e.code || "internal", e.message));
  });
  app.post("/api/test-clock/reset", auth, (_req, res) => res.json(clock.reset()));

  // ───────── Credit notes ─────────
  app.post("/api/invoices/:id/credit-notes", auth, (req, res) => send(res, () => { res.status(201); finance.assertOpen(req.mid, now()); return invoices.createCreditNote(req.params.id, req.body, req.mid); }));
  app.get("/api/credit-notes", auth, (req, res) => send(res, () => invoices.listCreditNotes(req.mid)));

  // ───────── Recurring invoices ─────────
  app.post("/api/recurring-invoices", auth, (req, res) => send(res, () => { res.status(201); return recurring.create(req.body, cfg.rates, req.mid); }));
  app.get("/api/recurring-invoices", auth, (req, res) => send(res, () => recurring.list(req.mid)));
  for (const [name, status] of [["pause", "paused"], ["resume", "active"], ["cancel", "cancelled"]])
    app.post(`/api/recurring-invoices/:id/${name}`, auth, (req, res) => send(res, () => recurring.setStatus(req.params.id, req.mid, status)));

  // ───────── Finance ─────────
  app.get("/api/statements", auth, (req, res) => send(res, () => {
    const st = finance.statement(req.mid, req.m.name, req.query);
    const f = String(req.query.format || "json"), base = `whitepay-statement-${new Date(st.from * 1000).toISOString().slice(0, 10)}`;
    const out = (type, ext, body) => { res.setHeader("content-type", type); res.setHeader("content-disposition", `attachment; filename="${base}.${ext}"`); res.send(body); return undefined; };
    if (f === "xlsx") return out("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx", finance.toXlsx(st));
    if (f === "pdf") return out("application/pdf", "pdf", finance.toPdf(st));
    if (f === "csv") return out("text/csv", "csv", finance.toCsv(st));
    if (f === "xero") return out("text/csv", "xero.csv", finance.toXero(st));
    if (f === "quickbooks") return out("text/csv", "quickbooks.csv", finance.toQuickBooks(st));
    if (f !== "json") throw bad(400, "invalid_format", "format must be json | xlsx | pdf | csv | xero | quickbooks");
    return { ...st, ledger: undefined, ledgerLines: st.ledger.length };
  }));
  app.get("/api/periods", auth, (req, res) => send(res, () => finance.listPeriods(req.mid)));
  const writer = (req, res, fn) => req.readOnly ? err(res, 403, "read_only", "Read-only key") : send(res, fn);
  app.post("/api/periods/close", auth, (req, res) => writer(req, res, () => { res.status(201); return finance.closePeriod(req.mid, req.body, "api_key"); }));
  app.post("/api/periods/:id/reopen", auth, (req, res) => writer(req, res, () => finance.reopenPeriod(req.mid, req.params.id, req.body?.reason)));
  // The auditor key can only be managed with the merchant's main key (never with the auditor key itself).
  app.post("/api/auditor-key", auth, (req, res) => writer(req, res, () => ({ auditorKey: merchants.rotateAuditorKey(req.m.uid), note: "Shown once. Read-only: GET requests only." })));
  app.post("/api/auditor-key/revoke", auth, (req, res) => writer(req, res, () => { merchants.revokeAuditorKey(req.m.uid); return { ok: true }; }));

  // ───────── Payer portal data (everything here is already public on-chain) ─────────
  app.get("/api/customers/:address/payments", rateLimit(RL * 4), (req, res) => {
    const a = addr(res, req.params.address); if (!a) return;
    const rows = db.prepare("SELECT * FROM intents WHERE lower(payer)=lower(?) ORDER BY paid_at DESC LIMIT 200").all(a).map((r) => ({
      ...indexer.toApi(r), merchant: merchants.branding(merchants.byOnchainId(r.merchant_id)).name, refunds: indexer.refundsOf(r.id) }));
    res.json(rows);
  });
  app.get("/api/customers/:address/meters", rateLimit(RL * 4), async (req, res) => {
    const a = addr(res, req.params.address); if (!a || !meterC) return a && res.json([]);
    const logs = await indexer.getLogsChunked({ address: cfg.dep.metered, topics: [meterC.interface.getEvent("MeterOpened").topicHash, null, null, ethers.zeroPadValue(a, 32)] }, cfg.dep.deployBlock, await indexer.provider.getBlockNumber());
    const ids = [...new Set(logs.map((l) => Number(meterC.interface.parseLog(l).args.meterId)))];
    res.json(await Promise.all(ids.map(async (id) => meterApi(id, await meterC.getMeter(id)))));
  });
  app.get("/api/customers/:address/agents", rateLimit(RL * 4), async (req, res) => {
    const a = addr(res, req.params.address); if (!a || !agentC) return a && res.json([]);
    const logs = await indexer.getLogsChunked({ address: cfg.dep.agent, topics: [agentC.interface.getEvent("AgentPaid").topicHash, ethers.zeroPadValue(a, 32)] }, cfg.dep.deployBlock, await indexer.provider.getBlockNumber());
    res.json(logs.map((l) => { const e = agentC.interface.parseLog(l).args; return { agent: e.agent, merchantId: Number(e.merchantId), intentId: e.intentId, amount: String(e.amount), txHash: l.transactionHash }; }));
  });
  app.get("/api/agents/policy", rateLimit(RL * 4), async (req, res) => {
    const o = addr(res, req.query.owner), g = addr(res, req.query.agent); if (!o || !g) return;
    if (!agentC) return err(res, 404, "agents_disabled", "This deployment has no agent module");
    const p = await agentC.policies(o, g);
    res.json({ owner: o, agent: g, active: p.active, perPayment: String(p.perPayment), perDay: String(p.perDay), usedToday: String(p.day === BigInt(Math.floor(now() / 86400)) ? p.usedToday : 0n),
      expiry: Number(p.expiry), restrictMerchants: p.restrictMerchants });
  });

  // ───────── Meters (merchant side) ─────────
  app.get("/api/meters/:id", auth, async (req, res) => {
    if (!meterC) return err(res, 404, "metering_disabled", "This deployment has no metering module");
    const m = await meterC.getMeter(Number(req.params.id));
    if (m.payer === ethers.ZeroAddress || Number(m.merchantId) !== req.mid) return err(res, 404, "not_found", "Unknown meter");
    res.json(meterApi(req.params.id, m));
  });
  // Report usage. Signed by the merchant's quote signer (it must hold a little gas). The contract applies the payer's price and budget.
  app.post("/api/meters/:id/usage", auth, async (req, res) => {
    if (req.readOnly) return err(res, 403, "read_only", "Read-only key");
    if (!meterC) return err(res, 404, "metering_disabled", "This deployment has no metering module");
    const units = Number(req.body?.units), key = String(req.body?.reportId || "");
    if (!Number.isInteger(units) || units <= 0 || !key) return err(res, 400, "invalid_usage", "units (positive integer) and reportId (your idempotency key) are required");
    const m = await meterC.getMeter(Number(req.params.id));
    if (m.payer === ethers.ZeroAddress || Number(m.merchantId) !== req.mid) return err(res, 404, "not_found", "Unknown meter");
    const w = merchants.signerFor(req.m).connect(indexer.provider);
    const c2 = meterC.connect(w), rid = ethers.id(`${req.mid}:${req.params.id}:${key}`);
    try {
      await c2.chargeUsage.staticCall(Number(req.params.id), units, rid);
      const tx = await c2.chargeUsage(Number(req.params.id), units, rid);
      const rc = await tx.wait();
      wh.emit(`evt_meter_${req.params.id}_${rid.slice(2, 18)}`, "meter.usage_charged", { merchantId: req.mid, meterId: Number(req.params.id), units, reportId: key, txHash: rc.hash });
      res.status(201).json({ ok: true, txHash: rc.hash });
    } catch (e) { err(res, 409, "usage_rejected", indexer.reasonOf(e)); }
  });

  // ───────── x402: HTTP 402 paywall settled through WhitePay ─────────
  db.exec("CREATE TABLE IF NOT EXISTS x402_used (payment_id TEXT PRIMARY KEY, resource TEXT, used_at INTEGER)");
  /** Express middleware: answer 402 with a signed WhitePay quote until a paid, unused payment id arrives in X-PAYMENT. */
  function x402(opts) {
    return async (req, res, next) => {
      const resource = opts.resource || req.baseUrl + req.path;
      const hdr = req.headers["x-payment"];
      if (hdr) {
        let p; try { p = JSON.parse(Buffer.from(String(hdr), "base64").toString("utf8")); } catch { return err(res, 400, "invalid_payment", "X-PAYMENT must be base64 JSON"); }
        const r = db.prepare("SELECT * FROM intents WHERE public_id=?").get(String(p.paymentId || ""));
        if (!r || r.order_ref?.split("#")[0] !== `x402:${resource}`) return err(res, 402, "payment_not_found", "Unknown payment for this resource");
        const want = (r.policy === "finalized" ? ["finalized"] : r.policy === "safe" ? ["safe", "finalized"] : PAID);
        if (!want.includes(r.finality)) return err(res, 402, "payment_not_settled", `Payment is ${r.finality}; waiting for ${r.policy}`);
        if (db.prepare("INSERT OR IGNORE INTO x402_used(payment_id,resource,used_at) VALUES(?,?,?)").run(r.public_id, resource, now()).changes === 0)
          return err(res, 402, "payment_already_used", "This payment already bought an earlier response");
        res.set("X-PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: true, txHash: r.tx_hash, payer: r.payer })).toString("base64"));
        return next();
      }
      // No payment yet: open a fresh quote for the merchant and describe how to pay it.
      const m = opts.merchant || merchants.byUid("mer_default");
      const created = await createIntent({ amount: opts.price, currency: opts.currency || "USD", description: opts.description || `Access to ${resource}`,
        orderRef: `x402:${resource}#${crypto.randomBytes(6).toString("hex")}`, policy: opts.policy || "seen" }, m);
      const q = db.prepare("SELECT * FROM intents WHERE public_id=?").get(created.body.id);
      res.status(402).json({
        x402Version: 1, error: "payment_required",
        accepts: [{ scheme: "whitepay-quote", network: `eip155:${cfg.dep.chainId}`, resource, description: created.body.description, asset: q.token, maxAmountRequired: q.amount,
          payTo: cfg.dep.pay, expiresAt: q.expiry, paymentId: q.public_id,
          extra: { quote: { merchantId: q.merchant_id, intentId: q.id, token: q.token, amount: q.amount, expiry: q.expiry }, signature: q.signature,
            payWith: ["WhitePay.pay(quote, signature)", cfg.dep.agent ? "WhitePayAgent.agentPay(owner, quote, signature)" : null].filter(Boolean),
            retry: "Repeat the request with header X-PAYMENT: base64(JSON.stringify({ paymentId }))" } }],
      });
    };
  }
  app.get("/api/x402/demo", x402({ price: Number(process.env.X402_DEMO_PRICE || 0.05), resource: "/api/x402/demo", description: "x402 demo: one premium answer" }),
    (_req, res) => res.json({ answer: "Paid content delivered.", at: now() }));
  app.x402 = x402;
}

module.exports = { mount };
