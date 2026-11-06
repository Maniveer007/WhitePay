// The business's own profile and API key, and platform onboarding of businesses (marketplaces).
const cfg = require("../config");
const { db } = require("../db");
const notify = require("../services/notify");
const merchants = require("../services/merchants");
const { auth, platform } = require("../http/auth");
const { err, send } = require("../http/helpers");

function mount(app) {
  app.post("/api/platform/merchants", platform, (req, res) => send(res, () => { res.status(201); return merchants.create(req.body); }));
  app.get("/api/platform/merchants", platform, (_req, res) => res.json(db.prepare("SELECT * FROM merchants ORDER BY created_at").all().map(merchants.publicView)));
  app.get("/api/merchants/me", auth, (req, res) => {
    const v = merchants.publicView(req.m);
    if (["owner", "admin", "api"].includes(req.role) && req.m.uid !== "mer_default") { try { v.notify = JSON.parse(req.m.notify || "{}"); } catch { v.notify = {}; } } // alert destinations: only for people who can edit them
    if (req.m.status !== "active") v.nextStep = { contract: cfg.dep.pay, call: "registerMerchant(address payout, address quoteSigner)", args: ["<your payout wallet>", req.m.signer_address] };
    res.json(v);
  });
  app.post("/api/merchants/me", auth, (req, res) => send(res, () => {
    const b = req.role === "developer" ? { webhookUrl: req.body?.webhookUrl } : (req.body || {}); // developers manage the webhook URL, not the business profile
    if (b.webhookUrl && !/^https?:\/\//.test(b.webhookUrl)) throw Object.assign(new Error("webhookUrl must be http(s)"), { status: 400, code: "invalid_url" });
    return merchants.publicView(merchants.update(req.m.uid, b));
  }));
  app.post("/api/merchants/me/rotate-key", auth, (req, res) => {
    if (req.m.uid === "mer_default") return err(res, 400, "managed_by_env", "The default merchant's key comes from API_KEY; change it there");
    res.json({ apiKey: merchants.rotateApiKey(req.m.uid, req.body?.mode) });
  });
}

module.exports = { mount };
