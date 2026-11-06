"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { refundPayments, refundSubscription, type RefundResult } from "@/lib/refund";
import { friendlyError, explorerTx } from "@/lib/wallet";
import { REFUND_REASONS } from "@/lib/abi";
import { toUnits, usdt, humanize } from "@/lib/format";
import { Notice } from "./ui";

type Target =
  | { kind: "payment"; ids: string[]; amounts: bigint[]; label: string; editable?: boolean }
  | { kind: "subscription"; subId: number; max: bigint; suggested: bigint; label: string };

/** Review-then-confirm refund panel. Used for a single payment (partial allowed), a credit-note plan, or a subscription. */
export function RefundButton({ target, buttonLabel = "Refund", small = true, defaultReason = "other" }: { target: Target; buttonLabel?: string; small?: boolean; defaultReason?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const max = target.kind === "payment" ? target.amounts.reduce((a, b) => a + b, 0n) : target.max;
  const [amount, setAmount] = useState(usdt(target.kind === "subscription" ? target.suggested : max, 6).replace(/,/g, ""));
  const [reason, setReason] = useState(defaultReason);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string; res?: RefundResult } | null>(null);

  const single = target.kind === "subscription" || (target.kind === "payment" && target.ids.length === 1);
  const units = single ? toUnits(amount || "0") : max;
  const valid = units > 0n && units <= max;

  async function send() {
    setBusy(true); setMsg(null);
    try {
      const res = target.kind === "subscription"
        ? await refundSubscription(target.subId, units, reason)
        : await refundPayments(target.ids, single ? [units] : target.amounts, reason);
      setMsg({ kind: "ok", text: `Refunded ${usdt(res.total)} USDT to the payer${target.kind === "payment" && target.ids.length > 1 ? "s" : ""}. It shows here after indexing.`, res });
      setTimeout(() => router.refresh(), 2500);
    } catch (e) { setMsg({ kind: "bad", text: friendlyError(e) }); }
    finally { setBusy(false); }
  }

  if (!open) return <button className={`btn secondary ${small ? "sm" : ""}`} onClick={() => setOpen(true)}>{buttonLabel}</button>;
  return (
    <div className="card" style={{ margin: "8px 0", padding: 14, minWidth: 260 }}>
      <div className="small" style={{ fontWeight: 600, marginBottom: 8 }}>{target.label}</div>
      {single ? (
        <div className="field"><label>Amount (USDT)</label><input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <div className="hint">Up to {usdt(max)} USDT. Partial refunds are fine.</div></div>
      ) : <p className="small">Refund {usdt(max)} USDT across {target.kind === "payment" ? target.ids.length : 1} payments.</p>}
      <div className="field"><label>Reason (recorded onchain)</label>
        <select value={reason} onChange={(e) => setReason(e.target.value)}>{REFUND_REASONS.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}</select></div>
      <p className="hint">Funds come from the wallet you connect, and go back to the original payer.</p>
      {msg ? <Notice kind={msg.kind}>{msg.text} {msg.res && explorerTx(msg.res.cfg, msg.res.hash) ? <a href={explorerTx(msg.res.cfg, msg.res.hash)!} target="_blank" rel="noreferrer">View transaction</a> : null}</Notice> : null}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn sm" disabled={busy || !valid} onClick={send}>{busy ? "Waiting for wallet…" : `Refund ${valid ? usdt(units) : ""} USDT`}</button>
        <button className="btn ghost sm" onClick={() => setOpen(false)} disabled={busy}>Close</button>
      </div>
    </div>
  );
}
