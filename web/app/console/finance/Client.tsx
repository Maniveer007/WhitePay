"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { bff, useAction } from "@/lib/client";
import { FlashNotice } from "@/components/Flash";
import { Card, Table, StatusBadge, Notice } from "@/components/ui";
import { day, humanize } from "@/lib/format";

const toTs = (v: string) => (v ? Math.floor(Date.parse(v + "T00:00:00Z") / 1000) : 0);

export function Statements() {
  const { flash, run } = useAction();
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const FORMATS: [string, string][] = [["xlsx", "Excel"], ["pdf", "PDF"], ["csv", "CSV"], ["xero", "Xero journal"], ["quickbooks", "QuickBooks journal"]];
  async function download(f: string) {
    await run(async () => {
      const end = to ? toTs(to) + 86400 : Math.floor(Date.now() / 1000) + 86400 * 400;
      const r = await fetch(`/bff/statements?format=${f}&from=${toTs(from)}&to=${end}`);
      if (!r.ok) throw new Error((await r.json()).error?.message ?? "Download failed");
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(await r.blob()), download: `statement.${f === "xero" || f === "quickbooks" ? f + ".csv" : f}` });
      a.click(); URL.revokeObjectURL(a.href);
    });
  }
  return (
    <Card title="Statements and accounting exports" subtitle="Built from the append-only ledger, so they always agree with the chain. Amounts are in USDT.">
      <div className="row">
        <div className="field" style={{ maxWidth: 190 }}><label htmlFor="sf">From</label><input id="sf" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field" style={{ maxWidth: 190 }}><label htmlFor="st">To</label><input id="st" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        {FORMATS.map(([f, l]) => <button key={f} className="btn secondary" onClick={() => download(f)}>{l}</button>)}
      </div>
      <FlashNotice flash={flash} />
    </Card>
  );
}

export function Periods({ periods, readOnly }: { periods: any[]; readOnly: boolean }) {
  const router = useRouter();
  const { flash, run } = useAction();
  async function close(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    if (await run(() => bff("periods/close", { body: { from: toTs(String(f.get("from"))), to: toTs(String(f.get("to"))) + 86400 } }), "Period closed")) router.refresh();
  }
  async function reopen(id: string) {
    const reason = prompt("Reason for reopening this period (recorded)");
    if (reason && (await run(() => bff(`periods/${id}/reopen`, { body: { reason } }), "Period reopened"))) router.refresh();
  }
  return (
    <Card title="Period close" subtitle="Closing locks a period with a snapshot hash. Back-dated invoices and credit notes into it are refused, and any later ledger change inside it shows as drift.">
      <Table head={["Period", "Status", "Hash", ""]} empty="No periods closed yet.">
        {periods.map((p) => (
          <tr key={p.id}><td>{p.label}</td><td><StatusBadge status={p.status === "closed" ? (p.drift ? "failed" : "finalized") : "seen"} />{" "}<span className="small mut">{p.status}{p.drift ? " · drift" : ""}</span></td>
            <td className="mono">{p.hash.slice(0, 16)}…</td><td>{p.status === "closed" && !readOnly ? <button className="btn ghost sm" onClick={() => reopen(p.id)}>Reopen</button> : null}</td></tr>
        ))}
      </Table>
      {readOnly ? null : (
        <form onSubmit={close} className="row" style={{ marginTop: 14 }}>
          <div className="field" style={{ maxWidth: 190 }}><label htmlFor="pf">From</label><input id="pf" name="from" type="date" required /></div>
          <div className="field" style={{ maxWidth: 190 }}><label htmlFor="pt">Through</label><input id="pt" name="to" type="date" required /></div>
          <button className="btn">Close period</button>
        </form>
      )}
      <FlashNotice flash={flash} />
    </Card>
  );
}

export function Auditor({ readOnly }: { readOnly: boolean }) {
  const { flash, run } = useAction();
  const [key, setKey] = useState("");
  return (
    <Card title="Auditor access" subtitle="A read-only key for your accountant or auditor. It can read everything in this console and change nothing.">
      {readOnly ? <p className="mut">Not available with an auditor key.</p> : (
        <div className="row" style={{ alignItems: "center" }}>
          <button className="btn" onClick={async () => { const r = await run(() => bff("auditor-key", { body: {} })); if (r) setKey(r.auditorKey); }}>Create auditor key</button>
          <button className="btn secondary" onClick={async () => { if (await run(() => bff("auditor-key/revoke", { body: {} }), "Auditor key revoked")) setKey(""); }}>Revoke</button>
        </div>
      )}
      {key ? <div className="notice warn">Shown once. Give it to your auditor: <span className="mono">{key}</span></div> : null}
      <FlashNotice flash={flash} />
    </Card>
  );
}

export function Recurring({ items, readOnly, blocked }: { items: any[]; readOnly: boolean; blocked?: boolean }) {
  const router = useRouter();
  const { flash, run } = useAction();
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    if (await run(() => bff("recurring-invoices", { body: { frequency: f.get("frequency"), template: { clientName: f.get("client"), currency: "USD", items: [{ description: f.get("description"), unitPrice: Number(f.get("amount")) }] } } }), "Schedule created")) router.refresh();
  }
  const act = async (id: string, a: string) => { if (await run(() => bff(`recurring-invoices/${id}/${a}`, { body: {} }))) router.refresh(); };
  return (
    <Card title="Recurring invoices" subtitle="Issue the same invoice on a schedule. A paused schedule never back-bills the periods it missed.">
      {blocked ? <Notice kind="warn">Recurring invoices need a paid plan. <a href="/console/plan">See plans</a></Notice> : null}
      <Table head={["Client", "Schedule", "Next run", "Runs", "Status", ""]} empty="No schedules yet.">
        {items.map((x) => (
          <tr key={x.id}><td>{x.template.clientName}</td><td>every {x.every} {x.frequency.replace("ly", "")}</td><td className="small">{day(x.nextRun)}</td><td>{x.runs}{x.maxRuns ? ` / ${x.maxRuns}` : ""}</td><td><StatusBadge status={x.status} /></td>
            <td className="nowrap">{readOnly ? null : <>
              {x.status === "active" ? <button className="btn ghost sm" onClick={() => act(x.id, "pause")}>Pause</button> : null}
              {x.status === "paused" ? <button className="btn ghost sm" onClick={() => act(x.id, "resume")}>Resume</button> : null}
              {["active", "paused"].includes(x.status) ? <button className="btn ghost sm" onClick={() => act(x.id, "cancel")}>Cancel</button> : null}</>}</td></tr>
        ))}
      </Table>
      {readOnly || blocked ? null : (
        <form onSubmit={create} style={{ marginTop: 14 }}>
          <h3>New recurring invoice</h3>
          <div className="row">
            <div className="field"><label htmlFor="client">Client name</label><input id="client" name="client" required /></div>
            <div className="field"><label htmlFor="description">Description</label><input id="description" name="description" defaultValue="Monthly retainer" required /></div>
            <div className="field" style={{ maxWidth: 140 }}><label htmlFor="amount">Amount (USD)</label><input id="amount" name="amount" type="number" step="0.01" min="0.01" defaultValue={500} required /></div>
            <div className="field" style={{ maxWidth: 160 }}><label htmlFor="frequency">Frequency</label><select id="frequency" name="frequency" defaultValue="monthly"><option>weekly</option><option>monthly</option><option>quarterly</option><option>yearly</option></select></div>
            <button className="btn">Create schedule</button>
          </div>
        </form>
      )}
      <FlashNotice flash={flash} />
    </Card>
  );
}

export function CreditNotes({ notes, readOnly }: { notes: any[]; readOnly: boolean }) {
  const router = useRouter();
  const { flash, run } = useAction();
  async function issue(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    if (await run(() => bff(`invoices/${String(f.get("invoice")).trim()}/credit-notes`, { body: { amount: Number(f.get("amount")), reason: f.get("reason") } }), "Credit note issued. If the invoice was already paid, the refund is on the Invoices page.")) router.refresh();
  }
  return (
    <Card title="Credit notes" subtitle="Reduce what a client owes. If they have already paid, the invoice shows a refund you can send with one click.">
      <Table head={["Number", "Invoice", "Date", "Amount", "Reason"]} empty="No credit notes yet.">
        {notes.map((x) => <tr key={x.id}><td>{x.number}</td><td className="mono">{x.invoiceId}</td><td className="small">{day(x.createdAt)}</td><td>{(x.amount / 100).toFixed(2)} {x.currency}</td><td>{humanize(x.reason)}</td></tr>)}
      </Table>
      {readOnly ? null : (
        <form onSubmit={issue} className="row" style={{ marginTop: 14 }}>
          <div className="field" style={{ flex: "2 1 240px" }}><label htmlFor="invoice">Invoice id</label><input id="invoice" name="invoice" placeholder="inv_…" required /></div>
          <div className="field" style={{ maxWidth: 140 }}><label htmlFor="amount2">Amount</label><input id="amount2" name="amount" type="number" step="0.01" min="0.01" required /></div>
          <div className="field"><label htmlFor="reason">Reason</label><select id="reason" name="reason">{["adjustment", "returned_goods", "pricing_error", "goodwill", "cancelled_service", "other"].map((r) => <option key={r} value={r}>{humanize(r)}</option>)}</select></div>
          <button className="btn">Issue credit note</button>
        </form>
      )}
      <FlashNotice flash={flash} />
    </Card>
  );
}

export function TestClock({ now }: { now: string }) {
  const router = useRouter();
  const { flash, run } = useAction();
  const adv = async (s: number) => { if (await run(() => bff("test-clock/advance", { body: { seconds: s } }))) router.refresh(); };
  return (
    <Card title="Test clock" subtitle={`Local chain only. Moves the server and chain clocks forward to watch renewals, reminders and recurring invoices happen. Now: ${now}`}>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn secondary" onClick={() => adv(86400)}>+1 day</button><button className="btn secondary" onClick={() => adv(604800)}>+1 week</button><button className="btn secondary" onClick={() => adv(2592000)}>+30 days</button>
      </div>
      <FlashNotice flash={flash} />
    </Card>
  );
}
