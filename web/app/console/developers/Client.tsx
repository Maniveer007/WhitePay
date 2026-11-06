"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { bff, useAction } from "@/lib/client";
import { FlashNotice } from "@/components/Flash";
import { Card, Notice } from "@/components/ui";
import type { Me } from "@/lib/session";

export function KeysPanel({ me, readOnly, isDefault }: { me: Me; readOnly: boolean; isDefault: boolean }) {
  const router = useRouter();
  const { flash, run } = useAction();
  const [secret, setSecret] = useState(""); const [newKey, setNewKey] = useState("");

  async function rotate() {
    if (!confirm("Issue a new API key? The current key stops working immediately. Update your servers right away.")) return;
    const r = await run(() => bff("merchants/me/rotate-key", { body: {} }));
    if (!r) return;
    setNewKey(r.apiKey);
    // Keep this browser signed in with the new key.
    await fetch("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: r.apiKey }) });
    router.refresh();
  }
  async function saveHook(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const url = String(new FormData(e.currentTarget).get("url") ?? "");
    if (await run(() => bff("merchants/me", { body: { webhookUrl: url } }), "Webhook URL saved")) router.refresh();
  }
  const [origin, setOrigin] = useState("https://YOUR-HOST");
  useEffect(() => setOrigin(location.origin), []);
  return (
    <>
      <Card title="API key" subtitle="For your developer: lets your website or app create payments automatically. You don't need one to use payment links or invoices from this console. Keep it secret; it can't move money or change your payout wallet.">
        <div className="row" style={{ alignItems: "center" }}>
          <span className="mono">…{me.apiKeyHint?.replace("…", "")}</span>
          {readOnly || isDefault ? null : <button className="btn secondary" onClick={rotate}>{me.apiKeyHint ? "Create a new key (replaces this one)" : "Create key"}</button>}
        </div>
        {isDefault ? <p className="mut small">This account's key comes from the server's API_KEY setting.</p> : null}
        {newKey ? <div className="notice warn">Your new key, shown once: <span className="mono">{newKey}</span></div> : null}
        <FlashNotice flash={flash} />
      </Card>
      <Card title="Webhooks" subtitle="Where WhitePay sends signed event notifications (payments, refunds, invoices, subscriptions).">
        <form onSubmit={saveHook} className="row">
          <div className="field" style={{ flex: "3 1 320px" }}><label htmlFor="url">Endpoint URL</label><input id="url" name="url" type="url" defaultValue={me.webhookUrl ?? ""} placeholder="https://example.com/webhooks/whitepay" disabled={readOnly} /></div>
          {readOnly ? null : <button className="btn">Save</button>}
        </form>
        {readOnly ? null : (
          <div style={{ marginTop: 14 }}>
            <button className="btn secondary sm" onClick={async () => { const r = await run(() => bff("webhook-secret")); if (r) setSecret(r.secret); }}>Reveal signing secret</button>
            {secret ? <div className="copy-box mono" style={{ marginTop: 8 }}>{secret}</div> : null}
          </div>
        )}
        <p className="small mut" style={{ marginTop: 12 }}>Testing locally? <code>whitepay listen --forward-to http://localhost:4242/hook</code> forwards signed events to your machine.</p>
      </Card>
      <Card title="Quick start">
        <pre className="code">{`curl -X POST ${origin}/api/v1/payments \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "amount": 49, "currency": "USD", "orderRef": "order_1042" }'`}</pre>
      </Card>
      <Card title="Your signing address" subtitle="What a stolen API key could and could not do.">
        <div className="stack small">
          <div><label>Quote signer (signs expiring quotes)</label><div className="copy-box mono">{me.signerAddress}</div></div>
          <div><label>Owner wallet (refunds, payout changes)</label><div className="copy-box mono">{me.owner ?? "—"}</div></div>
          <div><label>Payout wallet</label><div className="copy-box mono">{me.payout ?? "—"}</div></div>
          <Notice>The signer can only sign short-lived quotes that pay your payout wallet. It cannot refund, change the payout wallet, or move funds.</Notice>
        </div>
      </Card>
    </>
  );
}

export function ReplayButton({ id }: { id: number }) {
  const router = useRouter();
  return <button className="btn ghost sm" onClick={async () => { await bff(`webhooks/${id}/replay`, { body: {} }).catch(() => {}); router.refresh(); }}>Replay</button>;
}
export function RetryButton({ id }: { id: number }) {
  const router = useRouter();
  return <button className="btn ghost sm" onClick={async () => { await bff(`notifications/${id}/retry`, { body: {} }).catch(() => {}); router.refresh(); }}>Retry</button>;
}
