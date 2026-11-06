// Network check: RPC, chain ID, deployer gas balance, and the USDT token (TOKEN_ADDRESS, else the one in the current deployment).
require("dotenv").config({ path: process.env.ENV_FILE || ".env" });
const { ethers } = require("ethers");
const fs = require("fs"), path = require("path");
(async () => {
  let token = process.env.TOKEN_ADDRESS;
  if (!token) { try { token = JSON.parse(fs.readFileSync(path.join(__dirname, "..", process.env.DATA_DIR || "data", "deployment.json"), "utf8")).token; } catch {} }
  if (!token) { console.error("No token: set TOKEN_ADDRESS or deploy first."); process.exit(1); }
  const p = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const { chainId } = await p.getNetwork();
  const w = new ethers.Wallet(process.env.DEPLOYER_KEY, p);
  const t = new ethers.Contract(token, ["function symbol() view returns (string)", "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)", "function DOMAIN_SEPARATOR() view returns (bytes32)"], p);
  const wbt = await p.getBalance(w.address);
  console.log("chainId      ", Number(chainId));
  console.log("deployer     ", w.address);
  console.log("deployer WBT ", ethers.formatEther(wbt), wbt > 0n ? "" : "<- fund this from the Whitechain testnet faucet");
  console.log("token        ", await t.symbol(), "decimals", Number(await t.decimals()), "permit", !!(await t.DOMAIN_SEPARATOR().catch(() => null)));
  console.log("deployer USDT", Number(await t.balanceOf(w.address)) / 1e6);
  if (Number(await t.decimals()) !== 6) console.log("WARNING: server and UI assume 6 decimals");
  process.exit(wbt > 0n ? 0 : 2);
})().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
