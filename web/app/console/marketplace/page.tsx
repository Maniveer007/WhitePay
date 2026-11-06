import type { Metadata } from "next";
import { requireArea } from "@/lib/session";
import { getJson } from "@/lib/data";
import { PageHeader, Notice } from "@/components/ui";
import { Splitters } from "./Client";

export const metadata: Metadata = { title: "Marketplace" };

export default async function MarketplacePage() {
  const { merchant: me, canWrite } = await requireArea("marketplace");
  const readOnly = !canWrite;
  const art = await getJson<{ platformFee: { recipient: string; bps: number; holdDays: number; arbiter: string } | null }>("/api/splitter-artifact");
  return (
    <>
      <PageHeader title="Marketplace" subtitle="Split every payment between a platform fee and the seller, and hold the seller's share for a dispute window." />
      {readOnly ? <Notice kind="warn">Your role can look but not create or change split contracts.</Notice> : null}
      <Splitters payout={me.payout} merchantId={me.merchantId!} platformFee={art.data?.platformFee ?? null} readOnly={readOnly} />
    </>
  );
}
