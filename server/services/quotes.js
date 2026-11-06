// Signed quotes and payment creation: the exact, expiring EIP-712 price a customer pays, signed with the merchant's own quote signer.
const crypto = require("crypto");
const { ethers } = require("ethers");
const cfg = require("../config");
const { db } = require("../db");
const wh = require("../services/webhooks");
const indexer = require("../services/indexer");
const merchants = require("../services/merchants");
const { now } = require("../services/clock");

const domain = { name: "WhitePay", version: "1", chainId: cfg.dep.chainId, verifyingContract: cfg.dep.pay };
const QUOTE_TYPES = { Quote: [
  { name: "merchantId", type: "uint256" }, { name: "intentId", type: "bytes32" }, { name: "token", type: "address" },
  { name: "amount", type: "uint256" }, { name: "expiry", type: "uint64" } ] };

/** Sign an exact, expiring quote with THIS merchant's quote signer (it can only ever pay that merchant's payout wallet). */
async function signQuote(m, fiat, currency, intentId, ttl) {
  const rate = cfg.rates[currency];
  const amount = BigInt(Math.ceil(fiat * rate * 1e6)); // 6-decimal USDT (verified onchain)
  const expiry = now() + Number(ttl || cfg.quoteTtl);
  const sig = await merchants.signerFor(m).signTypedData(domain, QUOTE_TYPES, { merchantId: m.onchain_id, intentId, token: cfg.dep.token, amount, expiry });
  return { amount, rate, expiry, sig };
}

/** Merchant-selected finality by amount: small orders ship on "seen", large ones wait for L1 finality. */
function autoPolicy(usd) {
  return usd < cfg.autoPolicy.seenBelow ? "seen" : usd < cfg.autoPolicy.safeBelow ? "safe" : "finalized";
}

async function createIntent(body, m) {
  const { amount, currency = "USD", orderRef, description, policy = "safe", ttl } = body || {};
  const fiat = Number(amount);
  if (!(fiat > 0) || fiat > 1e9) throw Object.assign(new Error("amount must be between 0 and 1e9"), { status: 400, code: "invalid_amount" });
  if (!cfg.rates[currency]) throw Object.assign(new Error(`Unsupported currency ${currency}`), { status: 400, code: "unsupported_currency" });
  if (!["seen", "safe", "finalized", "auto"].includes(policy)) throw Object.assign(new Error("policy must be seen|safe|finalized|auto"), { status: 400, code: "invalid_policy" });
  if (orderRef) {
    const dup = db.prepare("SELECT * FROM intents WHERE order_ref=? AND merchant_id=?").get(String(orderRef), m.onchain_id); // one payment per order
    if (dup) return { status: 200, body: { ...indexer.toApi(dup), checkoutUrl: `/pay.html?i=${dup.public_id}` } };
  }
  const publicId = "pay_" + crypto.randomBytes(8).toString("hex");
  const intentId = ethers.hexlify(crypto.randomBytes(32));
  const q = await signQuote(m, fiat, currency, intentId, ttl);
  const pol = policy === "auto" ? autoPolicy(fiat * q.rate) : policy;
  db.prepare(`INSERT INTO intents(id,public_id,order_ref,description,fiat_amount,currency,rate,amount,token,expiry,signature,policy,created_at,merchant_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(intentId, publicId, orderRef ? String(orderRef) : null, description ? String(description).slice(0, 200) : null,
    fiat, currency, q.rate, String(q.amount), cfg.dep.token, q.expiry, q.sig, pol, now(), m.onchain_id);
  const out = indexer.toApi(db.prepare("SELECT * FROM intents WHERE id=?").get(intentId));
  wh.emit(`evt_${publicId}_created`, "payment.created", out);
  return { status: 201, body: { ...out, checkoutUrl: `/pay.html?i=${publicId}` } };
}

module.exports = { domain, QUOTE_TYPES, signQuote, autoPolicy, createIntent };
