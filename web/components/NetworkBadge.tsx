"use client";
import { useEffect, useState } from "react";
import { chainConfig } from "@/lib/wallet";

// Which chain this deployment is on, so nobody has to guess whether they are looking at real money or a sandbox.
const NETWORKS: Record<number, { label: string; title: string } | null> = {
  1875: null, // Whitechain mainnet: no badge
  1874: { label: "Testnet", title: "Whitechain testnet: test USDT only, no real money" },
};

export function NetworkBadge() {
  const [id, setId] = useState<number | null>(null);
  useEffect(() => { chainConfig().then((c) => setId(c.chainId)).catch(() => {}); }, []);
  if (id === null) return null;
  const n = id in NETWORKS ? NETWORKS[id] : { label: `Chain ${id}`, title: "Custom network" };
  return n ? <span className="badge warn" title={n.title}>{n.label}</span> : null;
}
