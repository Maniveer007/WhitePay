// The books: double-entry ledger, CSV export, reconciliation against the chain, and unmatched money (exceptions).
const cfg = require("../config");
const { db, kv } = require("../db");
const indexer = require("../services/indexer");
const invoices = require("../services/invoices");
const subscriptions = require("../services/subscriptions");
const { auth } = require("../http/auth");
const { err, send } = require("../http/helpers");

function mount(app) {
  app.get("/api/exceptions", auth, (req, res) => res.json(db.prepare("SELECT * FROM exceptions WHERE merchant_id=? ORDER BY created_at DESC LIMIT 200").all(req.mid)));
  app.post("/api/exceptions/:key/resolve", auth, (req, res) => {
    db.prepare("UPDATE exceptions SET resolved=1,note=? WHERE key=? AND merchant_id=?").run(String(req.body?.note || "").slice(0, 500), req.params.key, req.mid);
    res.json({ ok: true });
  });

  app.get("/api/ledger", auth, (req, res) => {
    res.json(db.prepare("SELECT * FROM ledger WHERE merchant_id=? ORDER BY id DESC LIMIT 500").all(req.mid));
  });

  app.get("/api/ledger.csv", auth, (req, res) => {
    const rows = db.prepare("SELECT * FROM ledger WHERE merchant_id=? ORDER BY id").all(req.mid);
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const hdr = "id,date,entry_group,account,debit_usdt,credit_usdt,intent,memo,tx_hash,log_index,block";
    const f = (u) => (Number(u) / 1e6).toFixed(6);
    const lines = rows.map((r) => [r.id, new Date(r.ts * 1000).toISOString(), r.entry_group, r.account, f(r.debit), f(r.credit),
      r.intent_id, r.memo, r.tx_hash, r.log_index, r.block_number].map(esc).join(","));
    res.setHeader("content-type", "text/csv");
    res.setHeader("content-disposition", 'attachment; filename="whitepay-ledger.csv"');
    res.send([hdr, ...lines].join("\n"));
  });

  // Chain-to-ledger reconciliation: re-derive totals from raw logs and compare with the ledger.
  app.get("/api/reconcile", auth, async (req, res) => {
    try {
      const logs = await indexer.getLogsChunked({ address: cfg.dep.pay }, cfg.dep.deployBlock, Number(kv.get("cursor", cfg.dep.deployBlock)));
      let paid = 0n, refunded = 0n, subs = 0n;
      for (const l of logs) {
        const ev = indexer.iface.parseLog(l);
        const ownIntent = (iid) => !!db.prepare("SELECT 1 FROM intents WHERE id=? AND merchant_id=?").get(iid, req.mid);
        const ownSub = (sid) => !!db.prepare("SELECT 1 FROM subs WHERE id=? AND merchant_id=?").get(Number(sid), req.mid);
        if (ev.name === "PaymentReceived" && Number(ev.args.merchantId) === req.mid && ownIntent(ev.args.intentId)) paid += ev.args.amount;
        if (ev.name === "Refunded" && ownIntent(ev.args.intentId)) refunded += ev.args.amount;
        if (ev.name === "SubscriptionRefunded" && ownSub(ev.args.subId)) refunded += ev.args.amount;
        if (ev.name === "SubscriptionCharged" && ownSub(ev.args.subId)) subs += ev.args.amount;
        if (ev.name === "PlanChanged" && ownSub(ev.args.subId)) subs += ev.args.proratedCharge; // upgrade proration is subscription revenue too
      }
      const sum = (acct, col) => BigInt(db.prepare(`SELECT COALESCE(SUM(CAST(${col} AS INTEGER)),0) s FROM ledger WHERE account=? AND merchant_id=?`).get(acct, req.mid).s);
      const ledgerRev = sum("revenue:sales", "credit") - sum("revenue:sales", "debit") + sum("revenue:invoices", "credit") - sum("revenue:invoices", "debit");
      const ledgerRef = sum("contra:refunds", "debit") - sum("contra:refunds", "credit");
      const ledgerSub = sum("revenue:subscriptions", "credit") - sum("revenue:subscriptions", "debit");
      const bal = sum("assets:usdt_wallet", "debit") - sum("assets:usdt_wallet", "credit");
      const ok = ledgerRev === paid && ledgerRef === refunded && ledgerSub === subs && bal === paid + subs - refunded;
      res.json({ ok, chain: { paid: String(paid), refunded: String(refunded), subscriptions: String(subs) },
        ledger: { sales: String(ledgerRev), refunds: String(ledgerRef), subscriptions: String(ledgerSub), walletBalance: String(bal) } });
    } catch (e) { err(res, 500, "reconcile_failed", e.shortMessage || e.message); }
  });
}

module.exports = { mount };
