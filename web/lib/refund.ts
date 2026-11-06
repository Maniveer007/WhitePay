"use client";
import { Contract, ZeroAddress, encodeBytes32String } from "ethers";
import { connectWallet, type ChainConfig } from "./wallet";
import { ERC20, PAY_ABI } from "./abi";
import { usdt } from "./format";

export type RefundResult = { hash: string; cfg: ChainConfig; total: bigint };

async function fund(total: bigint) {
  const { signer, address, cfg } = await connectWallet();
  const tok = new Contract(cfg.token, ERC20, signer);
  if ((await tok.balanceOf(address)) < total) throw new Error(`This wallet holds less than the ${usdt(total)} USDT needed to fund the refund.`);
  if ((await tok.allowance(address, cfg.pay)) < total) await (await tok.approve(cfg.pay, total)).wait();
  return { signer, cfg };
}

/** Refund one or many payments to their original payers from the connected wallet (owner = unlimited, operator = contract limits). */
export async function refundPayments(ids: string[], amounts: bigint[], reason: string): Promise<RefundResult> {
  const total = amounts.reduce((a, b) => a + b, 0n);
  const { signer, cfg } = await fund(total);
  const c = new Contract(cfg.pay, PAY_ABI, signer), R = encodeBytes32String(reason);
  const tx = ids.length === 1 ? await c.refund(ids[0], amounts[0], ZeroAddress, "0x", R) : await c.refundBatch(ids, amounts, R);
  await tx.wait();
  return { hash: tx.hash, cfg, total };
}

export async function refundSubscription(subId: number | string, amount: bigint, reason: string): Promise<RefundResult> {
  const { signer, cfg } = await fund(amount);
  const tx = await new Contract(cfg.pay, PAY_ABI, signer).refundSubscription(subId, amount, encodeBytes32String(reason));
  await tx.wait();
  return { hash: tx.hash, cfg, total: amount };
}
