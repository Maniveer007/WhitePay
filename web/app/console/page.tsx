import { requireAccount } from "@/lib/session";
import { getJson } from "@/lib/data";
import { PAID_STATES, type Payment, type Usage } from "@/lib/types";
import { usdt, short, when } from "@/lib/format";
import { PageHeader, Card, Stat, Table, StatusBadge, Meter, Notice } from "@/components/ui";

const AREA_NAMES: Record<string, string> = { payments: "Payments", invoices: "Invoices", subscriptions: "Subscriptions", refunds: "Refunds", finance: "Reports & accounting", ledger: "Ledger", marketplace: "Marketplace", customers: "Customers", developers: "API keys & webhooks", settings: "Business settings", team: "Team", billing: "Plan & billing", audit: "Activity log" };

export default async function Home({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const a = await requireAccount();
  const { denied } = await searchParams;
  const can = (area: keyof typeof a.access) => !!a.access[area];
  const [pay, use, team] = await Promise.all([
    can("payments") ? getJson<Payment[]>("/api/payments") : Promise.resolve({ data: null, error: null }),
    can("billing") ? getJson<Usage>("/api/saas/usage") : Promise.resolve({ data: null, error: null }),
    a.access.team === "w" ? getJson<{ members: unknown[] }>("/api/team") : Promise.resolve({ data: null, error: null }),
  ]);
  const payments = pay.data ?? [];
  const paid = payments.filter((p) => PAID_STATES.includes(p.status));
  const gross = paid.reduce((s, p) => s + BigInt(p.amount), 0n);
  const refunded = paid.reduce((s, p) => s + BigInt(p.refunded || "0"), 0n);
  const first = a.user.name.split(" ")[0];
  const m = a.merchant;

  // A checklist in plain language, showing only the steps this person can act on.
  const steps: [string, boolean, string?][] = [
    ["Confirm your email address", a.user.emailVerified],
    ["Connect your payout wallet", m.status === "active"],
    ...(a.access.settings === "w" ? [["Add your business details (tax ID, address)", !!(m.branding.taxId || m.branding.address), "/console/settings"] as [string, boolean, string]] : []),
    ...(a.access.payments === "w" ? [["Create your first payment link", paid.length > 0 || payments.length > 0, "/console/payments"] as [string, boolean, string]] : []),
    ...(a.access.team === "w" ? [["Invite a teammate", (team.data?.members.length ?? 1) > 1, "/console/team"] as [string, boolean, string]] : []),
    ...(a.access.developers === "w" ? [["Connect your website or app (webhook)", !!m.webhookUrl, "/console/developers"] as [string, boolean, string]] : []),
  ];
  const done = steps.filter((s) => s[1]).length;
  const u = use.data;

  return (
    <>
      <PageHeader title={`Welcome back, ${first}`} subtitle={`${m.name} · ${a.roleLabel}`}
        actions={a.access.payments === "w" ? <a className="btn" href="/console/payments">New payment link</a> : undefined} />
      {denied ? <Notice kind="warn">Your role ({a.roleLabel}) can't open {AREA_NAMES[denied] ?? "that page"}. Ask an owner or admin if you need access.</Notice> : null}
      {can("payments") ? (
        <div className="grid">
          <Stat label="Money received" value={`${usdt(gross)} USDT`} hint="before refunds" />
          <Stat label="Refunded" value={`${usdt(refunded)} USDT`} />
          <Stat label="Kept" value={`${usdt(gross - refunded)} USDT`} hint="received minus refunds" />
          <Stat label="Paid / created" value={`${paid.length} / ${payments.length}`} hint="payment links paid out of all created" />
        </div>
      ) : null}
      <div className="split">
        <div>
          {can("payments") ? (
            <Card title="Recent payments" actions={<a href="/console/payments" className="small">See all</a>}>
              <Table head={["What for", "Amount", "Status", "Customer", "When"]} empty="No payments yet. Create a payment link and share it with a customer.">
                {payments.slice(0, 6).map((p) => (
                  <tr key={p.id}>
                    <td>{p.description ?? <span className="mono">{p.id}</span>}</td>
                    <td className="nowrap">{usdt(p.amount)} USDT<div className="mut small">{p.fiatAmount} {p.currency}</div></td>
                    <td><StatusBadge status={p.status} /></td>
                    <td className="mono">{short(p.payer)}</td>
                    <td className="small nowrap">{when(p.createdAt)}</td>
                  </tr>
                ))}
              </Table>
            </Card>
          ) : (
            <Card title="Your access"><p className="mut" style={{ margin: 0 }}>You're signed in as <b>{a.roleLabel}</b>. Use the menu on the left to open the areas you have access to.</p></Card>
          )}
        </div>
        <div>
          <Card title={`Getting set up (${done}/${steps.length})`}>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {steps.map(([label, ok, href]) => (
                <li key={label} style={{ padding: "6px 0", display: "flex", gap: 10, alignItems: "center" }}>
                  <span aria-hidden style={{ color: ok ? "var(--ok)" : "var(--mut)", fontWeight: 700 }}>{ok ? "✓" : "○"}</span>
                  {ok || !href ? <span className={ok ? "mut" : ""}>{label}</span> : <a href={href}>{label}</a>}
                </li>
              ))}
            </ul>
          </Card>
          {u ? (
            <Card title={`${u.plan.name} plan`} actions={<a className="small" href="/console/plan">Manage</a>}>
              <div className="stack">
                <div><div className="small" style={{ fontWeight: 600 }}>Payments this month</div><Meter used={u.usage.payments} max={u.plan.limits.paymentsPerMonth} /></div>
                <div><div className="small" style={{ fontWeight: 600 }}>Invoices this month</div><Meter used={u.usage.invoices} max={u.plan.limits.invoicesPerMonth} /></div>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
