require("dotenv").config({ path: process.env.ENV_FILE || ".env" });
const fs = require("fs");
const path = require("path");

const depPath = path.join(__dirname, "..", process.env.DATA_DIR || "data", "deployment.json");
if (!fs.existsSync(depPath)) {
  console.error("deployment.json missing. Run `npm run demo` (local) or `npm run deploy:testnet` first.");
  process.exit(1);
}
const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));

module.exports = {
  dep,
  port: Number(process.env.PORT || 3000),
  rpcUrl: process.env.RPC_URL || dep.rpcUrl,
  apiKey: process.env.API_KEY || "wp_test_demo",
  webhookSecret: process.env.WEBHOOK_SECRET || "whsec_demo",
  webhookUrl: process.env.WEBHOOK_URL || "",         // empty -> built-in demo receiver
  finalityMode: process.env.FINALITY_MODE || "tags",
  confirmations: { safe: Number(process.env.SAFE_CONFS || 3), finalized: Number(process.env.FINAL_CONFS || 12) },
  // policy "auto": USD value thresholds for releasing goods at seen / safe / finalized
  autoPolicy: { seenBelow: Number(process.env.AUTO_SEEN_BELOW || 20), safeBelow: Number(process.env.AUTO_SAFE_BELOW || 500) },
  quoteTtl: Number(process.env.QUOTE_TTL || 900),
  // Reference fiat -> USD rates. Replace with a live oracle in production.
  rates: { USD: 1, USDT: 1, EUR: 1.08, INR: 0.0119, GBP: 1.27, ...(process.env.RATES ? JSON.parse(process.env.RATES) : {}) },
  keeperKey: process.env.KEEPER_KEY || "",
  // Gasless checkout relayer (pays WBT gas on the payer's behalf) and its drain protection.
  relayerKey: process.env.RELAYER_KEY || "",
  relayDailyLimit: Number(process.env.RELAY_DAILY_LIMIT || 100),
  relayPerPayerDaily: Number(process.env.RELAY_PER_PAYER_DAILY || 5),
  // EIP-712 domain of the token, verified against DOMAIN_SEPARATOR on Whitechain testnet.
  tokenDomain: { name: process.env.TOKEN_EIP712_NAME || "Tether USD", version: process.env.TOKEN_EIP712_VERSION || "1" },
  faucetKey: process.env.FAUCET_KEY || "",
  // Branding shown on checkout and invoices.
  merchant: { name: process.env.MERCHANT_NAME || "WhitePay Demo Store", color: process.env.MERCHANT_COLOR || "#2563eb",
    taxId: process.env.MERCHANT_TAX_ID || "", address: process.env.MERCHANT_ADDRESS || "" },
};
