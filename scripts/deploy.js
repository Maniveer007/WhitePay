// Deploys WhitePay (+ MockUSDT if TOKEN_ADDRESS is unset), registers a demo merchant
// and writes data/deployment.json for the server and the web apps.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const existing = process.env.TOKEN_ADDRESS;
  let token = existing, mock = false;
  if (!token) {
    const t = await (await ethers.getContractFactory("MockUSDT")).deploy();
    await t.waitForDeployment();
    token = await t.getAddress();
    mock = true;
  }
  const delay = Number(process.env.PAYOUT_DELAY || (mock ? 60 : 86400));
  const pay = await (await ethers.getContractFactory("WhitePay")).deploy(deployer.address, token, delay);
  await pay.waitForDeployment();
  const receipt = await pay.deploymentTransaction().wait();

  // Scoped API/quote-signing key: can sign quotes only. Never holds funds, never sets payout.
  const signer = process.env.SIGNER_KEY ? new ethers.Wallet(process.env.SIGNER_KEY) : ethers.Wallet.createRandom();
  if (signer.address === deployer.address) {
    // The quote signer is a hot server key; reusing the owner key would let a server leak control payout and refunds.
    throw new Error("SIGNER_KEY must not be the deployer/owner key. Remove SIGNER_KEY to generate a separate one.");
  }
  const payout = process.env.MERCHANT_PAYOUT || deployer.address;
  const tx = await pay.registerMerchant(payout, signer.address);
  await tx.wait();

  // Optional modules: agent spending policies (registered with WhitePay) and seat/usage metering.
  const agent = await (await ethers.getContractFactory("WhitePayAgent")).deploy(await pay.getAddress());
  await agent.waitForDeployment();
  await (await pay.setAgentModule(await agent.getAddress())).wait();
  const metered = await (await ethers.getContractFactory("WhitePayMetered")).deploy(await pay.getAddress());
  await metered.waitForDeployment();

  const out = {
    agent: await agent.getAddress(), metered: await metered.getAddress(),
    network: network.name, chainId, rpcUrl: process.env.RPC_URL || hre.network.config.url || "http://127.0.0.1:8545",
    pay: await pay.getAddress(), token, mockToken: mock, merchantId: 1, deployBlock: receipt.blockNumber,
    merchantOwner: deployer.address, payout, signerAddress: signer.address, signerKey: signer.privateKey,
    explorer: process.env.EXPLORER_URL || "", payoutDelay: delay,
  };
  const dir = path.join(__dirname, "..", process.env.DATA_DIR || "data");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "deployment.json"), JSON.stringify(out, null, 2));
  console.log("Deployed:", { pay: out.pay, token: out.token, chainId, merchantId: 1 });
}
main().catch((e) => { console.error(e); process.exit(1); });
