"use client";
import { friendlyError } from "./wallet";

/** Error text for customer pages, in the visitor's language. Contract reasons that only staff see fall back to English. */
export function customerError(e: any, t: (key: string) => string): string {
  const m: string = e?.reason || e?.shortMessage || e?.message || String(e), rv: string = e?.revert?.name || "";
  if (/No wallet found/i.test(m)) return t("err.noWallet");
  if (/user rejected|denied/i.test(m)) return t("err.cancelled");
  if (/Expired/.test(m + rv)) return t("err.expired");
  if (/AlreadyPaid/.test(m + rv)) return t("err.alreadyPaid");
  if (/insufficient funds/i.test(m)) return t("err.noGas");
  if (/transfer amount exceeds balance|ERC20InsufficientBalance|Not enough USDT/i.test(m + rv)) return t("err.noUsdt");
  return friendlyError(e);
}

/** The public view of a payment, as returned by GET /api/intents/:id. */
export type PublicPayment = {
  id: string; status: string; finality: string; amount: string; fiatAmount: number; currency: string; description: string | null; expiry: number; policy: string;
  fulfillable: boolean; gasless: boolean; txHash: string | null; confirmations: number; signature: string; refundedAmount: string;
  merchant: { name: string; color: string | null };
  quote: { merchantId: number; intentId: string; token: string; amount: string; expiry: number };
  refunds: { tx_hash: string; amount: string; reason: string; operator: string; counterparty: string; block_number: number; status: string }[];
  refundRequests: { id: number; amount: string; reason: string; status: string; created_at: number; resolution: string | null }[];
};
export const PAID_STATUSES = ["seen", "safe", "finalized", "partially_refunded", "refunded"];
export const jget = async <T = any>(path: string): Promise<T> => {
  const r = await fetch(path, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message ?? r.statusText);
  return j as T;
};
export const jpost = async <T = any>(path: string, body?: unknown): Promise<T> => {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message ?? r.statusText);
  return j as T;
};
