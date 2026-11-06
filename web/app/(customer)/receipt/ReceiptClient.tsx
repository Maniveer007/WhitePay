"use client";
import { useEffect, useState } from "react";
import { Contract, JsonRpcProvider, decodeBytes32String, formatEther } from "ethers";
import { useI18n } from "@/components/I18n";
import { chainConfig, connectWallet, explorerTx, type ChainConfig } from "@/lib/wallet";
import { PAY_ABI } from "@/lib/abi";
import { customerError, jget, jpost, type PublicPayment } from "@/lib/customer";
import { short, usdt } from "@/lib/format";

type Check = [string, boolean];
type Onchain = { amount: bigint; refunded: bigint };
type View = {
  i: PublicPayment & { payer: string | null; fee: { gasWei: string | null } }; cfg: ChainConfig; checks: Check[]; ok: boolean; block: number; confs: number; onchain: Onchain;
  refundRows: { ok: boolean; line: string; tx: string }[]; refundsAdd: boolean | null;
};

// This page does NOT trust the WhitePay server for proof: it asks the chain (through the public RPC) directly.
export function ReceiptClient({ id }: { id: string }) {
  const { t, tr, num, money } = useI18n();
  const [view, setView] = useState<View | null>(null);
  const [empty, setEmpty] = useState(false);
  const [err, setErr] = useState("");
  const [reload, setReload] = useState(0);
  const reasonLabel = (r: string) => tr("reason." + r, r.replace(/_/g, " "));

  useEffect(() => {
    let alive = true;
    (async () => {
      const cfg = await chainConfig();
      const i = await jget<View["i"]>("/api/intents/" + id);
      if (!i.txHash) { if (alive) setEmpty(true); return; }
      const rpc = new JsonRpcProvider(cfg.rpcUrl), pay = new Contract(cfg.pay, PAY_ABI, rpc);
      const [rc, head, p] = await Promise.all([rpc.getTransactionReceipt(i.txHash), rpc.getBlockNumber(), pay.payments(i.quote.intentId)]);
      const log = rc && rc.logs.map((l) => { try { return pay.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "PaymentReceived" && e.args.intentId === i.quote.intentId);
      const payer = (i.payer || "").toLowerCase();
      const checks: Check[] = [
        [t("rc.txOk", { chain: cfg.chainId }), !!rc && rc.status === 1],
        [t("rc.emitted", { addr: short(cfg.pay) }), !!log && !!rc && rc.logs.some((l) => l.address.toLowerCase() === cfg.pay.toLowerCase())],
        [t("rc.amountOk", { amount: usdt(i.amount) }), !!log && log.args.amount.toString() === i.amount && p.amount.toString() === i.amount],
        [t("rc.tokenOk", { addr: short(cfg.token) }), !!log && log.args.token.toLowerCase() === cfg.token.toLowerCase()],
        [t("rc.payerOk", { addr: short(i.payer) }), !!log && log.args.payer.toLowerCase() === payer],
      ];
      // Public refund receipts: each refund is re-checked against its own transaction.
      const list = i.refunds.filter((r) => r.status === "active");
      let verified = 0n;
      const refundRows = await Promise.all(list.map(async (r: any) => {
        const rrc = await rpc.getTransactionReceipt(r.tx).catch(() => null);
        const ev = rrc && rrc.logs.filter((l) => l.address.toLowerCase() === cfg.pay.toLowerCase())
          .map((l) => { try { return pay.interface.parseLog(l); } catch { return null; } })
          .find((e) => e && e.name === "Refunded" && e.args.intentId === i.quote.intentId && e.args.amount.toString() === r.amount);
        if (ev) verified += ev.args.amount;
        const reason = ev ? (() => { try { return decodeBytes32String(ev.args.reason); } catch { return String(ev.args.reason); } })() : r.reason;
        return { ok: !!ev, line: t("rc.refundLine", { amount: usdt(r.amount), to: short(ev ? ev.args.to : r.to), reason: reasonLabel(reason) }), tx: r.tx as string };
      }));
      if (alive) setView({ i, cfg, checks, ok: checks.every((c) => c[1]), block: rc?.blockNumber ?? 0, confs: rc ? head - rc.blockNumber + 1 : 0,
        onchain: { amount: p.amount, refunded: p.refunded }, refundRows, refundsAdd: list.length ? verified === BigInt(p.refunded) : null });
    })().catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reload]);

  if (err) return <div className="notice bad">{err}</div>;
  if (empty) return <div className="card"><div className="notice">{t("rc.noPayment")}</div></div>;
  if (!view) return <div className="card"><div className="mut">…</div></div>;
  const { i, cfg, checks, ok, onchain } = view, tx = explorerTx(cfg, i.txHash!);
  return (
    <>
      <div className="card" aria-live="polite">
        <h2>{ok ? t("rc.verified") : t("rc.failed")}</h2>
        {checks.map(([label, good]) => <div key={label} className={`check ${good ? "ok" : "no"}`}>{label}</div>)}
        <div style={{ marginTop: 14 }}>
          <div className="kv"><span>{t("rc.item")}</span><span>{i.description}</span></div>
          <div className="kv"><span>{t("rc.fiat")}</span><span>{money(Math.round((i as unknown as { fiatAmount: number }).fiatAmount * 100), (i as unknown as { currency: string }).currency)}</span></div>
          <div className="kv"><span>{t("rc.block")}</span><span dir="ltr">{num(view.block, { useGrouping: false })} / {num(view.confs)}</span></div>
          <div className="kv"><span>{t("rc.refunded")}</span><span dir="ltr">{usdt(onchain.refunded.toString())} USDT</span></div>
          <div className="kv"><span>{i.gasless ? t("rc.gasMerchant") : t("rc.gasPayer")}</span><span dir="ltr">{i.fee?.gasWei ? formatEther(i.fee.gasWei) + " WBT" : "—"}</span></div>
          <div className="kv"><span>{t("rc.tx")}</span><span>{tx ? <a href={tx} target="_blank" rel="noreferrer" className="mono">{short(i.txHash)}</a> : <span className="mono">{short(i.txHash)}</span>}</span></div>
        </div>
        <div className="mut small" style={{ marginTop: 10 }}>{t("rc.checked", { rpc: cfg.rpcUrl })}</div>
      </div>
      {view.refundRows.length || i.refundRequests.length ? (
        <div className="card">
          <h2>{t("rc.refunds")}</h2>
          {view.refundRows.length ? view.refundRows.map((r) => <div key={r.tx} className={`check ${r.ok ? "ok" : "no"}`}>{r.line} · {explorerTx(cfg, r.tx) ? <a href={explorerTx(cfg, r.tx)!} target="_blank" rel="noreferrer" className="mono">{short(r.tx)}</a> : short(r.tx)}</div>) : <div className="mut">{t("rc.noRefunds")}</div>}
          {view.refundsAdd !== null ? <div className={`check ${view.refundsAdd ? "ok" : "no"}`}>{t("rc.refundsAdd", { amount: usdt(onchain.refunded.toString()) })}</div> : null}
          {i.refundRequests.map((q) => (
            <div className="kv" key={q.id}><span>{t("rc.request", { amount: usdt(q.amount), reason: reasonLabel(q.reason) })}</span><span>{tr("st." + q.status, q.status)}{q.status === "rejected" && q.resolution ? ": " + q.resolution : ""}</span></div>
          ))}
        </div>
      ) : null}
      <RequestForm i={i} cfg={cfg} onchain={onchain} onSent={() => setTimeout(() => setReload((n) => n + 1), 1500)} reasonLabel={reasonLabel} />
    </>
  );
}

/** Only the paying wallet can ask: the request is signed (EIP-191) and checked by the server. */
function RequestForm({ i, cfg, onchain, onSent, reasonLabel }: { i: View["i"]; cfg: ChainConfig; onchain: Onchain; onSent: () => void; reasonLabel: (r: string) => string }) {
  const { t } = useI18n();
  const left = onchain.amount - onchain.refunded;
  const [amount, setAmount] = useState(String(Number(left) / 1e6));
  const [reason, setReason] = useState(cfg.refundReasons?.[0] ?? "other");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  if (left <= 0n || i.refundRequests.some((q) => q.status === "open")) return null;
  async function go() {
    try {
      const units = String(BigInt(Math.round(Number(amount) * 1e6)));
      const c = await connectWallet();
      if (c.address.toLowerCase() !== (i.payer || "").toLowerCase()) throw new Error(t("rc.switchWallet", { addr: short(i.payer) }));
      // The signed text stays in English on purpose: the server verifies this exact canonical message.
      const signature = await c.signer.signMessage(`WhitePay refund request\nPayment: ${i.id}\nAmount: ${units}\nReason: ${reason}`);
      await jpost(`/api/intents/${i.id}/refund-requests`, { amount: units, reason, note, signature });
      setMsg({ kind: "ok", text: t("rc.requestSent") }); onSent();
    } catch (e) { setMsg({ kind: "bad", text: customerError(e, t) }); }
  }
  return (
    <div className="card">
      <h2>{t("rc.needRefund")}</h2><p className="mut">{t("rc.needRefundNote", { addr: short(i.payer) })}</p>
      <div className="row">
        <div className="field"><label htmlFor="qa">{t("rc.amountMax", { max: usdt(left.toString()) })}</label><input id="qa" type="number" step="0.000001" value={amount} dir="ltr" onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="field"><label htmlFor="qr">{t("rc.reason")}</label><select id="qr" value={reason} onChange={(e) => setReason(e.target.value)}>{(cfg.refundReasons ?? []).map((r) => <option key={r} value={r}>{reasonLabel(r)}</option>)}</select></div>
      </div>
      <div className="field" style={{ marginTop: 12 }}><label htmlFor="qn">{t("rc.noteOpt")}</label><input id="qn" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <button className="btn" onClick={go}>{t("rc.signRequest")}</button>
      {msg ? <div className={`notice ${msg.kind}`} role="alert">{msg.text}</div> : null}
    </div>
  );
}
