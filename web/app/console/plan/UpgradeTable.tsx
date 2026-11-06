"use client";
import { useState } from "react";
import { bff } from "@/lib/client";
import type { Usage } from "@/lib/types";
import { Card, Table, Notice, Badge } from "@/components/ui";

const n = (x: number | null) => (x === null ? "Unlimited" : x.toLocaleString("en-US"));

export function UpgradeTable({ plans, current, readOnly }: { plans: Usage["plan"][]; current: string; readOnly: boolean }) {
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string; url?: string } | null>(null);
  const [months, setMonths] = useState(1);
  async function upgrade(plan: string) {
    setMsg(null);
    try { const r = await bff("saas/upgrade", { body: { plan, months } }); setMsg({ kind: "ok", text: `Pay $${r.priceUsd} in USDT to switch this plan on. It activates by itself once the payment is confirmed.`, url: r.checkoutUrl }); }
    catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  return (
    <Card title="Plans" actions={
      <label className="small" style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>Months to pay
        <select value={months} onChange={(e) => setMonths(Number(e.target.value))} style={{ width: 80 }}>{[1, 2, 3, 6, 12].map((m) => <option key={m}>{m}</option>)}</select></label>}>
      <Table head={["Plan", "Price / 30 days", "Payments / month", "Invoices / month", "Recurring", "Finance exports", ""]}>
        {plans.map((p) => (
          <tr key={p.id}>
            <td><b>{p.name}</b></td><td>{p.priceUsd ? `$${p.priceUsd} in USDT` : "Free"}</td><td>{n(p.limits.paymentsPerMonth)}</td><td>{n(p.limits.invoicesPerMonth)}</td>
            <td>{n(p.limits.recurringSchedules)}</td><td>{p.finance ? "Yes" : "No"}</td>
            <td>{p.id === current ? <Badge tone="brand">Current</Badge> : p.priceUsd && !readOnly ? <button className="btn sm" onClick={() => upgrade(p.id)}>{p.id === current ? "Renew" : "Choose"}</button> : null}</td>
          </tr>
        ))}
      </Table>
      {msg ? <Notice kind={msg.kind}>{msg.text} {msg.url ? <a href={msg.url} target="_blank" rel="noreferrer">Open checkout</a> : null}</Notice> : null}
    </Card>
  );
}
