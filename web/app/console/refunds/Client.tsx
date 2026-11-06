"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Contract, getAddress } from "ethers";
import { bff } from "@/lib/client";
import { connectWallet, friendlyError } from "@/lib/wallet";
import { PAY_ABI } from "@/lib/abi";
import { refundPayments } from "@/lib/refund";
import { toUnits, usdt, when, short, humanize } from "@/lib/format";
import { Card, Table, Notice, StatusBadge } from "@/components/ui";

export function Requests({ requests, readOnly }: { requests: any[]; readOnly: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  async function approve(r: any) {
    setBusy(r.id); setMsg(null);
    try { await refundPayments([r.intent_id], [BigInt(r.amount)], r.reason); setMsg({ kind: "ok", text: "Refund sent onchain. The request closes after indexing." }); setTimeout(() => router.refresh(), 2500); }
    catch (e) { setMsg({ kind: "bad", text: friendlyError(e) }); } finally { setBusy(null); }
  }
  async function reject(r: any) {
    const note = prompt("Reason for rejecting (shown to the customer)");
    if (note === null) return;
    try { await bff(`refund-requests/${r.id}/reject`, { body: { note } }); router.refresh(); } catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  return (
    <Card title="Customer refund requests" subtitle="Signed by the wallet that paid. Approving sends the refund onchain from the wallet you connect.">
      <Table head={["Payment", "Requested", "Reason", "Note", "Status", ""]} empty="No refund requests.">
        {requests.map((r) => (
          <tr key={r.id}>
            <td>{r.description ?? r.public_id}<div className="mut small mono">{r.public_id}</div></td>
            <td className="nowrap">{usdt(r.amount)} USDT<div className="mut small">of {usdt(r.paid)} paid</div></td>
            <td>{humanize(r.reason)}</td><td>{r.note}</td>
            <td><StatusBadge status={r.status} /></td>
            <td className="nowrap">
              {r.status === "open" && !readOnly ? <><button className="btn sm" disabled={busy === r.id} onClick={() => approve(r)}>{busy === r.id ? "Waiting…" : "Approve"}</button> <button className="btn ghost sm" onClick={() => reject(r)}>Reject</button></> : <span className="mut small">{String(r.resolution ?? "").slice(0, 24)}</span>}
            </td>
          </tr>
        ))}
      </Table>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
    </Card>
  );
}

export function Operators({ operators, owner, readOnly }: { operators: any[]; owner: string | null; readOnly: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setMsg(null);
    try {
      const { signer, cfg } = await connectWallet();
      await (await new Contract(cfg.pay, PAY_ABI, signer).setRefunder(cfg.merchantId, getAddress(String(f.get("address")).trim()), toUnits(String(f.get("perRefund"))), toUnits(String(f.get("perDay"))))).wait();
      setMsg({ kind: "ok", text: "Saved onchain. It shows here after indexing." }); setTimeout(() => router.refresh(), 2500);
    } catch (er) { setMsg({ kind: "bad", text: friendlyError(er) }); } finally { setBusy(false); }
  }
  return (
    <Card title="Refund operators" subtitle={<>Limits are enforced by the contract. The owner ({short(owner)}) is unlimited, so anything above an operator's limit needs the owner.</>}>
      <Table head={["Operator", "Max per refund", "Daily budget", "Updated"]} empty="No operators yet. Only the owner wallet can refund.">
        {operators.map((o) => (
          <tr key={o.address}><td className="mono">{o.address}</td><td>{Number(o.per_refund) ? `${usdt(o.per_refund)} USDT` : "removed"}</td><td>{Number(o.per_day) ? `${usdt(o.per_day)} USDT` : "—"}</td><td className="small">{when(o.updated_at)}</td></tr>
        ))}
      </Table>
      {readOnly ? null : (
        <form onSubmit={save} style={{ marginTop: 18 }}>
          <h3>Add or change an operator</h3>
          <div className="row">
            <div className="field" style={{ flex: "2 1 280px" }}><label htmlFor="address">Operator wallet</label><input id="address" name="address" placeholder="0x…" required dir="ltr" spellCheck={false} /></div>
            <div className="field"><label htmlFor="perRefund">Max per refund (USDT, 0 removes)</label><input id="perRefund" name="perRefund" type="number" step="0.01" min="0" defaultValue={50} /></div>
            <div className="field"><label htmlFor="perDay">Daily budget (USDT)</label><input id="perDay" name="perDay" type="number" step="0.01" min="0" defaultValue={200} /></div>
            <button className="btn" disabled={busy}>{busy ? "Waiting for wallet…" : "Save onchain (owner wallet)"}</button>
          </div>
        </form>
      )}
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
    </Card>
  );
}
