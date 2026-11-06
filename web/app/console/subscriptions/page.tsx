import type { Metadata } from "next";
import { getJson } from "@/lib/data";
import { requireArea } from "@/lib/session";
import { usdt, short, when } from "@/lib/format";
import { PageHeader, Card, Stat, Table, StatusBadge, Notice } from "@/components/ui";
import { PlanManager, SubRefund } from "./Client";

export const metadata: Metadata = { title: "Subscriptions" };
const per = (s: number) => (s % 2592000 === 0 ? `${s / 2592000} mo` : s % 604800 === 0 ? `${s / 604800} wk` : s % 86400 === 0 ? `${s / 86400} d` : `${s}s`);
const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

export default async function SubscriptionsPage() {
  const { canWrite } = await requireArea("subscriptions");
  const readOnly = !canWrite;
  const [subs, m, plans] = await Promise.all([getJson<any[]>("/api/subscriptions"), getJson<any>("/api/subscriptions/metrics"), getJson<any[]>("/api/plans/all")]);
  const k = m.data;
  return (
    <>
      <PageHeader title="Subscriptions" subtitle="Plans live onchain, so subscribers always see exactly what they agreed to." actions={<a className="btn secondary" href="/subscribe.html" target="_blank" rel="noreferrer">Customer sign-up page</a>} />
      {subs.error ? <Notice kind="bad">{subs.error}</Notice> : null}
      {k ? (
        <div className="grid">
          <Stat label="MRR" value={`${usdt(k.mrr)} USDT`} /><Stat label="ARR" value={`${usdt(k.arr)} USDT`} />
          <Stat label="Active / trialing" value={`${k.counts.active} / ${k.counts.trialing}`} /><Stat label="Past due / unpaid" value={`${k.counts.past_due} / ${k.counts.unpaid}`} />
          <Stat label="Churn (30 days)" value={pct(k.churn30d)} /><Stat label="Failed-payment recovery" value={pct(k.failedPaymentRecovery)} />
        </div>
      ) : null}
      <PlanManager plans={plans.data ?? []} readOnly={readOnly} />
      <Card title="Subscriptions">
        <Table head={["#", "Payer", "Plan / price", "Charged / cap", "Next charge", "Status", ""]} empty="No subscribers yet.">
          {(subs.data ?? []).map((s) => (
            <tr key={s.id}>
              <td>{s.id}</td><td className="mono">{short(s.payer)}</td>
              <td>{s.planId ? <>#{s.planId} {s.planName}<br /></> : null}{usdt(s.amount)} / {per(s.period)}</td>
              <td className="nowrap">{usdt(s.charged)} / {usdt(s.cap)}</td>
              <td className="small nowrap">{["cancelled", "paused"].includes(s.status) ? "—" : when(s.nextCharge)}</td>
              <td><StatusBadge status={s.status} />{s.status === "past_due" ? <div className="mut small">{s.lastFailure}</div> : null}</td>
              <td>{!readOnly && BigInt(s.charged) > 0n ? <SubRefund subId={s.id} /> : null}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
