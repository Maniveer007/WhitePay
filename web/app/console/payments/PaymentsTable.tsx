"use client";
import { useMemo, useState } from "react";
import type { Payment } from "@/lib/types";
import { refundable } from "@/lib/types";
import { usdt, short, when } from "@/lib/format";
import { Card, StatusBadge, Table } from "@/components/ui";
import { RefundButton } from "@/components/RefundButton";

const POLICY: Record<string, string> = { seen: "Fast", safe: "Standard", finalized: "Most secure" };
const FILTERS = [["all", "All"], ["paid", "Paid"], ["open", "Awaiting payment"], ["refunded", "Refunded"], ["issues", "Failed or expired"]] as const;
const match = (f: string, p: Payment) =>
  f === "all" ? true : f === "paid" ? ["seen", "safe", "finalized"].includes(p.status) : f === "open" ? ["created"].includes(p.status)
    : f === "refunded" ? ["refunded", "partially_refunded"].includes(p.status) : ["failed", "expired", "reorged"].includes(p.status);

export function PaymentsTable({ payments, readOnly }: { payments: Payment[]; readOnly: boolean }) {
  const [filter, setFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const rows = useMemo(() => payments.filter((p) => match(filter, p)), [payments, filter]);
  const picked = payments.filter((p) => selected.has(p.intentId));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <Card title="All payments" actions={
      <div className="row" style={{ gap: 6 }}>{FILTERS.map(([k, l]) => <button key={k} className={`btn sm ${filter === k ? "" : "secondary"}`} onClick={() => setFilter(k)}>{l}</button>)}</div>
    }>
      {!readOnly && picked.length > 0 ? (
        <div className="notice" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <span>{picked.length} selected. Bulk refund returns everything still refundable on each.</span>
          <RefundButton small={false} buttonLabel={`Refund ${picked.length} selected`} target={{ kind: "payment", ids: picked.map((p) => p.intentId), amounts: picked.map(refundable), label: "Bulk refund" }} />
        </div>
      ) : null}
      <Table head={[readOnly ? "" : "", "Payment", "Amount", "Status", "Confirmation level", "Payer", "Created", ""]} empty="No payments match this filter.">
        {rows.map((p) => {
          const left = refundable(p), canRefund = !readOnly && left > 0n && ["seen", "safe", "finalized", "partially_refunded"].includes(p.status);
          return (
            <tr key={p.id}>
              <td>{canRefund ? <input type="checkbox" checked={selected.has(p.intentId)} onChange={() => toggle(p.intentId)} aria-label={`Select ${p.id}`} /> : null}</td>
              <td>{p.description ?? "Payment"}<div className="mut small mono">{p.id}</div>{p.orderRef ? <div className="mut small">Order {p.orderRef}</div> : null}</td>
              <td className="nowrap">{usdt(p.amount)} USDT<div className="mut small">{p.fiatAmount} {p.currency}</div>{BigInt(p.refunded) > 0n ? <div className="small" style={{ color: "var(--warn)" }}>refunded {usdt(p.refunded)}</div> : null}</td>
              <td><StatusBadge status={p.status} />{p.fulfillable ? <div className="mut small">✓ safe to deliver</div> : null}</td>
              <td className="small">{POLICY[p.policy] ?? p.policy}</td>
              <td className="mono">{short(p.payer)}</td>
              <td className="small nowrap">{when(p.createdAt)}</td>
              <td className="nowrap small">
                <a href={`/pay.html?i=${p.id}`}>link</a> · <a href={`/receipt.html?i=${p.id}`}>receipt</a>
                {canRefund ? <div><RefundButton target={{ kind: "payment", ids: [p.intentId], amounts: [left], label: `Refund ${p.description ?? p.id}` }} defaultReason="requested_by_customer" /></div> : null}
              </td>
            </tr>
          );
        })}
      </Table>
    </Card>
  );
}
