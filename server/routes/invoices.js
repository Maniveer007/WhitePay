// Invoices: create, list, aging, void, remind, and the public client view and pay-an-invoice endpoint.
const cfg = require("../config");
const { db } = require("../db");
const wh = require("../services/webhooks");
const invoices = require("../services/invoices");
const merchants = require("../services/merchants");
const finance = require("../services/finance");
const { now } = require("../services/clock");
const { auth } = require("../http/auth");
const { rateLimit, RL, paginate, err, send, notFound, ownInvoice } = require("../http/helpers");
const { createIntent } = require("../services/quotes");

function mount(app) {
  app.post("/api/invoices", auth, (req, res) => {
    try { finance.assertOpen(req.mid, Number(req.body?.issueDate) || now()); const inv = invoices.create(req.body, cfg.rates, req.mid); invoices.remindDue(); res.status(201).json({ ...inv, url: `/invoice.html?id=${inv.id}` }); }
    catch (e) { err(res, e.status || 500, e.code || "internal", e.message); }
  });
  app.get("/api/invoices", auth, (req, res) => send(res, () => paginate(req, res, invoices.list(req.mid), (i) => i.id)));
  app.get("/api/invoices/aging", auth, (req, res) => send(res, () => invoices.aging(req.mid)));
  app.post("/api/invoices/:id/void", auth, (req, res) => send(res, () => { if (!ownInvoice(req)) throw notFound("invoice"); return invoices.voidInvoice(req.params.id); }));
  app.post("/api/invoices/:id/remind", auth, (req, res) => send(res, () => {
    const inv = ownInvoice(req);
    if (!inv) throw Object.assign(new Error("Unknown invoice"), { status: 404, code: "not_found" });
    wh.emit(`evt_inv_${inv.id}_manual_${now()}`, "invoice.reminder", { ...inv, reminder: "manual" });
    return { ok: true };
  }));
  // Public: the client's view of the invoice (no API key; ids are unguessable).
  app.get("/api/invoices/:id", (req, res) => {
    const inv = invoices.state(req.params.id);
    if (!inv || inv.status === "draft") return err(res, 404, "not_found", "Unknown invoice");
    res.json(inv);
  });
  // Public: start a payment toward the invoice. Several parties can each pay a part if partial payments are allowed.
  app.post("/api/invoices/:id/pay", rateLimit(RL), async (req, res) => {
    try {
      const inv = invoices.state(req.params.id);
      if (!inv || inv.status === "draft") return err(res, 404, "not_found", "Unknown invoice");
      const q = invoices.quotePayment(inv, req.body);
      const r = await createIntent({ amount: q.amount / 100, currency: inv.currency, description: `Invoice ${inv.number}`, policy: req.body?.policy || "safe" },
        merchants.byOnchainId(inv.merchantId));
      db.prepare("UPDATE intents SET invoice_id=?,invoice_discount=? WHERE public_id=?").run(inv.id, q.discount, r.body.id);
      res.status(201).json({ checkoutUrl: r.body.checkoutUrl + `&inv=${inv.id}`, amount: q.amount, discount: q.discount });
    } catch (e) { err(res, e.status || 500, e.code || "internal", e.message); }
  });
}

module.exports = { mount };
