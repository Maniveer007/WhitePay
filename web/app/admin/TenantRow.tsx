"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { bffAdmin } from "@/lib/client";
import { Badge } from "@/components/ui";

export type Tenant = {
  uid: string; name: string; email: string | null; status: string; plan: string; planUntil: number | null; suspended: boolean; suspendedReason: string | null;
  createdAt: number; usage: { payments: number; invoices: number; recurring: number };
};

export function TenantRow({ tenant: m, joined }: { tenant: Tenant; joined: string }) {
  const router = useRouter();
  const [err, setErr] = useState("");
  const call = async (path: string, body: unknown) => {
    setErr("");
    try { await bffAdmin(path, body); router.refresh(); } catch (e: any) { setErr(e.message); }
  };
  return (
    <tr>
      <td><b>{m.name}</b><div className="mono mut">{m.uid}</div></td>
      <td>{m.email}</td>
      <td>{m.suspended ? <Badge tone="bad">suspended</Badge> : <Badge tone={m.status === "active" ? "ok" : "warn"}>{m.status}</Badge>}{m.suspendedReason ? <div className="mut small">{m.suspendedReason}</div> : null}</td>
      <td>
        <select aria-label={`Plan for ${m.name}`} value={m.plan} style={{ width: 120 }}
          onChange={(e) => call(`tenants/${m.uid}/plan`, { plan: e.target.value, days: 30 })}>
          {["free", "starter", "growth", "scale"].map((p) => <option key={p}>{p}</option>)}
        </select>
      </td>
      <td>{m.usage.payments}</td><td>{m.usage.invoices}</td><td className="small nowrap">{joined}</td>
      <td className="nowrap">
        {m.suspended
          ? <button className="btn secondary sm" onClick={() => call(`tenants/${m.uid}/resume`, {})}>Resume</button>
          : <button className="btn secondary sm" onClick={() => { const reason = prompt("Reason (shown to the tenant)"); if (reason !== null) call(`tenants/${m.uid}/suspend`, { reason }); }}>Suspend</button>}
        <button className="btn ghost sm" onClick={() => { const email = prompt("Invite the first owner (their email). They'll get a link to set a password."); if (email) call(`tenants/${m.uid}/invite-owner`, { email }); }}>Invite owner</button>
        {err ? <div className="small" style={{ color: "var(--bad)" }}>{err}</div> : null}
      </td>
    </tr>
  );
}
