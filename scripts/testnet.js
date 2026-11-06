// Runs the whole product against the real Whitechain testnet (chain 1874): API + web app, using the contracts in data-testnet/.
//   npm run testnet
// Needs .env.testnet (RPC_URL, KEEPER_KEY, RELAYER_KEY… see .env.example) and a deployment in data-testnet/ (`npm run deploy:testnet`).
// The first run adds MERCHANT_SECRETS_KEY and PLATFORM_KEY to .env.testnet (git-ignored). MERCHANT_SECRETS_KEY encrypts each business's
// quote-signing key: back it up, because losing it makes existing businesses unusable.
//
// This launcher is for trying the testnet from your own machine. For a hosted deployment use docker compose and configure real email.
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const envFile = path.join(root, ".env.testnet");

if (!fs.existsSync(envFile)) { console.error("Missing .env.testnet. See .env.example."); process.exit(1); }
const dep = path.join(root, "data-testnet", "deployment.json");
if (!fs.existsSync(dep)) { console.error("No testnet deployment found in data-testnet/. Run `npm run deploy:testnet` first."); process.exit(1); }

let env = fs.readFileSync(envFile, "utf8"), added = [];
const ensure = (key, value) => { if (!new RegExp(`^${key}=\\S`, "m").test(env)) { env = env.replace(/\n?$/, "\n") + `${key}=${value}\n`; added.push(key); } };
ensure("MERCHANT_SECRETS_KEY", crypto.randomBytes(32).toString("hex"));
ensure("PLATFORM_KEY", "wp_platform_" + crypto.randomBytes(18).toString("hex"));
ensure("BOOTSTRAP_OWNER_EMAIL", "owner@whitepay.test");                       // the first sign-in for the platform's own business
ensure("BOOTSTRAP_OWNER_PASSWORD", crypto.randomBytes(12).toString("base64url") + "-Wp1");
if (added.length) { fs.writeFileSync(envFile, env); console.log(`Added ${added.join(" and ")} to .env.testnet. Keep that file safe and backed up.\n`); }
const get = (k) => (env.match(new RegExp(`^${k}=(\\S+)`, "m")) || [])[1];
const platformKey = get("PLATFORM_KEY");

// Keeper and relayer keys, funded with WBT (idempotent).
if (spawnSync("node", [path.join(__dirname, "setup-testnet.js")], { stdio: "inherit" }).status) process.exit(1);

const d = JSON.parse(fs.readFileSync(dep, "utf8"));
const kids = [];
const run = (cmd, args, extra, cwd = root) => { const c = spawn(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...extra } }); kids.push(c); return c; };
process.on("SIGINT", () => { kids.forEach((k) => k.kill()); process.exit(0); });

run("node", ["server/index.js"], {
  ENV_FILE: ".env.testnet", PORT: "3000", SIGNUP_OPEN: "1", WEB_ORIGIN: "http://localhost:3001", PUBLIC_URL: "http://localhost:3001",
  // Verification and reset emails are only logged unless RESEND_API_KEY + EMAIL_FROM are set. This lets you read them from this machine:
  DEV_MAILBOX: "1",
  // Test-environment settings: quick keeper, compressed dunning retries, plan upgrades activate when "seen", off-chain test clock on.
  KEEPER_INTERVAL_MS: "4000", DUNNING_RETRY_SECONDS: "5,10,20,40", SAAS_UPGRADE_POLICY: "seen", TEST_CLOCK: "1",
  SIGNUP_RATE_LIMIT: "100", PUBLIC_RATE_LIMIT: "600",
});
const prod = process.argv.includes("--prod"); // production web server (run `npm run web:build` first); the tests use this
if (fs.existsSync(path.join(root, "web", "node_modules"))) run("npx", ["next", prod ? "start" : "dev", "-p", "3001"], { API_ORIGIN: "http://localhost:3000" }, path.join(root, "web"));
else console.log("Web app not installed: run `npm run web:install` first.");

setTimeout(() => console.log(`
──────────────────────────────────────────────────────────────
 WhitePay on Whitechain TESTNET (chain ${d.chainId})
   RPC        ${d.rpcUrl}
   Contract   ${d.pay}
   Explorer   ${d.explorer}/address/${d.pay}
 Open        http://localhost:3001
   Operator console: /admin   platform key: ${platformKey}
   Emails (confirm, reset, invite): http://localhost:3000/api/dev/mailbox?to=<email>
 Paying needs a wallet on the testnet with WBT (gas). Test USDT comes from the "Get 500 test USDT" button.
 New businesses register their owner wallet on-chain from the console.
 First sign-in (the platform's own business): ${get("BOOTSTRAP_OWNER_EMAIL")}  (password in .env.testnet)
──────────────────────────────────────────────────────────────`), 6000);
