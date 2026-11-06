// Deploys a PayoutSplitter for one seller (marketplace money flows: platform fee + delayed payout).
//   SELLER=0x… ARBITER=0x… RECIPIENTS=0xPlatform,0xPartner BPS=1000,250 HOLD_SECONDS=604800 \
//   npx hardhat run scripts/deploy-splitter.js --network localhost
// Then the seller's merchant OWNER points the payout at it (timelocked): WhitePay.queuePayout(merchantId, splitter) → applyPayout.
const hre = require("hardhat");
(async () => {
  const { ethers } = hre, E = process.env;
  const need = (k) => E[k] || (() => { throw new Error(`Set ${k}`); })();
  const recipients = need("RECIPIENTS").split(",").map((s) => s.trim()), bps = need("BPS").split(",").map(Number);
  const c = await (await ethers.getContractFactory("PayoutSplitter")).deploy(need("SELLER"), need("ARBITER"), recipients, bps, Number(E.HOLD_SECONDS || 0));
  await c.waitForDeployment();
  console.log("PayoutSplitter:", await c.getAddress());
  console.log(`Fee ${bps.reduce((a, b) => a + b, 0) / 100}% to ${recipients.length} recipient(s) immediately; the rest to the seller after ${E.HOLD_SECONDS || 0}s.`);
  console.log("Rules are immutable. Next: seller owner calls WhitePay.queuePayout(<merchantId>, <splitter>), waits the timelock, then applyPayout.");
  console.log("Anyone can call sweep(token) to split new funds and release(token) to pay out matured seller funds.");
})().catch((e) => { console.error(e.message); process.exit(1); });
