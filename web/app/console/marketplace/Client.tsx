"use client";
import { useCallback, useEffect, useState } from "react";
import { Contract, ContractFactory, getAddress, isAddress, encodeBytes32String, parseUnits } from "ethers";
import { connectWallet, friendlyError } from "@/lib/wallet";
import { PAY_ABI, SPLITTER_ACTIONS } from "@/lib/abi";
import { usdt, short } from "@/lib/format";
import { Card, Notice } from "@/components/ui";

type Fee = { recipient: string; bps: number; holdDays: number; arbiter: string };
type SplitterState = { address: string; seller: string; arbiter: string; holdSeconds: number; totalSplitBps: number; recipients: { address: string; bps: number }[]; held: string; unswept: string; trancheCount: number; payoutOf: number[]; token: string };
type Msg = { kind: "ok" | "bad" | "warn"; text: string } | null;

export function Splitters({ payout, merchantId, platformFee, readOnly }: { payout: string | null; merchantId: number; platformFee: Fee | null; readOnly: boolean }) {
  const [rows, setRows] = useState<{ a: string; p: string }[]>([{ a: platformFee?.recipient ?? "", p: platformFee ? String(platformFee.bps / 100) : "" }]);
  const [seller, setSeller] = useState(""); const [arbiter, setArbiter] = useState(platformFee?.arbiter ?? "");
  const [hold, setHold] = useState(String(platformFee?.holdDays ?? 7));
  const [deployMsg, setDeployMsg] = useState<Msg>(null); const [busy, setBusy] = useState(false);
  const [addr, setAddr] = useState(payout ?? "");
  const [state, setState] = useState<SplitterState | null>(null); const [loadErr, setLoadErr] = useState("");
  const [actMsg, setActMsg] = useState<Msg>(null);
  const [retTo, setRetTo] = useState(""); const [retAmt, setRetAmt] = useState("");

  const load = useCallback(async (a: string) => {
    setLoadErr(""); setState(null);
    if (!a) return;
    const r = await fetch(`/api/splitters/${a}`); const j = await r.json();
    if (!r.ok) setLoadErr(j.error?.message ?? "Not a split contract"); else setState(j);
  }, []);
  useEffect(() => { if (payout) load(payout); }, [payout, load]);

  async function deploy() {
    setBusy(true); setDeployMsg(null);
    try {
      const { signer, address } = await connectWallet();
      const list = rows.filter((r) => r.a.trim() || r.p).map((r) => [r.a.trim(), Math.round(Number(r.p) * 100)] as const);
      const total = list.reduce((s, r) => s + r[1], 0);
      if (list.some(([a, b]) => !isAddress(a) || !(b > 0))) throw new Error("Each recipient needs a valid wallet and a percentage above 0");
      if (total > 10000) throw new Error("Fees can't add up to more than 100%");
      const sel = seller.trim() || address, arb = arbiter.trim() || sel;
      if (!isAddress(sel) || !isAddress(arb)) throw new Error("Seller and arbiter must be valid wallets");
      if (!confirm(`Create a split contract? Fees ${total / 100}% to ${list.length} recipient(s); the seller's share is held ${hold} days. These rules cannot be changed afterwards.`)) return;
      const art = await (await fetch("/api/splitter-artifact")).json();
      const c = await new ContractFactory(art.abi, art.bytecode, signer).deploy(sel, arb, list.map((r) => r[0]), list.map((r) => r[1]), Math.round(Number(hold || 0) * 86400));
      await c.waitForDeployment();
      const a = await c.getAddress();
      setDeployMsg({ kind: "ok", text: `Created at ${a}. Now set it as your payout wallet below.` });
      setAddr(a); await load(a);
    } catch (e) { setDeployMsg({ kind: "bad", text: friendlyError(e) }); } finally { setBusy(false); }
  }

  async function act(kind: "sweep" | "release" | "queue" | "apply" | "return") {
    setBusy(true); setActMsg(null);
    try {
      const { signer, cfg } = await connectWallet();
      const sp = new Contract(addr, SPLITTER_ACTIONS, signer), pay = new Contract(cfg.pay, PAY_ABI, signer);
      let tx;
      if (kind === "sweep") tx = await sp.sweep(cfg.token);
      else if (kind === "release") tx = await sp.release(cfg.token);
      else if (kind === "queue") tx = await pay.queuePayout(merchantId, getAddress(addr));
      else if (kind === "apply") tx = await pay.applyPayout(merchantId);
      else {
        const amt = parseUnits(retAmt || "0", 6);
        if (amt <= 0n) throw new Error("Enter an amount to return");
        tx = await sp.returnHeld(cfg.token, getAddress(retTo.trim()), amt, encodeBytes32String("refund"));
      }
      await tx.wait();
      setActMsg({ kind: "ok", text: "Done." }); setTimeout(() => load(addr), 1500);
    } catch (e) { setActMsg({ kind: "bad", text: friendlyError(e) }); } finally { setBusy(false); }
  }

  const isPayout = state?.payoutOf.includes(merchantId);
  return (
    <>
      {readOnly ? null : (
        <Card title="Create a split contract" subtitle="The rules live in a small contract that cannot be changed after it is created. You create it from your own wallet, then point your payout wallet at it (this change waits for the usual payout timelock).">
          {platformFee ? <Notice kind="ok">This platform suggests a {platformFee.bps / 100}% fee to {short(platformFee.recipient)} with a {platformFee.holdDays}-day hold. The form is pre-filled.</Notice> : null}
          <div className="row">
            <div className="field"><label htmlFor="seller">Seller wallet (receives the held share)</label><input id="seller" value={seller} onChange={(e) => setSeller(e.target.value)} placeholder="Defaults to your connected wallet" dir="ltr" spellCheck={false} /></div>
            <div className="field"><label htmlFor="arbiter">Arbiter (can return held funds to buyers)</label><input id="arbiter" value={arbiter} onChange={(e) => setArbiter(e.target.value)} placeholder="Defaults to the seller" dir="ltr" spellCheck={false} /></div>
            <div className="field" style={{ maxWidth: 140 }}><label htmlFor="hold">Hold (days)</label><input id="hold" type="number" min="0" value={hold} onChange={(e) => setHold(e.target.value)} /></div>
          </div>
          <label style={{ marginTop: 14 }}>Fee recipients (up to 10, total at most 100%)</label>
          {rows.map((r, i) => (
            <div className="row" key={i} style={{ marginBottom: 8 }}>
              <div className="field" style={{ flex: "3 1 260px" }}><input aria-label="Recipient wallet" placeholder="Recipient wallet 0x…" value={r.a} dir="ltr" spellCheck={false} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)))} /></div>
              <div className="field" style={{ maxWidth: 160 }}><input aria-label="Percent of each payment" type="number" step="0.01" min="0" placeholder="% of each payment" value={r.p} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, p: e.target.value } : x)))} /></div>
              {rows.length > 1 ? <button className="btn ghost sm" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label="Remove recipient">✕</button> : null}
            </div>
          ))}
          <div className="row" style={{ gap: 8 }}>
            {rows.length < 10 ? <button className="btn secondary sm" onClick={() => setRows((rs) => [...rs, { a: "", p: "" }])}>+ Add recipient</button> : null}
            <button className="btn" disabled={busy} onClick={deploy}>{busy ? "Waiting for wallet…" : "Create split contract"}</button>
          </div>
          {deployMsg ? <Notice kind={deployMsg.kind}>{deployMsg.text}</Notice> : null}
        </Card>
      )}
      <Card title="Manage a split contract">
        <div className="row">
          <div className="field" style={{ flex: "3 1 320px" }}><label htmlFor="addr">Split contract address</label><input id="addr" value={addr} onChange={(e) => setAddr(e.target.value)} dir="ltr" spellCheck={false} /></div>
          <button className="btn secondary" onClick={() => load(addr.trim())}>Load</button>
        </div>
        {loadErr ? <Notice kind="bad">{loadErr}</Notice> : null}
        {state ? (
          <div className="stack" style={{ marginTop: 14 }}>
            <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 18px", margin: 0 }}>
              <dt className="mut">Seller</dt><dd className="mono" style={{ margin: 0 }}>{state.seller}</dd>
              <dt className="mut">Arbiter</dt><dd className="mono" style={{ margin: 0 }}>{state.arbiter}</dd>
              <dt className="mut">Hold</dt><dd style={{ margin: 0 }}>{state.holdSeconds / 86400} days</dd>
              <dt className="mut">Fees</dt><dd style={{ margin: 0 }}>{state.recipients.map((r) => `${short(r.address)} ${r.bps / 100}%`).join(", ") || "none"} (seller keeps {(10000 - state.totalSplitBps) / 100}%)</dd>
              <dt className="mut">Held for seller</dt><dd style={{ margin: 0 }}>{usdt(state.held)} USDT in {state.trancheCount} batch(es)</dd>
              <dt className="mut">Received, not split yet</dt><dd style={{ margin: 0 }}>{usdt(state.unswept)} USDT</dd>
              <dt className="mut">Your payout wallet</dt><dd style={{ margin: 0 }}>{isPayout ? "Yes: payments flow through this contract" : `No: payments still go to ${short(payout)}`}</dd>
            </dl>
            {readOnly ? null : (
              <>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn secondary sm" disabled={busy} onClick={() => act("sweep")}>Split new funds</button>
                  <button className="btn secondary sm" disabled={busy} onClick={() => act("release")}>Release matured seller funds</button>
                  {isPayout ? null : <><button className="btn sm" disabled={busy} onClick={() => act("queue")}>Set as my payout wallet</button><button className="btn secondary sm" disabled={busy} onClick={() => act("apply")}>Apply (after the timelock)</button></>}
                </div>
                <div className="row">
                  <div className="field" style={{ flex: "3 1 260px" }}><label htmlFor="rt">Return held funds to a buyer (arbiter or seller)</label><input id="rt" value={retTo} onChange={(e) => setRetTo(e.target.value)} placeholder="Buyer wallet 0x…" dir="ltr" spellCheck={false} /></div>
                  <div className="field" style={{ maxWidth: 160 }}><label htmlFor="ra">USDT</label><input id="ra" type="number" min="0" step="0.01" value={retAmt} onChange={(e) => setRetAmt(e.target.value)} /></div>
                  <button className="btn secondary" disabled={busy} onClick={() => act("return")}>Return</button>
                </div>
              </>
            )}
            {actMsg ? <Notice kind={actMsg.kind}>{actMsg.text}</Notice> : null}
          </div>
        ) : null}
      </Card>
    </>
  );
}
