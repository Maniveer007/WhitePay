"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Contract, JsonRpcProvider, getAddress } from "ethers";
import { useI18n } from "@/components/I18n";
import { chainConfig, connectWallet, friendlyError, type ChainConfig } from "@/lib/wallet";
import { ERC20 } from "@/lib/abi";
import { jget } from "@/lib/customer";
import { short, usdt } from "@/lib/format";

type Ctx = Awaited<ReturnType<typeof connectWallet>>;
type Ext = { agent: string | null; metered: string | null };
const METER_W = ["function cancel(uint256)", "function setSeats(uint256,uint32)"];
const AGENT_W = ["function setPolicy(address,uint128,uint128,uint64,bool)", "function revoke(address)", "function allowMerchant(address,uint256,bool)"];
const TABS = [["pay", "Payments"], ["sub", "Subscriptions"], ["allow", "Allowances"], ["meter", "Usage meters"], ["agent", "AI agents"]] as const;
type Tab = (typeof TABS)[number][0];

export function PortalClient({ initialAddress }: { initialAddress: string | null }) {
  const { T } = useI18n();
  const [cfg, setCfg] = useState<ChainConfig | null>(null);
  const [ext, setExt] = useState<Ext>({ agent: null, metered: null });
  const [input, setInput] = useState("");
  const [address, setAddress] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("pay");
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [version, setVersion] = useState(0); // bump to reload the open panel
  const ctx = useRef<Ctx | null>(null);

  const say = (text: string, kind: "ok" | "bad" = "ok") => setMsg({ kind, text });
  const fail = useCallback((e: unknown) => setMsg({ kind: "bad", text: friendlyError(e) }), []);
  const view = useCallback((a: string) => {
    try { const x = getAddress(a); setAddress(x); setInput(x); setMsg(null); try { localStorage.setItem("wp.addr", x); } catch {} }
    catch { say(T("That is not a valid address."), "bad"); }
  }, [T]);

  useEffect(() => {
    Promise.all([chainConfig(), jget<Ext>("/api/extensions")]).then(([c, e]) => { setCfg(c); setExt(e); }).catch(fail);
    let saved: string | null = null; try { saved = localStorage.getItem("wp.addr"); } catch {}
    if (initialAddress || saved) view((initialAddress || saved)!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Changes need the wallet being viewed to be the connected one. */
  const needWallet = async () => {
    ctx.current ||= await connectWallet();
    if (address && ctx.current.address.toLowerCase() !== address.toLowerCase()) throw new Error(T("Connect the wallet you are viewing to make changes."));
    return ctx.current;
  };
  const act = async (fn: (c: Ctx) => Promise<{ wait: () => Promise<unknown> }>, ok: string) => {
    try { const c = await needWallet(); await (await fn(c)).wait(); say(ok); setTimeout(() => setVersion((v) => v + 1), 2000); } catch (e) { fail(e); }
  };

  return (
    <>
      <h1>{T("My account")}</h1>
      <p className="mut">{T("Everything you have paid, subscribed to, and allowed, read straight from the chain. Nothing here needs a password.")}</p>
      <div className="card">
        <div className="row">
          <div className="field"><label htmlFor="addr">{T("Wallet address")}</label><input id="addr" placeholder="0x…" dir="ltr" autoComplete="off" value={input} onChange={(e) => setInput(e.target.value)} /></div>
          <button className="btn" onClick={() => view(input.trim())}>{T("View")}</button>
          <button className="btn secondary" onClick={async () => { try { ctx.current = await connectWallet(); view(ctx.current.address); } catch (e) { fail(e); } }}>{T("Connect wallet")}</button>
        </div>
        {msg ? <div className={`notice ${msg.kind}`} role="alert">{msg.text}</div> : null}
      </div>
      <nav className="tabs" aria-label="Sections">
        {TABS.map(([k, l]) => <a key={k} href={`#${k}`} className={tab === k ? "on" : ""} onClick={(e) => { e.preventDefault(); setTab(k); }}>{T(l)}</a>)}
      </nav>
      <div className="card">
        {!address || !cfg ? <span className="mut">{T("Enter an address or connect a wallet.")}</span> : (
          <Panel key={`${tab}:${address}:${version}`} tab={tab} address={address} cfg={cfg} ext={ext} act={act} fail={fail} say={say} />
        )}
      </div>
    </>
  );
}

type PanelProps = { tab: Tab; address: string; cfg: ChainConfig; ext: Ext; act: (fn: (c: Ctx) => Promise<{ wait: () => Promise<unknown> }>, ok: string) => void; fail: (e: unknown) => void; say: (t: string, k?: "ok" | "bad") => void };

function Panel(p: PanelProps) {
  const { T } = useI18n();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      const { tab, address, cfg, ext } = p;
      if (tab === "pay") return jget(`/api/customers/${address}/payments`);
      if (tab === "sub") return jget(`/api/customers/${address}/subscriptions`);
      if (tab === "meter") return jget(`/api/customers/${address}/meters`);
      if (tab === "agent") return jget(`/api/customers/${address}/agents`);
      const t = new Contract(cfg.token, ERC20, new JsonRpcProvider(cfg.rpcUrl));
      const spenders: [string, string][] = [[T("WhitePay payments and subscriptions"), cfg.pay], ...(ext.metered ? ([[T("Usage meters"), ext.metered]] as [string, string][]) : [])];
      const vals = await Promise.all(spenders.map(([, a]) => t.allowance(address, a)));
      return spenders.map(([n, a], i) => ({ name: n, addr: a, value: vals[i] as bigint }));
    })().then((d) => alive && setData(d ?? []), (e) => alive && setError(e.message));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (error) return <div className="notice bad">{error}</div>;
  if (data === null) return <span className="mut">{T("Loading…")}</span>;
  if (p.tab === "pay") return <Payments rows={data} />;
  if (p.tab === "sub") return <Subs subs={data} />;
  if (p.tab === "allow") return <Allowances rows={data} act={p.act} cfg={p.cfg} />;
  if (p.tab === "meter") return <Meters ms={data} act={p.act} ext={p.ext} />;
  return <Agents paid={data} p={p} />;
}

function Payments({ rows }: { rows: any[] }) {
  const { T, tr, dateTime } = useI18n();
  if (!rows.length) return <span className="mut">{T("No payments yet.")}</span>;
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>{T("Date")}</th><th>{T("Merchant")}</th><th>{T("Description")}</th><th>{T("Amount")}</th><th>{T("Status")}</th><th /></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id}><td className="small nowrap">{r.paidAt ? dateTime(r.paidAt) : "—"}</td><td>{r.merchant}</td><td>{r.description || "—"}</td>
          <td dir="ltr">{usdt(r.amount)} USDT{BigInt(r.refunded || 0) > 0n ? <><br /><span className="mut">{T("Refunded")}: {usdt(r.refunded)}</span></> : null}</td>
          <td><span className="badge">{tr("st." + r.status, r.status)}</span></td><td><a href={`/receipt?i=${r.id}`}>{T("receipt")}</a></td></tr>
      ))}</tbody>
    </table></div>
  );
}

function Subs({ subs }: { subs: any[] }) {
  const { T, dateTime } = useI18n();
  return (
    <>
      {subs.length ? subs.map((s) => (
        <div className="kv" key={s.id}><span>#{s.id} · {usdt(s.amount)} USDT</span>
          <span><span className={`badge ${s.status === "active" ? "ok" : ""}`}>{String(s.status).replace("_", " ")}</span> {T("Next charge")}: {dateTime(s.nextCharge)}</span></div>
      )) : <span className="mut">{T("No subscriptions yet.")}</span>}
      <p style={{ marginTop: 14 }}><a className="btn secondary" href="/subscribe">{T("Manage subscriptions")}</a></p>
    </>
  );
}

function Allowances({ rows, act, cfg }: { rows: { name: string; addr: string; value: bigint }[]; act: PanelProps["act"]; cfg: ChainConfig }) {
  const { T } = useI18n();
  return (
    <>
      <p className="mut">{T("How much USDT each service is allowed to pull from your wallet. Revoking stops future charges immediately.")}</p>
      {rows.map((r) => (
        <div className="kv" key={r.addr}><span>{r.name}<br /><span className="mono mut">{r.addr}</span></span>
          <span dir="ltr">{usdt(r.value.toString())} USDT {r.value > 0n ? <button className="btn secondary sm" onClick={() => act((c) => new Contract(cfg.token, ERC20, c.signer).approve(r.addr, 0), T("Allowance revoked."))}>{T("revoke")}</button> : null}</span></div>
      ))}
    </>
  );
}

function Meters({ ms, act, ext }: { ms: any[]; act: PanelProps["act"]; ext: Ext }) {
  const { T } = useI18n();
  const [seats, setSeats] = useState<Record<number, string>>({});
  if (!ms.length) return <span className="mut">{T("No usage meters yet.")}</span>;
  return (
    <>{ms.map((m) => (
      <div key={m.id} style={{ borderTop: "1px solid var(--line)", padding: "10px 0" }}>
        <b>#{m.id}</b> <span className={`badge ${m.cancelled ? "" : "ok"}`}>{m.cancelled ? T("cancelled") : "active"}</span>
        <div className="kv"><span>{T("Seats")}</span><span>{m.seats}{m.pendingSeats ? ` → ${m.pendingSeats}` : ""} × {usdt(m.seatPrice)} USDT</span></div>
        <div className="kv"><span>{T("Usage price")}</span><span dir="ltr">{usdt(m.unitPrice)} USDT / unit · {T("budget")} {usdt(m.usageBudget)} / {Math.round(m.period / 86400)}d</span></div>
        <div className="kv"><span>{T("Charged / your cap")}</span><span dir="ltr">{usdt(m.charged)} / {usdt(m.cap)} USDT</span></div>
        {m.cancelled ? null : (
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <input type="number" min="1" value={seats[m.id] ?? m.seats} onChange={(e) => setSeats({ ...seats, [m.id]: e.target.value })} style={{ width: 90 }} />
            <button className="btn secondary sm" onClick={() => act((c) => new Contract(ext.metered!, METER_W, c.signer).setSeats(m.id, Number(seats[m.id] ?? m.seats)), T("Seat change submitted."))}>{T("Set seats")}</button>
            <button className="btn secondary sm" onClick={() => confirm(T("Cancel this subscription? No further charges will be made.")) && act((c) => new Contract(ext.metered!, METER_W, c.signer).cancel(m.id), T("Cancelled. No further charges."))}>{T("Cancel")}</button>
          </div>
        )}
      </div>
    ))}</>
  );
}

function Agents({ paid, p }: { paid: any[]; p: PanelProps }) {
  const { T, dateTime } = useI18n();
  const [agent, setAgent] = useState(""), [perPay, setPerPay] = useState("10"), [perDay, setPerDay] = useState("50"), [days, setDays] = useState("30");
  const [out, setOut] = useState<{ kind: "ok" | "bad" | ""; text: string }>({ kind: "", text: "" });
  const A = () => getAddress(agent.trim());
  async function check() {
    try {
      const x = await jget<any>(`/api/agents/policy?owner=${p.address}&agent=${A()}`);
      setOut(x.active ? { kind: "ok", text: `${T("Active")}: ${usdt(x.perPayment)} / ${usdt(x.perDay)} USDT · ${T("used today")} ${usdt(x.usedToday)} · ${dateTime(x.expiry)}` } : { kind: "", text: T("No active policy.") });
    } catch (e) { p.fail(e); }
  }
  return (
    <>
      <p className="mut">{T("Let an AI agent pay for you within limits you set. It spends from your wallet; you can revoke it at any time.")}</p>
      <div className="field"><label htmlFor="ag">{T("Agent address")}</label><input id="ag" placeholder="0x…" dir="ltr" value={agent} onChange={(e) => setAgent(e.target.value)} /></div>
      <div className="row">
        <div className="field"><label htmlFor="ppay">{T("Max per payment (USDT)")}</label><input id="ppay" type="number" value={perPay} onChange={(e) => setPerPay(e.target.value)} /></div>
        <div className="field"><label htmlFor="pday">{T("Max per day (USDT)")}</label><input id="pday" type="number" value={perDay} onChange={(e) => setPerDay(e.target.value)} /></div>
        <div className="field"><label htmlFor="pdays">{T("Valid for (days)")}</label><input id="pdays" type="number" value={days} onChange={(e) => setDays(e.target.value)} /></div>
      </div>
      <div className="row" style={{ gap: 8, margin: "12px 0" }}>
        <button className="btn" onClick={() => { try { const a = A(); p.act((c) => new Contract(p.ext.agent!, AGENT_W, c.signer).setPolicy(a, BigInt(Math.round(Number(perPay) * 1e6)), BigInt(Math.round(Number(perDay) * 1e6)), Math.floor(Date.now() / 1000) + Number(days) * 86400, false), T("Policy granted.")); } catch (e) { p.fail(e); } }}>{T("Grant spending policy")}</button>
        <button className="btn secondary" onClick={() => { try { const a = A(); p.act((c) => new Contract(p.ext.agent!, AGENT_W, c.signer).revoke(a), T("Agent revoked.")); } catch (e) { p.fail(e); } }}>{T("Revoke agent")}</button>
        <button className="btn secondary" onClick={check}>{T("Check policy")}</button>
      </div>
      {out.text ? <div className={`notice ${out.kind}`}>{out.text}</div> : null}
      <h2 style={{ marginTop: 18 }}>{T("Recent agent payments")}</h2>
      {paid.length ? (
        <div className="table-wrap"><table><thead><tr><th>{T("Agent address")}</th><th>{T("Amount")}</th></tr></thead>
          <tbody>{paid.slice(-20).reverse().map((x, i) => <tr key={i}><td className="mono">{x.agent}</td><td dir="ltr">{usdt(x.amount)} USDT</td></tr>)}</tbody></table></div>
      ) : <span className="mut">{T("Nothing yet.")}</span>}
    </>
  );
}
