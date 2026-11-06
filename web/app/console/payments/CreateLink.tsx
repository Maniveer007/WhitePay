"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { bff, useAction } from "@/lib/client";
import { FlashNotice } from "@/components/Flash";
import { QrCode } from "@/components/QrCode";
import { Card } from "@/components/ui";
import { usdt } from "@/lib/format";

export function CreateLink() {
  const router = useRouter();
  const { pending, flash, run } = useAction();
  const [link, setLink] = useState<{ url: string; amount: string; what: string } | null>(null);
  const [copied, setCopied] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await run(() => bff("intents", { body: { amount: Number(f.get("amount")), currency: f.get("currency"), description: f.get("description") || undefined, policy: f.get("policy") } }));
    if (r) { setLink({ url: location.origin + r.checkoutUrl, amount: r.amount, what: String(f.get("description") || "your order") }); setCopied(false); router.refresh(); }
  }
  const msg = link ? `Pay for ${link.what}: ${link.url}` : "";
  return (
    <Card title="Get paid: create a payment link" subtitle="Send the link or QR code to a customer. They pay from their own wallet, and the money comes straight to you.">
      <form onSubmit={submit}>
        <div className="row">
          <div className="field" style={{ maxWidth: 160 }}><label htmlFor="amount">Amount</label><input id="amount" name="amount" type="number" step="0.01" min="0.01" defaultValue={25} required /></div>
          <div className="field" style={{ maxWidth: 140 }}><label htmlFor="currency">Currency</label><select id="currency" name="currency" defaultValue="USD">{["USD", "EUR", "INR", "GBP", "USDT"].map((c) => <option key={c}>{c}</option>)}</select></div>
          <div className="field" style={{ flex: "2 1 240px" }}><label htmlFor="description">What is it for?</label><input id="description" name="description" placeholder="Consulting invoice" /></div>
          <div className="field" style={{ maxWidth: 260 }}><label htmlFor="policy">Mark as paid when</label>
            <select id="policy" name="policy" defaultValue="safe">
              <option value="seen">It appears on the network (fastest)</option><option value="safe">It's confirmed (recommended)</option><option value="finalized">It's fully final (most secure)</option><option value="auto">Automatically, by amount</option>
            </select></div>
          <button className="btn" disabled={pending}>{pending ? "Creating…" : "Create link"}</button>
        </div>
        <p className="hint">Small, low-risk sales can use the fastest option. For large or hard-to-reverse sales, choose a more secure one.</p>
      </form>
      <FlashNotice flash={flash} />
      {link ? (
        <div className="notice ok" style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
          <QrCode value={link.url} />
          <div style={{ flex: "1 1 260px" }}>
            <b>Ready: {usdt(link.amount)} USDT</b>, valid for 15 minutes (the customer can ask for a fresh price).
            <div className="mono" style={{ margin: "6px 0" }}><a href={link.url} target="_blank" rel="noreferrer">{link.url}</a></div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn secondary sm" type="button" onClick={() => navigator.clipboard.writeText(link.url).then(() => setCopied(true))}>{copied ? "Copied" : "Copy link"}</button>
              <a className="btn secondary sm" href={`https://wa.me/?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer">Share on WhatsApp</a>
              <a className="btn secondary sm" href={`mailto:?subject=${encodeURIComponent("Payment link")}&body=${encodeURIComponent(msg)}`}>Share by email</a>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
