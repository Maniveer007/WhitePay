import type { Metadata } from "next";
import { getJson } from "@/lib/data";
import { requireArea } from "@/lib/session";
import type { Usage } from "@/lib/types";
import { PageHeader, Card, Meter, Notice, Badge } from "@/components/ui";
import { UpgradeTable } from "./UpgradeTable";

export const metadata: Metadata = { title: "Plan & usage" };

export default async function PlanPage() {
  const { canWrite } = await requireArea("billing");
  const readOnly = !canWrite;
  const [u, pl] = await Promise.all([getJson<Usage>("/api/saas/usage"), getJson<{ plans: Usage["plan"][] }>("/api/saas/plans")]);
  if (!u.data) return <><PageHeader title="Plan & usage" /><Notice kind="bad">{u.error}</Notice></>;
  const x = u.data;
  return (
    <>
      <PageHeader title="Plan & usage" subtitle="Limits only stop new payments, invoices and schedules. Customers can always pay, and refunds and webhooks always work." />
      {x.suspended ? <Notice kind="bad">This account is suspended and read-only{x.suspendedReason ? `: ${x.suspendedReason}` : ""}. Contact support.</Notice> : null}
      <Card title={`${x.plan.name} plan`} actions={<Badge tone="brand">{x.plan.priceUsd ? `$${x.plan.priceUsd} / 30 days` : "Free"}</Badge>}>
        <p className="mut">
          {x.planUntil ? `Active until ${new Date(x.planUntil * 1000).toLocaleDateString("en-GB", { dateStyle: "long" })}.` : x.plan.id === "free" ? "Free with monthly limits." : "No limits on the platform account."}{" "}
          Usage period {new Date(x.period.from * 1000).toLocaleDateString("en-GB")} to {new Date((x.period.to - 1) * 1000).toLocaleDateString("en-GB")} (UTC).
        </p>
        <div className="grid" style={{ marginBottom: 0 }}>
          <div><b>Payments</b><Meter used={x.usage.payments} max={x.plan.limits.paymentsPerMonth} /></div>
          <div><b>Invoices</b><Meter used={x.usage.invoices} max={x.plan.limits.invoicesPerMonth} /></div>
          <div><b>Recurring schedules</b><Meter used={x.usage.recurring} max={x.plan.limits.recurringSchedules} /></div>
        </div>
      </Card>
      <UpgradeTable plans={pl.data?.plans ?? []} current={x.plan.id} readOnly={readOnly} />
    </>
  );
}
