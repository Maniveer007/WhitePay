"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Invoice } from "@/lib/types";
import { bff } from "@/lib/client";
import { minor, usdt } from "@/lib/format";
import { RefundButton } from "@/components/RefundButton";

export function InvoiceActions({ invoice: i }: { invoice: Invoice }) {
  const router = useRouter();
  const [msg, setMsg] = useState("");
  const act = async (path: string, ok: string) => {
    try { await bff(path, { method: "POST", body: {} }); setMsg(ok); router.refresh(); } catch (e: any) { setMsg(e.message); }
  };
  const open = ["open", "partially_paid", "overdue"].includes(i.status);
  return (
    <div className="small">
      {open ? <button className="btn ghost sm" onClick={() => act(`invoices/${i.id}/remind`, "Reminder sent")}>Remind</button> : null}
      {i.paid === 0 && i.status !== "void" ? <button className="btn ghost sm" onClick={() => confirm("Void this invoice? It can no longer be paid.") && act(`invoices/${i.id}/void`, "Voided")}>Void</button> : null}
      {i.refundDue > 0 && i.refundPlan.length ? (
        <RefundButton buttonLabel={`Refund ${minor(i.refundDue, i.currency)} (credit note)`} defaultReason="other"
          target={{ kind: "payment", ids: i.refundPlan.map((x) => x.intentId), amounts: i.refundPlan.map((x) => BigInt(x.usdt)), label: `Refund ${usdt(i.refundPlan.reduce((a, x) => a + BigInt(x.usdt), 0n))} USDT for credit notes on ${i.number}` }} />
      ) : null}
      {msg ? <div className="mut small">{msg}</div> : null}
    </div>
  );
}
