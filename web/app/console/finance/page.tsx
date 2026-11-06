import type { Metadata } from "next";
import { getJson } from "@/lib/data";
import { requireArea } from "@/lib/session";
import { PageHeader, Notice } from "@/components/ui";
import { Statements, Periods, Auditor, Recurring, CreditNotes, TestClock } from "./Client";

export const metadata: Metadata = { title: "Finance" };

export default async function FinancePage() {
  const { canWrite } = await requireArea("finance");
  const readOnly = !canWrite;
  const [per, rec, cns, clk, use] = await Promise.all([
    getJson<any[]>("/api/periods"), getJson<any[]>("/api/recurring-invoices"), getJson<any[]>("/api/credit-notes"), getJson<any>("/api/test-clock"), getJson<any>("/api/saas/usage"),
  ]);
  const locked = per.error?.includes("paid plan") || use.data?.plan?.finance === false;
  return (
    <>
      <PageHeader title="Finance" subtitle="Statements, period close, auditor access, recurring invoices and credit notes." />
      {locked ? <Notice kind="warn">Statements, period close and the auditor key are included in paid plans. <a href="/console/plan">See plans</a></Notice> : null}
      {locked ? null : <Statements />}
      {locked ? null : <Periods periods={per.data ?? []} readOnly={readOnly} />}
      {locked ? null : <Auditor readOnly={readOnly} />}
      <Recurring items={rec.data ?? []} readOnly={readOnly} blocked={rec.error?.includes("allows")} />
      <CreditNotes notes={cns.data ?? []} readOnly={readOnly} />
      {clk.data?.enabled ? <TestClock now={clk.data.iso} /> : null}
    </>
  );
}
