// The gasless-checkout relayer wallet (pays network fees for EIP-3009 payments).
const { ethers } = require("ethers");
const cfg = require("../config");
const indexer = require("../services/indexer");

const relayer = cfg.relayerKey ? new ethers.Wallet(cfg.relayerKey, indexer.provider) : null;
const relayPay = relayer && new ethers.Contract(cfg.dep.pay, indexer.abi, relayer);

module.exports = { relayer, relayPay };
