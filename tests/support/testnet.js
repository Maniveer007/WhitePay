// Shared by every end-to-end suite: everything runs on the Whitechain testnet (chain 1874). No local chain, no dev keys.
//   - the deployer key (DEPLOYER_KEY) owns merchant #1 and pays for deployments and top-ups
//   - test wallets are derived from TEST_WALLETS_SEED and topped up with WBT (gas) from the deployer on demand
//   - test USDT is the mintable token from the current deployment: anyone can mint, so no faucet is needed
// Settings come from .env.testnet; the deployment (contract addresses) from data-testnet/deployment.json.
const path = require("path");
const root = path.join(__dirname, "..", "..");
require("dotenv").config({ path: path.join(root, ".env.testnet"), quiet: true });
const { ethers } = require("ethers");
const dep = require(path.join(root, "data-testnet", "deployment.json"));

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || dep.rpcUrl, undefined, { staticNetwork: true, pollingInterval: 1000 });
const abi = (name) => require(path.join(root, "artifacts/contracts", `${name}.sol`, `${name}.json`)).abi;
const signer = (w) => new ethers.NonceManager(w.connect(provider));

const deployer = signer(new ethers.Wallet(process.env.DEPLOYER_KEY));
const seed = String(process.env.TEST_WALLETS_SEED || "").replace(/_/g, " ").trim();
if (!seed) throw new Error("TEST_WALLETS_SEED is missing from .env.testnet");
/** Test wallet #i (0-based), stable across runs. */
const wallet = (i) => signer(ethers.HDNodeWallet.fromPhrase(seed, undefined, `m/44'/60'/0'/0/${i}`));

/** The private key of test wallet #i, for tools that take a key (the MCP server's agent wallet). */
const walletKey = (i) => ethers.HDNodeWallet.fromPhrase(seed, undefined, `m/44'/60'/0'/0/${i}`).privateKey;

const fs = require("fs");
const walletsFile = path.join(root, "data-testnet", "test-wallets.json");
/** n brand-new, funded wallets for THIS run. A persistent chain remembers everything (allowances, daily refund budgets, subscriptions), so
 *  reusing a wallet would let one run affect the next. Each has `.pk` (private key). Leftover WBT is returned by tests/support/sweep.js. */
async function fresh(n = 1, wbt = "0.02") {
  const out = [], rec = fs.existsSync(walletsFile) ? JSON.parse(fs.readFileSync(walletsFile, "utf8")) : [];
  for (let i = 0; i < n; i++) { const w = ethers.Wallet.createRandom(); const m = signer(w); m.pk = w.privateKey; out.push(m); rec.push(w.privateKey); }
  fs.writeFileSync(walletsFile, JSON.stringify(rec));
  for (const m of out) await (await deployer.sendTransaction({ to: await m.getAddress(), value: ethers.parseEther(wbt) })).wait();
  return out;
}

const MIN_WBT = ethers.parseEther("0.03");
const erc20 = (w) => new ethers.Contract(dep.token, ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"], w);

/** Make sure these wallets can pay for gas. Cheap when they already can. */
async function fund(...ws) {
  for (const w of ws) {
    const a = await w.getAddress(), bal = await provider.getBalance(a);
    if (bal < MIN_WBT / 2n) await (await deployer.sendTransaction({ to: a, value: MIN_WBT - bal })).wait();
  }
}
/** Give a wallet test USDT (6 decimals) if it holds less than `want`. */
async function ensureUsdt(w, want = 500_000_000n) {
  const a = await w.getAddress(), bal = await erc20(provider).balanceOf(a);
  if (bal < want) await (await erc20(w).mint(a, want - bal)).wait();
}

// Where the API and web app are listening (started by `npm run testnet`), and the credentials the launcher put in .env.testnet.
const API = process.env.API_URL || "http://localhost:3000", WEB = process.env.WEB_URL || "http://localhost:3001";
const KEY = process.env.API_KEY, PLATFORM = process.env.PLATFORM_KEY;
const OWNER = { email: process.env.BOOTSTRAP_OWNER_EMAIL, password: process.env.BOOTSTRAP_OWNER_PASSWORD };
/** Waits scale with network speed: TEST_SLOW=2 doubles every fixed wait (slow RPC days). */
const SLOW = Number(process.env.TEST_SLOW || 1.5);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000 * SLOW));
/** Poll until fn returns something truthy (or time runs out). */
const until = async (fn, secs = 45) => { for (let i = 0; i < secs * 2; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 500)); } return null; };

module.exports = { fresh, walletsFile, walletKey, API, WEB, KEY, PLATFORM, OWNER, sleep, until, dep, provider, abi, deployer, wallet, fund, ensureUsdt, erc20, signer, ethers, root };
