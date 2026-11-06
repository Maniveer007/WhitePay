import type { Metadata } from "next";
import { getJson } from "@/lib/data";
import { requireArea } from "@/lib/session";
import { PageHeader, Notice } from "@/components/ui";
import { Requests, Operators } from "./Client";

export const metadata: Metadata = { title: "Refunds" };

export default async function RefundsPage() {
  const { canWrite, merchant: me } = await requireArea("refunds");
  const readOnly = !canWrite;
  const [reqs, ops] = await Promise.all([getJson<any[]>("/api/refund-requests"), getJson<any[]>("/api/refund-operators")]);
  return (
    <>
      <PageHeader title="Refunds" subtitle="Customer requests, and who on your team can refund how much." />
      {reqs.error ? <Notice kind="bad">{reqs.error}</Notice> : null}
      <Requests requests={reqs.data ?? []} readOnly={readOnly} />
      <Operators operators={ops.data ?? []} owner={me.owner} readOnly={readOnly} />
    </>
  );
}
