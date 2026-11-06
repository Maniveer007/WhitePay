import { redirect } from "next/navigation";
import { api } from "@/lib/api";
import { requireAdmin } from "@/lib/session";
import { when } from "@/lib/format";
import { PageHeader, Stat, Card, Table, Notice } from "@/components/ui";
import { TenantRow, type Tenant } from "./TenantRow";

type Overview = {
  tenants: number; byPlan: Record<string, number>; pendingOnchain: number; suspended: number; mrrUsd: number;
  thisMonth: { paidPayments: number; volumeUsdt: string }; pendingUpgrades: number; signupOpen: boolean;
};

export default async function AdminHome() {
  const key = await requireAdmin();
  const [o, t] = await Promise.all([api<Overview>("/api/platform/overview", { key }), api<Tenant[]>("/api/platform/tenants", { key })]);
  if (!o.ok && (o.status === 401 || o.status === 403)) redirect("/auth/expired?to=admin");
  if (!o.ok) return <Notice kind="bad">{o.message}</Notice>;
  if (!t.ok) return <Notice kind="bad">{t.message}</Notice>;
  const x = o.data;
  return (
    <>
      <PageHeader title="Tenants" subtitle={`Signup is ${x.signupOpen ? "open" : "closed"}. ${x.pendingUpgrades} upgrade payment(s) waiting for confirmation.`} />
      <div className="grid">
        <Stat label="Tenants" value={x.tenants} hint={Object.entries(x.byPlan).map(([p, n]) => `${n} ${p}`).join(" · ") || "none yet"} />
        <Stat label="MRR" value={`$${x.mrrUsd.toLocaleString("en-US")}`} hint="from active paid plans" />
        <Stat label="Volume this month" value={`${Number(x.thisMonth.volumeUsdt).toLocaleString("en-US")} USDT`} hint={`${x.thisMonth.paidPayments} paid payments`} />
        <Stat label="Awaiting wallet registration" value={x.pendingOnchain} />
        <Stat label="Suspended" value={x.suspended} />
      </div>
      <Card>
        <Table head={["Tenant", "Email", "Status", "Plan", "Payments", "Invoices", "Joined", ""]} empty="No tenants yet.">
          {t.data.map((m) => <TenantRow key={m.uid} tenant={m} joined={when(m.createdAt).split(",")[0]} />)}
        </Table>
      </Card>
    </>
  );
}
