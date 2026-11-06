// Merchant registry: one WhitePay server can host many merchants (a platform / marketplace).
//
// Each merchant has its own API key, its own quote-signing key (encrypted at rest), its own webhook URL + secret,
// branding and notification settings. The merchant's OWNER wallet stays outside WhitePay: onboarding returns a
// signer address, the merchant registers on-chain with their own wallet, and the indexer links the two.
const crypto = require("crypto");
const { ethers } = require("ethers");
const { db } = require("../db");
const cfg = require("../config");

const now = () => Math.floor(Date.now() / 1000);
function platformFee() {
  const wallet = process.env.PLATFORM_FEE_WALLET, bps = Number(process.env.PLATFORM_FEE_BPS || 0);
  if (!wallet || !ethers.isAddress(wallet) || !(bps > 0 && bps <= 10000)) return null;
  return { recipient: wallet, bps, holdDays: Number(process.env.SPLITTER_HOLD_DAYS || 7), arbiter: process.env.SPLITTER_ARBITER && ethers.isAddress(process.env.SPLITTER_ARBITER) ? process.env.SPLITTER_ARBITER : wallet };
}
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

db.exec(`CREATE TABLE IF NOT EXISTS merchants (
  uid TEXT PRIMARY KEY, onchain_id INTEGER UNIQUE, name TEXT, status TEXT DEFAULT 'pending',
  api_key_hash TEXT UNIQUE, api_key_hint TEXT, signer_address TEXT UNIQUE, signer_key_enc TEXT,
  owner TEXT, payout TEXT, webhook_url TEXT, webhook_secret TEXT,
  color TEXT, tax_id TEXT, address TEXT, notify TEXT, created_at INTEGER)`);

// Signer keys are encrypted with AES-256-GCM. MERCHANT_SECRETS_KEY (64 hex chars) must be set to onboard merchants.
function secretsKey() {
  const k = process.env.MERCHANT_SECRETS_KEY;
  if (!k || !/^[0-9a-f]{64}$/i.test(k)) throw Object.assign(new Error("Set MERCHANT_SECRETS_KEY (64 hex chars) to onboard merchants"), { status: 500, code: "not_configured" });
  return Buffer.from(k, "hex");
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", secretsKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}
function decrypt(blob) {
  const [iv, tag, enc] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", secretsKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

/** The deployment's own merchant (from env + deployment.json) is always present and keeps working unchanged. */
function bootstrap() {
  const d = cfg.dep;
  const signer = new ethers.Wallet(d.signerKey);
  db.prepare(`INSERT INTO merchants(uid,onchain_id,name,status,api_key_hash,api_key_hint,signer_address,owner,payout,webhook_url,webhook_secret,color,tax_id,address,created_at)
    VALUES('mer_default',?,?, 'active',?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(uid) DO UPDATE SET onchain_id=excluded.onchain_id,name=excluded.name,api_key_hash=excluded.api_key_hash,api_key_hint=excluded.api_key_hint,
      signer_address=excluded.signer_address,webhook_url=excluded.webhook_url,webhook_secret=excluded.webhook_secret,color=excluded.color,tax_id=excluded.tax_id,address=excluded.address`)
    .run(d.merchantId, cfg.merchant.name, sha(cfg.apiKey), cfg.apiKey.slice(-4), signer.address, d.merchantOwner, d.payout,
      cfg.webhookUrl || null, cfg.webhookSecret, cfg.merchant.color, cfg.merchant.taxId, cfg.merchant.address, now());
  // Rows from before multi-merchant belong to the deployment's own merchant.
  for (const t of ["intents", "webhooks", "exceptions", "ledger", "invoices", "notifications", "refund_operators"]) {
    try { db.prepare(`UPDATE ${t} SET merchant_id=? WHERE merchant_id IS NULL`).run(d.merchantId); } catch {}
  }
}

const signers = new Map();
/** Quote signer for an active merchant (decrypted once, then cached in memory). */
function signerFor(m) {
  if (signers.has(m.uid)) return signers.get(m.uid);
  const w = m.uid === "mer_default" ? new ethers.Wallet(cfg.dep.signerKey) : new ethers.Wallet(decrypt(m.signer_key_enc));
  signers.set(m.uid, w);
  return w;
}

// Read-only auditor key: shown once, stored hashed. It can GET anything the merchant can see and change nothing.
try { db.exec("ALTER TABLE merchants ADD COLUMN auditor_key_hash TEXT"); } catch {}
try { db.exec("ALTER TABLE merchants ADD COLUMN auditor_key_hint TEXT"); } catch {}
function byAuditorKey(key) { return key ? db.prepare("SELECT * FROM merchants WHERE auditor_key_hash=?").get(sha(key)) : null; }
function rotateAuditorKey(uid) {
  const key = "wp_audit_" + crypto.randomBytes(24).toString("hex");
  db.prepare("UPDATE merchants SET auditor_key_hash=?,auditor_key_hint=? WHERE uid=?").run(sha(key), key.slice(-4), uid);
  return key;
}
function revokeAuditorKey(uid) { db.prepare("UPDATE merchants SET auditor_key_hash=NULL,auditor_key_hint=NULL WHERE uid=?").run(uid); }

function byApiKey(key) { return key ? db.prepare("SELECT * FROM merchants WHERE api_key_hash=?").get(sha(key)) : null; }
function byOnchainId(id) { return db.prepare("SELECT * FROM merchants WHERE onchain_id=?").get(Number(id)); }
function byUid(uid) { return db.prepare("SELECT * FROM merchants WHERE uid=?").get(uid); }
function activeIds() { return db.prepare("SELECT onchain_id FROM merchants WHERE status='active' AND onchain_id IS NOT NULL").all().map((r) => r.onchain_id); }
function payouts() { return db.prepare("SELECT onchain_id, payout FROM merchants WHERE status='active' AND payout IS NOT NULL").all(); }
const isKnown = (id) => !!db.prepare("SELECT 1 FROM merchants WHERE onchain_id=? AND status='active'").get(Number(id));

function branding(m) {
  return { name: m?.name || cfg.merchant.name, color: m?.color || cfg.merchant.color, taxId: m?.tax_id || "", address: m?.address || "" };
}

/** Platform onboarding: create the merchant's API key, signer and webhook secret. Secrets are returned ONCE. */
function create({ name, color, taxId, address, webhookUrl, mode = "test" } = {}) {
  if (!name) throw Object.assign(new Error("name is required"), { status: 400, code: "invalid_name" });
  const uid = "mer_" + crypto.randomBytes(8).toString("hex");
  const apiKey = `wp_${mode === "live" ? "live" : "test"}_${crypto.randomBytes(24).toString("hex")}`;
  const webhookSecret = "whsec_" + crypto.randomBytes(24).toString("hex");
  const signer = ethers.Wallet.createRandom();
  db.prepare(`INSERT INTO merchants(uid,name,status,api_key_hash,api_key_hint,signer_address,signer_key_enc,webhook_url,webhook_secret,color,tax_id,address,created_at)
    VALUES(?,?,'pending',?,?,?,?,?,?,?,?,?,?)`).run(uid, String(name).slice(0, 100), sha(apiKey), apiKey.slice(-4), signer.address,
    encrypt(signer.privateKey), webhookUrl || null, webhookSecret, color || null, taxId || null, address || null, now());
  return {
    uid, status: "pending", apiKey, webhookSecret, signerAddress: signer.address,
    nextStep: { contract: cfg.dep.pay, call: "registerMerchant(address payout, address quoteSigner)", args: ["<your payout wallet>", signer.address],
      note: "Send this from the wallet that will OWN the merchant (ideally a Safe). WhitePay never holds that key.",
      ...(platformFee() ? { splitter: { ...platformFee(), note: "Optional: create a split-payout contract (Dashboard > Marketplace) so the platform fee is paid immediately and your share is held for the dispute window." } } : {}) },
  };
}

/** Indexer hook: a QuoteSignerSet(id, signer, true) whose signer matches a pending merchant links it to its on-chain id. */
function onSignerSet(onchainId, signer, allowed, owner, payout) {
  if (!allowed) return null;
  const m = db.prepare("SELECT * FROM merchants WHERE lower(signer_address)=lower(?) AND status='pending'").get(signer);
  if (!m) return null;
  db.prepare("UPDATE merchants SET onchain_id=?,status='active',owner=?,payout=? WHERE uid=?").run(Number(onchainId), owner, payout, m.uid);
  return byUid(m.uid);
}
function onPayoutChanged(onchainId, payout) { db.prepare("UPDATE merchants SET payout=? WHERE onchain_id=?").run(payout, Number(onchainId)); }

function update(uid, b = {}) {
  const fields = { name: b.name, color: b.color, tax_id: b.taxId, address: b.address, webhook_url: b.webhookUrl, notify: b.notify ? JSON.stringify(b.notify) : undefined };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) db.prepare(`UPDATE merchants SET ${k}=? WHERE uid=?`).run(v === "" ? null : String(v), uid);
  return byUid(uid);
}

/** Rotate a merchant's API key. The old key stops working immediately. */
function rotateApiKey(uid, mode = "test") {
  const apiKey = `wp_${mode === "live" ? "live" : "test"}_${crypto.randomBytes(24).toString("hex")}`;
  db.prepare("UPDATE merchants SET api_key_hash=?,api_key_hint=? WHERE uid=?").run(sha(apiKey), apiKey.slice(-4), uid);
  return apiKey;
}

function publicView(m) {
  return { uid: m.uid, merchantId: m.onchain_id, name: m.name, status: m.status, apiKeyHint: m.api_key_hint ? "…" + m.api_key_hint : null,
    signerAddress: m.signer_address, owner: m.owner, payout: m.payout, webhookUrl: m.webhook_url, branding: branding(m), createdAt: m.created_at };
}

module.exports = { seal: encrypt, unseal: decrypt, byAuditorKey, rotateAuditorKey, revokeAuditorKey, bootstrap, signerFor, byApiKey, byOnchainId, byUid, activeIds, payouts, isKnown, branding, create, onSignerSet, onPayoutChanged, update, rotateApiKey, publicView };
