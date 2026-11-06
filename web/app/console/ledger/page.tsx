import type { Metadata } from "next";
import { getJson } from "@/lib/data";
import { requireArea } from "@/lib/session";
import { chainExplorer } from "@/lib/explorer";
import { usdt, short, when } from "@/lib/format";
import { PageHeader, Card, Table, Notice, Badge } from "@/components/ui";
import { LedgerCsv, ResolveButton } from "./Client";

export const metadata: Metadata = { title: "Ledger & checks" };
const TABS = [["ledger", "Ledger"], ["recon", "Reconciliation"], ["exceptions", "Exceptions"]] as const;

export default async function LedgerPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { canWrite } = await requireArea("ledger");
  const readOnly = !canWrite;
  const tab = (await searchParams).tab ?? "ledger";
  const explorer = await chainExplorer();
  return (
    <>
      <PageHeader title="Ledger & checks" subtitle="The append-only books, proof they match the chain, and money that arrived outside WhitePay." />
      <nav className="tabs" aria-label="Sections">{TABS.map(([k, l]) => <a key={k} href={`?tab=${k}`} className={tab === k ? "on" : ""}>{l}</a>)}</nav>
      {tab === "ledger" ? <Ledger explorer={explorer} /> : tab === "recon" ? <Recon /> : <Exceptions explorer={explorer} readOnly={readOnly} />}
    </>
  );
}

async function Ledger({ explorer }: { explorer: string }) {
  const { data, error } = await getJson<any[]>("/api/ledger");
  return (
    <Card title="Double-entry ledger" actions={<LedgerCsv />}>
      {error ? <Notice kind="bad">{error}</Notice> : null}
      <Table head={["Date", "Account", "Debit", "Credit", "Memo", "Onchain source"]} empty="No entries yet.">
        {(data ?? []).map((x) => (
          <tr key={x.id}><td className="small nowrap">{when(x.ts)}</td><td>{x.account}</td><td>{Number(x.debit) ? usdt(x.debit) : ""}</td><td>{Number(x.credit) ? usdt(x.credit) : ""}</td><td>{x.memo}</td>
            <td className="mono">{explorer && x.tx_hash ? <a href={`${explorer}/tx/${x.tx_hash}`} target="_blank" rel="noreferrer">{short(x.tx_hash)}</a> : short(x.tx_hash)} #{x.log_index}</td></tr>
        ))}
      </Table>
    </Card>
  );
}

async function Recon() {
  const { data: r, error } = await getJson<any>("/api/reconcile");
  if (!r) return <Notice kind="bad">{error}</Notice>;
  const net = BigInt(r.chain.paid) + BigInt(r.chain.subscriptions) - BigInt(r.chain.refunded);
  return (
    <Card title={r.ok ? "✓ The ledger matches the chain" : "✗ Mismatch detected"} subtitle="Re-derived from raw contract logs and compared to the ledger totals.">
      <Table head={["", "Chain", "Ledger"]}>
        <tr><td>Sales</td><td>{usdt(r.chain.paid)}</td><td>{usdt(r.ledger.sales)}</td></tr>
        <tr><td>Refunds</td><td>{usdt(r.chain.refunded)}</td><td>{usdt(r.ledger.refunds)}</td></tr>
        <tr><td>Subscriptions</td><td>{usdt(r.chain.subscriptions)}</td><td>{usdt(r.ledger.subscriptions)}</td></tr>
        <tr><td>Wallet balance (net)</td><td>{usdt(net)}</td><td>{usdt(r.ledger.walletBalance)}</td></tr>
      </Table>
      {r.ok ? <Badge tone="ok">Balanced</Badge> : <Notice kind="bad">The totals differ. Reload in a minute in case indexing is catching up; if it persists, contact support.</Notice>}
    </Card>
  );
}

async function Exceptions({ explorer, readOnly }: { explorer: string; readOnly: boolean }) {
  const { data, error } = await getJson<any[]>("/api/exceptions");
  const cfg = await getJson<any>("/api/config");
  return (
    <Card title="Exceptions" subtitle="Funds that reached your payout wallet outside WhitePay (exchange withdrawals, wrong token, manual sends). They can't be matched to an order automatically.">
      {error ? <Notice kind="bad">{error}</Notice> : null}
      <Table head={["Kind", "Token", "From", "Amount", "Tx", ""]} empty="No exceptions.">
        {(data ?? []).map((e) => (
          <tr key={e.key}><td><Badge tone={e.kind === "wrong_token" ? "bad" : "warn"}>{e.kind.replace("_", " ")}</Badge></td><td className="mono">{short(e.token)}</td><td className="mono">{short(e.sender)}</td>
            <td>{cfg.data && e.token.toLowerCase() === cfg.data.token.toLowerCase() ? `${usdt(e.amount)} USDT` : `${e.amount} (raw)`}</td>
            <td className="mono">{explorer ? <a href={`${explorer}/tx/${e.tx_hash}`} target="_blank" rel="noreferrer">{short(e.tx_hash)}</a> : short(e.tx_hash)}</td>
            <td>{e.resolved ? <span className="mut small">resolved</span> : readOnly ? null : <ResolveButton id={e.key} />}</td></tr>
        ))}
      </Table>
    </Card>
  );
}
