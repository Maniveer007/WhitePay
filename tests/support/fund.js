// Tops up the shared test wallets once so suites start fast:  node tests/support/fund.js
const { wallet, fund, deployer, provider, ethers } = require("./testnet");
(async () => {
  const ws = Array.from({ length: 8 }, (_, i) => wallet(i));
  await fund(...ws);
  for (const [i, w] of ws.entries()) console.log(`wallet ${i}`, await w.getAddress(), ethers.formatEther(await provider.getBalance(await w.getAddress())), "WBT");
  console.log("deployer", await deployer.getAddress(), ethers.formatEther(await provider.getBalance(await deployer.getAddress())), "WBT");
})().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
