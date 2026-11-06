import type { Metadata } from "next";
import { requireArea } from "@/lib/session";
import { getJson } from "@/lib/data";
import { PAID_STATES, type Payment, type Invoice } from "@/lib/types";
import { usdt, short, when, minor } from "@/lib/format";
import { PageHeader, Card, Table, Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Customers" };

export default async function CustomersPage() {
  await requireArea("customers");
  const [pay, inv] = await Promise.all([getJson<Payment[]>("/api/payments"), getJson<Invoice[]>("/api/invoices")]);
  // Customers pay from a wallet, so they're identified by wallet address. Invoice clients are identified by name.
  const wallets = new Map<string, { n: number; total: bigint; refunded: bigint; last: number }>();
  for (const p of (pay.data ?? []).filter((p) => p.payer && PAID_STATES.includes(p.status))) {
    const w = wallets.get(p.payer!) ?? { n: 0, total: 0n, refunded: 0n, last: 0 };
    w.n++; w.total += BigInt(p.amount); w.refunded += BigInt(p.refunded || "0"); w.last = Math.max(w.last, p.paidAt ?? p.createdAt);
    wallets.set(p.payer!, w);
  }
  const clients = new Map<string, { name: string; email?: string; n: number; billed: Record<string, number>; paid: Record<string, number> }>();
  for (const i of inv.data ?? []) {
    const k = (i.client.email || i.client.name).toLowerCase();
    const c = clients.get(k) ?? { name: i.client.name, email: i.client.email, n: 0, billed: {}, paid: {} };
    c.n++; c.billed[i.currency] = (c.billed[i.currency] ?? 0) + i.total; c.paid[i.currency] = (c.paid[i.currency] ?? 0) + i.paid;
    clients.set(k, c);
  }
  const sum = (o: Record<string, number>) => Object.entries(o).map(([c, v]) => minor(v, c)).join(" + ") || "—";
  return (
    <>
      <PageHeader title="Customers" subtitle="Who has paid you, and who you've invoiced." />
      {pay.error ? <Notice kind="bad">{pay.error}</Notice> : null}
      <Card title="Paying customers" subtitle="Customers pay from their own wallet, so they appear by wallet address. Their name and email appear when you invoice them.">
        <Table head={["Customer wallet", "Payments", "Paid", "Refunded", "Last payment"]} empty="No paid payments yet.">
          {[...wallets.entries()].sort((a, b) => b[1].last - a[1].last).map(([addr, w]) => (
            <tr key={addr}><td className="mono">{short(addr)}</td><td>{w.n}</td><td className="nowrap">{usdt(w.total)} USDT</td><td className="nowrap">{w.refunded > 0n ? `${usdt(w.refunded)} USDT` : "—"}</td><td className="small nowrap">{when(w.last)}</td></tr>
          ))}
        </Table>
      </Card>
      <Card title="Invoiced clients">
        <Table head={["Client", "Invoices", "Billed", "Paid"]} empty="No invoices yet.">
          {[...clients.values()].map((c) => (
            <tr key={c.name + c.email}><td><b>{c.name}</b>{c.email ? <div className="mut small">{c.email}</div> : null}</td><td>{c.n}</td><td className="nowrap">{sum(c.billed)}</td><td className="nowrap">{sum(c.paid)}</td></tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
