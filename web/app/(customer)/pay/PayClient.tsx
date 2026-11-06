"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Contract, TypedDataEncoder } from "ethers";
import { useI18n } from "@/components/I18n";
import { WalletLinks } from "@/components/WalletLinks";
import { chainConfig, connectWallet, type ChainConfig } from "@/lib/wallet";
import { ERC20, PAY_ABI } from "@/lib/abi";
import { customerError, jget, jpost, PAID_STATUSES, type PublicPayment } from "@/lib/customer";
import { usdt } from "@/lib/format";

const QUOTE_TYPES = { Quote: [{ name: "merchantId", type: "uint256" }, { name: "intentId", type: "bytes32" }, { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "expiry", type: "uint64" }] };
const RWA_TYPES = { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };
const STEPS = ["seen", "safe", "finalized"] as const;
type Ctx = Awaited<ReturnType<typeof connectWallet>>;
type Note = { kind: "ok" | "bad"; text: string } | null;

export function PayClient({ id, inv }: { id: string; inv: string | null }) {
  const { t, tr, num, money, dir } = useI18n();
  const [cfg, setCfg] = useState<ChainConfig | null>(null);
  const [intent, setIntent] = useState<PublicPayment | null>(null);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [fatal, setFatal] = useState("");
  const [label, setLabel] = useState<string | null>(null); // wallet-step text shown on the active button
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const busy = useRef(false); // don't refresh under an open wallet prompt
  const lastPosted = useRef("");

  /** Tell the embedding page (widget popup opener or iframe parent) about status changes. UX only: merchants verify server-side. */
  const postStatus = useCallback((i: PublicPayment) => {
    const target = window.opener || (window.parent !== window ? window.parent : null), key = i.status + i.fulfillable;
    if (!target || key === lastPosted.current) return;
    lastPosted.current = key;
    target.postMessage({ source: "whitepay", payment: { id: i.id, status: i.status, fulfillable: i.fulfillable, txHash: i.txHash, amount: i.amount } }, "*");
  }, []);
  const refresh = useCallback(async () => {
    if (busy.current) return;
    const i = await jget<PublicPayment>("/api/intents/" + id);
    setIntent(i); postStatus(i);
  }, [id, postStatus]);

  useEffect(() => {
    let alive = true;
    chainConfig().then(setCfg).catch((e) => alive && setFatal(e.message));
    refresh().catch((e) => alive && setFatal(e.message));
    const poll = setInterval(() => { if (!document.hidden && !busy.current) refresh().catch(() => {}); }, 2000);
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => { alive = false; clearInterval(poll); clearInterval(tick); };
  }, [refresh]);

  if (fatal) return <div className="notice bad">{fatal}</div>;
  if (!intent || !cfg) return <div className="card"><div className="mut">…</div></div>;

  const i = intent, s = i.status, paid = PAID_STATUSES.includes(s), idx = STEPS.indexOf(i.finality as (typeof STEPS)[number]);
  const amt = usdt(i.amount), left = Math.max(0, i.expiry - now);
  const fail = (e: unknown) => setNote({ kind: "bad", text: customerError(e, t) });

  async function onGasless() {
    busy.current = true; setNote(null);
    try {
      const c = ctx!, q = i.quote, tok = new Contract(cfg!.token, ERC20, c.provider);
      if ((await tok.balanceOf(c.address)) < BigInt(q.amount)) throw new Error(t("err.noUsdt"));
      // nonce = the quote's EIP-712 digest, so this signature can only ever settle this exact quote.
      const nonce = TypedDataEncoder.hash(cfg!.domain, QUOTE_TYPES, { merchantId: q.merchantId, intentId: q.intentId, token: q.token, amount: q.amount, expiry: q.expiry });
      setLabel(t("pay.sign"));
      const signature = await c.signer.signTypedData(cfg!.tokenDomain, RWA_TYPES, { from: c.address, to: cfg!.pay, value: q.amount, validAfter: 0, validBefore: q.expiry, nonce });
      setLabel(t("pay.submitting"));
      await jpost(`/api/intents/${id}/relay`, { payer: c.address, validAfter: 0, validBefore: q.expiry, signature });
      busy.current = false; setLabel(null); await refresh();
    } catch (e) { busy.current = false; setLabel(t("pay.retry")); fail(e); }
  }
  async function onGo() {
    busy.current = true; setNote(null);
    try {
      if (!ctx) { setCtx(await connectWallet()); busy.current = false; return; }
      const tok = new Contract(cfg!.token, ERC20, ctx.signer), pay = new Contract(cfg!.pay, PAY_ABI, ctx.signer), need = BigInt(i.amount), q = i.quote;
      if ((await tok.balanceOf(ctx.address)) < need) throw new Error(t("err.noUsdt"));
      if ((await tok.allowance(ctx.address, cfg!.pay)) < need) { setLabel(t("pay.approve")); await (await tok.approve(cfg!.pay, need)).wait(); }
      setLabel(t("pay.confirm"));
      await (await pay.pay([q.merchantId, q.intentId, q.token, q.amount, q.expiry], i.signature)).wait();
      busy.current = false; setLabel(null); await refresh();
    } catch (e) { busy.current = false; setLabel(null); fail(e); }
  }
  async function onRequote() { try { await jpost(`/api/intents/${id}/requote`); await refresh(); } catch (e) { fail(e); } }
  async function onFaucet() { try { await jpost("/api/faucet", { address: ctx!.address }); setNote({ kind: "ok", text: t("pay.faucetSent") }); } catch (e) { fail(e); } }

  const fiat = i.currency !== "USDT" ? `${money(Math.round(i.fiatAmount * 100), i.currency)} · ${t("pay.locked")}` : "";
  return (
    <div className="card" aria-live="polite">
      <div className="mut">{i.description || t("pay.payment")}{i.merchant?.name ? ` · ${i.merchant.name}` : ""}</div>
      <div className="pay-amount" dir="ltr">{amt} USDT</div>
      <div className="mut">{fiat} {s === "created" ? <span>· {t("pay.validFor", { m: num(Math.floor(left / 60)), s: num(left % 60) })}</span> : null}</div>

      {!paid && s !== "reorged" ? (
        s === "expired" ? (
          <>
            <div className="notice bad">{t("pay.expired")}</div>
            <button className="btn full" onClick={onRequote}>{t("pay.newQuote")}</button>
          </>
        ) : ctx && cfg.gasless ? (
          <div className="stack" style={{ marginTop: 16 }}>
            <button className="btn full lg" disabled={!!label && label !== t("pay.retry")} onClick={onGasless}>{label ?? t("pay.payGasless", { amount: amt })}</button>
            <button className="btn secondary full" disabled={!!label} onClick={onGo}>{t("pay.payFromWallet")}</button>
            {cfg.mockToken ? <button className="btn secondary full" onClick={onFaucet}>{t("pay.faucet")}</button> : null}
            <div className="mut small">{t("pay.gaslessNote")}</div>
          </div>
        ) : (
          <div className="stack" style={{ marginTop: 16 }}>
            <button className="btn full lg" disabled={!!label} onClick={onGo}>{label ?? (ctx ? t("pay.payAmount", { amount: amt }) : t("pay.connect"))}</button>
            {ctx && cfg.mockToken ? <button className="btn secondary full" onClick={onFaucet}>{t("pay.faucet")}</button> : null}
            {!ctx && typeof window !== "undefined" && !window.ethereum ? <WalletLinks /> : null}
            <div className="mut small">{t("pay.directNote")}</div>
          </div>
        )
      ) : (
        <div className="stack" style={{ marginTop: 16 }}>
          <ol className="timeline" aria-label="Confirmation progress">
            {STEPS.map((x, n) => <li key={x} className={n <= idx && s !== "reorged" ? "on" : ""}>{t("st." + x)}</li>)}
          </ol>
          <div><span className="badge ok">{tr("st." + s, s)}</span> <span className="mut">{t("pay.confirmations", { n: num(i.confirmations), policy: tr("st." + i.policy, i.policy) })}</span></div>
          {s === "reorged" ? <div className="notice bad">{t("pay.reorged")}</div> : null}
          {i.fulfillable ? <div className="notice ok">{t("pay.fulfilled")}</div> : null}
          {i.gasless ? <div className="mut small">{t("pay.sponsored")}</div> : null}
          <div className="row" style={{ gap: 8 }}>
            <a className="btn secondary" href={`/receipt?i=${i.id}`}>{t("pay.verify")}</a>
            {inv ? <a className="btn secondary" href={`/invoice?id=${encodeURIComponent(inv)}`}>{t("pay.backInvoice")}</a> : null}
          </div>
        </div>
      )}
      {note ? <div className={`notice ${note.kind}`} role="alert" dir={dir}>{note.text}</div> : null}
    </div>
  );
}
