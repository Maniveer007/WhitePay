// Returns leftover WBT from this run's throw-away test wallets to the deployer:  node tests/support/sweep.js
const fs = require("fs");
const { provider, deployer, walletsFile, ethers, signer } = require("./testnet");
(async () => {
  if (!fs.existsSync(walletsFile)) return console.log("nothing to sweep");
  const keys = JSON.parse(fs.readFileSync(walletsFile, "utf8")), to = await deployer.getAddress(), fee = await provider.getFeeData();
  const gas = 21000n * (fee.maxFeePerGas ?? fee.gasPrice ?? 1_000_000_000n) * 3n; // generous: the transfer must always be able to pay for itself
  let total = 0n;
  for (const k of keys) {
    const w = signer(new ethers.Wallet(k)), a = await w.getAddress(), bal = await provider.getBalance(a);
    if (bal > gas * 2n) { try { await (await w.sendTransaction({ to, value: bal - gas, gasLimit: 21000n })).wait(); total += bal - gas; } catch (e) { console.log("skip", a, e.shortMessage || e.message); } }
  }
  fs.writeFileSync(walletsFile, "[]");
  console.log(`returned ${ethers.formatEther(total)} WBT from ${keys.length} test wallets`);
})().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
