"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Contract } from "ethers";
import { bff } from "@/lib/client";
import { connectWallet, friendlyError } from "@/lib/wallet";
import { PAY_ABI } from "@/lib/abi";
import { toUnits, usdt } from "@/lib/format";
import { Card, Table, Notice } from "@/components/ui";
import { RefundButton } from "@/components/RefundButton";

const per = (s: number) => (s % 2592000 === 0 ? `${s / 2592000} mo` : s % 604800 === 0 ? `${s / 604800} wk` : s % 86400 === 0 ? `${s / 86400} d` : `${s}s`);

/** Loads the prorated suggestion when opened, then shows the standard refund panel. */
export function SubRefund({ subId }: { subId: number }) {
  const [q, setQ] = useState<{ suggested: string; maxRefundable: string } | null>(null);
  const [err, setErr] = useState("");
  if (!q) return <><button className="btn secondary sm" onClick={() => bff(`subscriptions/${subId}/refund-quote`).then(setQ).catch((e) => setErr(e.message))}>Refund unused</button>{err ? <div className="small" style={{ color: "var(--bad)" }}>{err}</div> : null}</>;
  if (BigInt(q.maxRefundable) === 0n) return <span className="mut small">Fully refunded</span>;
  return <RefundButton target={{ kind: "subscription", subId, max: BigInt(q.maxRefundable), suggested: BigInt(q.suggested), label: `Subscription #${subId}: suggested ${usdt(q.suggested)} USDT for the unused part of this period` }} buttonLabel="Refund…" />;
}

export function PlanManager({ plans, readOnly }: { plans: any[]; readOnly: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ kind: "ok" | "bad" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setMsg(null);
    try {
      const { signer, cfg } = await connectWallet();
      const tx = await new Contract(cfg.pay, PAY_ABI, signer).createPlan(cfg.merchantId, cfg.token, toUnits(String(f.get("price"))), Number(f.get("period")),
        Math.round(Number(f.get("trial") || 0) * 86400), toUnits(String(f.get("intro") || 0)), Number(f.get("introCycles") || 0));
      await tx.wait();
      setMsg({ kind: "ok", text: "Plan created onchain. It appears after indexing; give it a name in the table." });
      setTimeout(() => router.refresh(), 2500);
    } catch (er) { setMsg({ kind: "bad", text: friendlyError(er) }); } finally { setBusy(false); }
  }
  async function setActive(id: number, active: boolean) {
    setBusy(true);
    try { const { signer, cfg } = await connectWallet(); await (await new Contract(cfg.pay, PAY_ABI, signer).setPlanActive(id, active)).wait(); setTimeout(() => router.refresh(), 2500); }
    catch (er) { setMsg({ kind: "bad", text: friendlyError(er) }); } finally { setBusy(false); }
  }
  return (
    <Card title="Plans" subtitle="Retiring a plan stops new sign-ups; existing subscribers continue.">
      <Table head={["#", "Name (off-chain label)", "Price", "Trial", "Intro price", "Status", ""]} empty="No plans yet. Create one below.">
        {plans.map((p) => (
          <tr key={p.id}>
            <td>{p.id}</td>
            <td><input defaultValue={p.name ?? ""} placeholder="Name" style={{ maxWidth: 200 }} disabled={readOnly}
              onBlur={(e) => e.target.value !== (p.name ?? "") && bff(`plans/${p.id}/name`, { body: { name: e.target.value } }).catch((er) => setMsg({ kind: "bad", text: er.message }))} /></td>
            <td className="nowrap">{usdt(p.amount)} / {per(p.period)}</td>
            <td>{p.trial ? per(p.trial) : "—"}</td>
            <td>{p.introCycles ? `${p.introCycles} × ${usdt(p.introAmount)}` : "—"}</td>
            <td>{p.active ? "active" : "retired"}</td>
            <td>{readOnly ? null : <button className="btn ghost sm" disabled={busy} onClick={() => setActive(p.id, !p.active)}>{p.active ? "Retire" : "Reactivate"}</button>}</td>
          </tr>
        ))}
      </Table>
      {readOnly ? null : (
        <form onSubmit={create} style={{ marginTop: 18 }}>
          <h3>New plan (signed by your owner wallet)</h3>
          <div className="row">
            <div className="field"><label htmlFor="price">Price (USDT)</label><input id="price" name="price" type="number" step="0.01" min="0.01" defaultValue={10} required /></div>
            <div className="field"><label htmlFor="period">Every</label><select id="period" name="period" defaultValue="2592000"><option value="2592000">month</option><option value="604800">week</option><option value="86400">day</option><option value="31536000">year</option></select></div>
            <div className="field"><label htmlFor="trial">Free trial (days)</label><input id="trial" name="trial" type="number" min="0" defaultValue={0} /></div>
            <div className="field"><label htmlFor="intro">Intro price (USDT, 0 = none)</label><input id="intro" name="intro" type="number" step="0.01" min="0" defaultValue={0} /></div>
            <div className="field"><label htmlFor="introCycles">Intro charges</label><input id="introCycles" name="introCycles" type="number" min="0" defaultValue={0} /></div>
            <button className="btn" disabled={busy}>{busy ? "Waiting for wallet…" : "Create plan onchain"}</button>
          </div>
        </form>
      )}
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
    </Card>
  );
}
