"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Contract } from "ethers";
import { useI18n } from "@/components/I18n";
import { connectWallet, friendlyError } from "@/lib/wallet";
import { ERC20, PAY_ABI } from "@/lib/abi";
import { jget } from "@/lib/customer";
import { short, usdt } from "@/lib/format";

type Plan = { id: number; name: string | null; amount: string; period: number; trial: number; introAmount: string; introCycles: number };
type Sub = { id: number; status: string; planId: number | null; amount: string; period: number; cap: string; charged: string; nextCharge: number; trialEndsAt: number | null; pendingPlanId: number | null; lastFailure: string | null; retryAt: number | null };
type Ctx = Awaited<ReturnType<typeof connectWallet>>;
const TONE: Record<string, string> = { active: "ok", trialing: "brand", past_due: "bad", unpaid: "bad", paused: "warn", cancelled: "" };
const per = (s: number) => (s % 2592000 === 0 ? `${s / 2592000} mo` : s % 604800 === 0 ? `${s / 604800} wk` : s % 86400 === 0 ? `${s / 86400} d` : `${s}s`);

export function SubscribeClient() {
  const { T, tr, dateTime } = useI18n();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [chosen, setChosen] = useState<Plan | null>(null);
  const [cap, setCap] = useState("");
  const [months, setMonths] = useState("12");
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [subs, setSubs] = useState<Sub[] | null>(null);
  const [allowance, setAllowance] = useState<bigint>(0n);
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const ctxRef = useRef<Ctx | null>(null);
  const say = (text: string, kind: "ok" | "bad" = "ok") => setMsg({ kind, text });
  const fail = (e: unknown) => say(friendlyError(e), "bad");
  const planLabel = (p?: Plan | null) => (p ? `${p.name || "Plan #" + p.id} · ${usdt(p.amount)} USDT / ${per(p.period)}` : T("Custom terms"));

  useEffect(() => { jget<Plan[]>("/api/plans").then(setPlans).catch(fail); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const loadMine = useCallback(async (c: Ctx | null = ctxRef.current) => {
    if (!c) return;
    const [list, al] = await Promise.all([jget<Sub[]>(`/api/customers/${c.address}/subscriptions`), new Contract(c.cfg.token, ERC20, c.provider).allowance(c.address, c.cfg.pay)]);
    setSubs(list); setAllowance(al);
  }, []);
  useEffect(() => {
    const poll = setInterval(() => { if (!document.hidden && ctxRef.current && !document.activeElement?.closest("select,input")) loadMine().catch(() => {}); }, 6000);
    return () => clearInterval(poll);
  }, [loadMine]);

  async function connect() {
    const c = ctxRef.current ?? (await connectWallet());
    ctxRef.current = c; setCtx(c); await loadMine(c);
    return c;
  }
  const act = async (fn: (c: Ctx) => Promise<{ wait: () => Promise<unknown> }>, ok: string) => {
    try { const c = await connect(); await (await fn(c)).wait(); say(ok); setTimeout(() => loadMine().catch(() => {}), 2500); } catch (e) { fail(e); }
  };
  const C = (c: Ctx) => new Contract(c.cfg.pay, PAY_ABI, c.signer);

  async function subscribe() {
    try {
      if (!chosen) return say(T("Pick a plan first."), "bad");
      const c = await connect(), capU = BigInt(Math.round(Number(cap) * 1e6)), end = Math.floor(Date.now() / 1000) + Number(months) * 2592000 + chosen.trial;
      const tok = new Contract(c.cfg.token, ERC20, c.signer);
      // Allowance is limited to exactly the cap: the token itself also refuses anything beyond it.
      if ((await tok.allowance(c.address, c.cfg.pay)) < capU) await (await tok.approve(c.cfg.pay, capU)).wait();
      await (await C(c).subscribeToPlan(chosen.id, capU, end)).wait();
      say(`${T("Subscribed to")} ${planLabel(chosen)}. ${chosen.trial ? T("Your trial has started.") : ""}`);
      setTimeout(() => loadMine().catch(() => {}), 2500);
    } catch (e) { fail(e); }
  }

  return (
    <>
      <div className="card">
        <h2>{T("Choose a plan")}</h2>
        <p className="mut">{T("The merchant sets the price. You set the spending cap and end date, and the contract never charges more. Pause or cancel any time, without asking the merchant.")}</p>
        {plans === null ? <div className="mut">{T("Loading plans…")}</div> : !plans.length ? <div className="mut">{T("This merchant hasn't published any plans yet.")}</div> : (
          <div className="stack">
            {plans.map((p) => (
              <label key={p.id} className="plan-choice">
                <input type="radio" name="plan" checked={chosen?.id === p.id} onChange={() => { setChosen(p); setCap(String((Number(p.amount) * 12) / 1e6)); }} />
                <span><b>{planLabel(p)}</b><br /><span className="mut">
                  {p.trial ? `${per(p.trial)} ${T("free trial")} · ` : ""}{p.introCycles ? `${T("first")} ${p.introCycles} ${T("charge(s) at")} ${usdt(p.introAmount)} USDT · ` : ""}{T("cancel any time")}</span></span>
              </label>
            ))}
          </div>
        )}
        {chosen ? (
          <div style={{ marginTop: 16 }}>
            <div className="row">
              <div className="field"><label htmlFor="cap">{T("Lifetime spending cap (USDT)")}</label><input id="cap" type="number" min="0" value={cap} onChange={(e) => setCap(e.target.value)} /></div>
              <div className="field"><label htmlFor="months">{T("Ends after (months)")}</label><input id="months" type="number" min="1" value={months} onChange={(e) => setMonths(e.target.value)} /></div>
            </div>
            <button className="btn full lg" style={{ marginTop: 12 }} onClick={subscribe}>{T("Connect wallet & subscribe")}</button>
          </div>
        ) : null}
        {msg ? <div className={`notice ${msg.kind}`} role="alert">{msg.text}</div> : null}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{T("My subscriptions")}</h2>
          <button className="btn secondary sm" onClick={() => connect().catch(fail)}>{ctx ? short(ctx.address) : T("Connect wallet")}</button>
        </div>
        {ctx ? (
          <div className="kv"><span>{T("Active USDT allowance to WhitePay")}</span>
            <span>{usdt(allowance.toString())} USDT {allowance > 0n ? <> · <a href="#" onClick={(e) => { e.preventDefault(); act((c) => new Contract(c.cfg.token, ERC20, c.signer).approve(c.cfg.pay, 0), T("Allowance revoked. Renewals will fail until you approve again.")); }}>{T("revoke")}</a></> : null}</span></div>
        ) : null}
        {!ctx ? <div className="mut">{T("Connect a wallet to see them.")}</div> : subs === null ? <div className="mut">…</div> : !subs.length ? <div className="mut">{T("No subscriptions yet.")}</div> : subs.map((s) => {
          const plan = plans?.find((p) => p.id === s.planId), others = (plans ?? []).filter((p) => p.id !== s.planId && p.period === s.period), live = s.status !== "cancelled";
          return (
            <div key={s.id} style={{ borderTop: "1px solid var(--line)", padding: "12px 0" }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <b>#{s.id} · {plan ? planLabel(plan) : `${usdt(s.amount)} USDT / ${per(s.period)}`}</b>
                <span className={`badge ${TONE[s.status] ?? ""}`}>{tr("st." + s.status, s.status.replace("_", " "))}</span>
              </div>
              <div className="kv"><span>{T("Charged / your cap")}</span><span>{usdt(s.charged)} / {usdt(s.cap)} USDT</span></div>
              {s.trialEndsAt ? <div className="kv"><span>{T("Trial ends")}</span><span>{dateTime(s.trialEndsAt)}</span></div> : null}
              {live && s.status !== "paused" ? <div className="kv"><span>{T("Next charge")}</span><span>{dateTime(s.nextCharge)}</span></div> : null}
              {s.pendingPlanId ? <div className="kv"><span>{T("Switching at next renewal to")}</span><span>{planLabel(plans?.find((p) => p.id === s.pendingPlanId))}</span></div> : null}
              {s.status === "past_due" ? <div className="notice bad">{T("Last renewal failed")} ({String(s.lastFailure || "").replace("_", " ")}). {T("We'll retry")} {s.retryAt ? dateTime(s.retryAt) : T("soon")}; {T("top up USDT or approve an allowance to keep it active.")}</div> : null}
              {live ? (
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  {s.status === "paused"
                    ? <button className="btn secondary sm" onClick={() => act((c) => C(c).resumeSubscription(s.id), T("Resumed."))}>{T("Resume")}</button>
                    : <button className="btn secondary sm" onClick={() => act((c) => C(c).pauseSubscription(s.id), T("Paused. No charges until you resume."))}>{T("Pause")}</button>}
                  {s.planId && others.length ? (
                    <select style={{ width: "auto" }} value="" onChange={(e) => e.target.value && act((c) => C(c).changePlan(s.id, e.target.value), T("Plan change submitted."))}>
                      <option value="">{T("Change plan…")}</option>
                      {others.map((p) => <option key={p.id} value={p.id}>{planLabel(p)}{BigInt(p.amount) > BigInt(s.amount) ? ` (${T("upgrade now, prorated")})` : ` (${T("from next renewal")})`}</option>)}
                    </select>
                  ) : null}
                  <button className="btn secondary sm" onClick={() => confirm(T("Cancel this subscription? No further charges will be made.")) && act((c) => C(c).cancel(s.id), T("Cancelled. No further charges."))}>{T("Cancel")}</button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}
