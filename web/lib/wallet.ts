"use client";
import { BrowserProvider, type Signer } from "ethers";

export type ChainConfig = {
  chainId: number; rpcUrl: string; pay: string; token: string; merchantId: number; explorer: string; payoutDelay: number; merchant: { name: string };
  gasless?: boolean; mockToken?: boolean; refundReasons?: string[];
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  tokenDomain: { name: string; version: string; chainId: number; verifyingContract: string };
};

declare global { interface Window { ethereum?: any } }

let cached: Promise<ChainConfig> | undefined;
/** Public chain settings (contract addresses etc.), served by the API. */
export function chainConfig(): Promise<ChainConfig> { return (cached ??= fetch("/api/config").then((r) => r.json())); }

export async function connectWallet(): Promise<{ signer: Signer; provider: BrowserProvider; address: string; cfg: ChainConfig }> {
  if (!window.ethereum) throw new Error("No wallet found. Install MetaMask or open this page in a wallet browser.");
  const cfg = await chainConfig();
  await window.ethereum.request({ method: "eth_requestAccounts" });
  const hex = "0x" + cfg.chainId.toString(16);
  try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
  catch (e: any) {
    if (e.code === 4902 || /Unrecognized|not added/i.test(e.message || ""))
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex,
        chainName: ({ 1875: "Whitechain", 1874: "Whitechain Testnet" } as Record<number, string>)[cfg.chainId] ?? `Chain ${cfg.chainId}`, rpcUrls: [cfg.rpcUrl],
        nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 }, blockExplorerUrls: cfg.explorer ? [cfg.explorer] : [] }] });
    else throw e;
  }
  const provider = new BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  return { signer, provider, address: await signer.getAddress(), cfg };
}

export function friendlyError(e: any): string {
  const m: string = e?.reason || e?.shortMessage || e?.message || String(e);
  const rv: string = e?.revert?.name || "";
  if (/user rejected|denied/i.test(m)) return "You cancelled the request in your wallet.";
  const known: Record<string, string> = {
    RefundLimitExceeded: "This refund is above your operator limit (per refund or today's budget). Ask the merchant owner to approve it.",
    NotAuthorized: "This wallet isn't allowed to do that for this merchant.",
    RefundExceedsPayment: "That's more than is left to refund.",
    NotMerchantOwner: "Only the merchant owner wallet can do this.",
    ReasonRequired: "A reason is required.", CapReached: "That would go over the spending cap.", InvalidTerms: "Those terms aren't valid.", Inactive: "That item is no longer active.",
  };
  if (known[rv]) return known[rv];
  if (/insufficient funds/i.test(m)) return "This wallet has no WBT for network fees.";
  if (/transfer amount exceeds balance|ERC20InsufficientBalance/i.test(m + rv)) return "This wallet doesn't hold enough USDT.";
  return m.length > 220 ? m.slice(0, 220) + "…" : m;
}

export const explorerTx = (cfg: ChainConfig, hash: string) => (cfg.explorer ? `${cfg.explorer}/tx/${hash}` : null);
