import type { Metadata } from "next";
import { getJson } from "@/lib/data";
import { requireArea } from "@/lib/session";
import type { Invoice } from "@/lib/types";
import { minor, when } from "@/lib/format";
import { PageHeader, Card, Table, StatusBadge, Notice } from "@/components/ui";
import { InvoiceForm } from "./InvoiceForm";
import { InvoiceActions } from "./InvoiceActions";

export const metadata: Metadata = { title: "Invoices" };
type Aging = Record<string, { current: number; "1_30": number; "31_60": number; "61_90": number; over_90: number; total: number }>;

export default async function InvoicesPage() {
  const { canWrite } = await requireArea("invoices");
  const readOnly = !canWrite;
  const [list, aging] = await Promise.all([getJson<Invoice[]>("/api/invoices"), getJson<Aging>("/api/invoices/aging")]);
  const invoices = list.data ?? [];
  return (
    <>
      <PageHeader title="Invoices" subtitle="Bill clients with partial payments, late fees, early-payment discounts and credit notes." />
      {list.error ? <Notice kind="bad">{list.error}</Notice> : null}
      <Card title="Receivables aging" subtitle="What clients owe you, by how late it is.">
        {aging.data && Object.keys(aging.data).length ? (
          <Table head={["Currency", "Current", "1–30 days", "31–60", "61–90", "90+", "Total due"]}>
            {Object.entries(aging.data).map(([c, a]) => (
              <tr key={c}><td>{c}</td>{[a.current, a["1_30"], a["31_60"], a["61_90"], a.over_90].map((v, i) => <td key={i}>{minor(v, c)}</td>)}<td><b>{minor(a.total, c)}</b></td></tr>
            ))}
          </Table>
        ) : <p className="mut" style={{ margin: 0 }}>Nothing outstanding.</p>}
      </Card>
      <Card title="All invoices">
        <Table head={["Invoice", "Client", "Total", "Paid", "Balance", "Due", "Status", ""]} empty="No invoices yet. Create your first one below.">
          {invoices.map((i) => (
            <tr key={i.id}>
              <td><a href={`/invoice.html?id=${i.id}`} target="_blank" rel="noreferrer">{i.number}</a>{i.poRef ? <div className="mut small">PO {i.poRef}</div> : null}</td>
              <td>{i.client.name}</td>
              <td className="nowrap">{minor(i.total + i.lateFee - i.discountsApplied, i.currency)}</td>
              <td className="nowrap">{minor(i.paid, i.currency)}</td>
              <td className="nowrap">{minor(i.balance, i.currency)}</td>
              <td className="small nowrap">{when(i.dueDate).split(",")[0]}</td>
              <td><StatusBadge status={i.status} /></td>
              <td>{readOnly ? null : <InvoiceActions invoice={i} />}</td>
            </tr>
          ))}
        </Table>
      </Card>
      {readOnly ? null : <InvoiceForm />}
    </>
  );
}
