import type { Metadata } from "next";
import { requireArea } from "@/lib/session";
import { getJson } from "@/lib/data";
import { when } from "@/lib/format";
import { PageHeader, Card, Table, StatusBadge, Notice, Badge } from "@/components/ui";
import { KeysPanel, ReplayButton, RetryButton } from "./Client";

export const metadata: Metadata = { title: "Developers" };
const TABS = [["keys", "Keys & setup"], ["webhooks", "Webhooks"], ["notifications", "Notifications"]] as const;

export default async function DevelopersPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { merchant: me, canWrite } = await requireArea("developers");
  const readOnly = !canWrite;
  const tab = (await searchParams).tab ?? "keys";
  return (
    <>
      <PageHeader title="Developers" subtitle="API keys, signed webhooks, and delivery logs." actions={<a className="btn secondary" href="/openapi.json" target="_blank" rel="noreferrer">API reference</a>} />
      <nav className="tabs" aria-label="Sections">{TABS.map(([k, l]) => <a key={k} href={`?tab=${k}`} className={tab === k ? "on" : ""}>{l}</a>)}</nav>
      {tab === "keys" ? <KeysPanel me={me} readOnly={readOnly} isDefault={me.uid === "mer_default"} /> : tab === "webhooks" ? <Webhooks readOnly={readOnly} /> : <Notifications readOnly={readOnly} />}
    </>
  );
}

async function Webhooks({ readOnly }: { readOnly: boolean }) {
  const { data, error } = await getJson<any[]>("/api/webhooks");
  return (
    <Card title="Webhook deliveries" subtitle="HMAC-signed, retried with backoff. Verify the X-WhitePay-Signature header with your signing secret.">
      {error ? <Notice kind="bad">{error}</Notice> : null}
      <Table head={["Event", "Time", "Attempts", "Status", ""]} empty="No webhook events yet.">
        {(data ?? []).map((w) => (
          <tr key={w.id}><td>{w.type}<div className="mono mut">{String(w.event_id).slice(0, 30)}</div></td><td className="small nowrap">{when(w.created_at)}</td><td>{w.attempts}</td>
            <td><StatusBadge status={w.status} /> <span className="small mut">{w.last_error}</span></td><td>{readOnly ? null : <ReplayButton id={w.id} />}</td></tr>
        ))}
      </Table>
    </Card>
  );
}

async function Notifications({ readOnly }: { readOnly: boolean }) {
  const [n, ch] = await Promise.all([getJson<any[]>("/api/notifications"), getJson<{ configured: string[]; available: string[] }>("/api/notifications/channels")]);
  return (
    <>
      <Card title="Notification channels" subtitle="Set these environment variables on the server. Unconfigured channels are logged below instead of sent.">
        <div className="row" style={{ gap: 8 }}>{(ch.data?.available ?? []).map((c) => <Badge key={c} tone={ch.data?.configured.includes(c) ? "ok" : ""}>{c}: {ch.data?.configured.includes(c) ? "on" : "off"}</Badge>)}</div>
        <p className="small mut" style={{ marginTop: 12 }}><code>SLACK_WEBHOOK_URL</code>, <code>TELEGRAM_BOT_TOKEN</code> + <code>TELEGRAM_CHAT_ID</code>, <code>WHATSAPP_TOKEN</code> + <code>WHATSAPP_PHONE_ID</code>, <code>RESEND_API_KEY</code> + <code>EMAIL_FROM</code></p>
      </Card>
      <Card title="Outbox">
        <Table head={["Time", "Channel", "To", "Message", "Status", ""]} empty="Nothing yet.">
          {(n.data ?? []).map((x) => (
            <tr key={x.id}><td className="small nowrap">{when(x.created_at)}</td><td>{x.channel}</td><td className="mono">{x.recipient}</td>
              <td><b>{x.subject}</b><div className="mut small" style={{ whiteSpace: "pre-wrap", maxWidth: 420 }}>{String(x.body).slice(0, 240)}</div></td>
              <td><StatusBadge status={x.status} />{x.last_error ? <div className="mut small">{x.last_error}</div> : null}</td>
              <td>{!readOnly && ["failed", "pending"].includes(x.status) ? <RetryButton id={x.id} /> : null}</td></tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
