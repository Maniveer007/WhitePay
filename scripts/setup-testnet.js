// Makes the testnet environment ready to run (safe to repeat):
//   - KEEPER_KEY  charges due subscriptions        - RELAYER_KEY  pays gas for gasless checkout
//   - each gets a generated key if .env.testnet has none, and is topped up with WBT from the deployer
//   - the quote signer gets a little WBT too (it reports metered usage on-chain)
// Called by `npm run testnet`; run it alone with `node scripts/setup-testnet.js`.
const fs = require("fs"), path = require("path");
const envFile = path.join(__dirname, "..", ".env.testnet");
require("dotenv").config({ path: envFile, quiet: true });
const { ethers } = require("ethers");

(async () => {
  let env = fs.readFileSync(envFile, "utf8");
  const set = (k, v) => { env = new RegExp(`^${k}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : env.replace(/\n?$/, "\n") + `${k}=${v}\n`; process.env[k] = v; };
  for (const k of ["KEEPER_KEY", "RELAYER_KEY"]) if (!process.env[k]) { set(k, ethers.Wallet.createRandom().privateKey); console.log(`Generated ${k} in .env.testnet`); }
  fs.writeFileSync(envFile, env);

  const p = new ethers.JsonRpcProvider(process.env.RPC_URL, undefined, { staticNetwork: true });
  const deployer = new ethers.NonceManager(new ethers.Wallet(process.env.DEPLOYER_KEY, p));
  const signer = process.env.SIGNER_KEY ? new ethers.Wallet(process.env.SIGNER_KEY).address : null;
  const want = [[new ethers.Wallet(process.env.KEEPER_KEY).address, "keeper", "0.1"], [new ethers.Wallet(process.env.RELAYER_KEY).address, "relayer", "0.1"], ...(signer ? [[signer, "quote signer", "0.02"]] : [])];
  for (const [addr, name, min] of want) {
    const bal = await p.getBalance(addr), need = ethers.parseEther(min);
    if (bal < need / 2n) { await (await deployer.sendTransaction({ to: addr, value: need - bal })).wait(); console.log(`Funded ${name} ${addr} with ${ethers.formatEther(need - bal)} WBT`); }
  }
})().catch((e) => { console.error("testnet setup failed:", e.shortMessage || e.message); process.exit(1); });
