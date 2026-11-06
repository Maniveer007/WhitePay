require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ path: process.env.ENV_FILE || ".env" });

const accounts = process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [];

module.exports = {
  paths: { tests: "./tests/contracts" },
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" } },
  networks: {
    hardhat: {}, // in-memory network for the contract tests only: no node, no port, never touches a real chain
    // Verified via eth_chainId: mainnet 0x753 (1875), Sepolia-settled testnet 0x752 (1874).
    whitechain: { url: process.env.RPC_URL || "https://rpc.whitechain.io", chainId: 1875, accounts },
    whitechainTestnet: { url: process.env.RPC_URL || "https://rpc.ankr.com/whitechain_testnet", chainId: 1874, accounts },
  },
};
