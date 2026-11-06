"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { bff, useAction } from "@/lib/client";
import { FlashNotice } from "@/components/Flash";
import { Card } from "@/components/ui";
import { minor } from "@/lib/format";

type Line = { description: string; qty: number; unitPrice: number; taxPercent: number };
const LANGS: Record<string, string> = { en: "English", hi: "हिन्दी", ta: "தமிழ்", te: "తెలుగు", mr: "मराठी", bn: "বাংলা", ar: "العربية" };

export function InvoiceForm() {
  const router = useRouter();
  const { pending, flash, run } = useAction();
  const [lines, setLines] = useState<Line[]>([{ description: "", qty: 1, unitPrice: 0, taxPercent: 0 }]);
  const [created, setCreated] = useState<{ url: string; number: string; total: number; currency: string } | null>(null);
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget), s = (k: string) => (String(f.get(k) ?? "").trim() || undefined);
    const body = {
      clientName: s("clientName"), clientEmail: s("clientEmail"), clientTaxId: s("clientTaxId"), clientPhone: s("clientPhone"), poRef: s("poRef"), language: f.get("language"),
      currency: f.get("currency"), terms: f.get("terms"), items: lines.filter((l) => l.description.trim()), notes: s("notes"),
      allowPartial: f.get("allowPartial") === "on", minPartial: Number(f.get("minPartial") || 0),
      lateFeePercent: Number(f.get("lateFee") || 0), earlyDiscountPercent: Number(f.get("earlyDiscount") || 0), earlyDiscountDays: Number(f.get("earlyDays")) || undefined,
    };
    const r = await run(() => bff("invoices", { body }));
    if (r) { setCreated({ url: `${location.origin}${r.url}&lang=${r.language}`, number: r.number, total: r.total, currency: r.currency }); router.refresh(); }
  }

  return (
    <Card title="New invoice">
      <form onSubmit={submit} className="stack">
        <div className="row">
          <div className="field"><label htmlFor="clientName">Client name *</label><input id="clientName" name="clientName" required /></div>
          <div className="field"><label htmlFor="clientEmail">Client email</label><input id="clientEmail" name="clientEmail" type="email" /></div>
          <div className="field"><label htmlFor="clientTaxId">Client tax ID (GSTIN / VAT)</label><input id="clientTaxId" name="clientTaxId" /></div>
        </div>
        <div className="row">
          <div className="field"><label htmlFor="poRef">PO reference</label><input id="poRef" name="poRef" /></div>
          <div className="field"><label htmlFor="clientPhone">Client WhatsApp</label><input id="clientPhone" name="clientPhone" placeholder="+919812345678" /></div>
          <div className="field"><label htmlFor="language">Invoice and email language</label><select id="language" name="language">{Object.entries(LANGS).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></div>
        </div>
        <div className="row">
          <div className="field"><label htmlFor="currency">Currency</label><select id="currency" name="currency">{["USD", "INR", "EUR", "GBP", "USDT"].map((c) => <option key={c}>{c}</option>)}</select></div>
          <div className="field"><label htmlFor="terms">Payment terms</label><select id="terms" name="terms" defaultValue="net_30"><option value="due_on_receipt">Due on receipt</option><option value="net_15">Net 15</option><option value="net_30">Net 30</option><option value="net_60">Net 60</option></select></div>
        </div>
        <div>
          <label>Line items</label>
          {lines.map((l, i) => (
            <div className="row" key={i} style={{ marginBottom: 8 }}>
              <div className="field" style={{ flex: "3 1 220px" }}><input aria-label="Description" placeholder="Description" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></div>
              <div className="field" style={{ maxWidth: 90 }}><input aria-label="Quantity" type="number" min="0" step="any" value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) })} /></div>
              <div className="field" style={{ maxWidth: 140 }}><input aria-label="Unit price" type="number" min="0" step="any" placeholder="Unit price" value={l.unitPrice || ""} onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) })} /></div>
              <div className="field" style={{ maxWidth: 100 }}><input aria-label="Tax percent" type="number" min="0" step="any" placeholder="Tax %" value={l.taxPercent || ""} onChange={(e) => setLine(i, { taxPercent: Number(e.target.value) })} /></div>
              <button type="button" className="btn ghost sm" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls))} aria-label="Remove line">✕</button>
            </div>
          ))}
          <button type="button" className="btn secondary sm" onClick={() => setLines((ls) => [...ls, { description: "", qty: 1, unitPrice: 0, taxPercent: 0 }])}>+ Add line</button>
        </div>
        <div className="row">
          <div className="field"><label><input type="checkbox" name="allowPartial" /> Allow partial payments</label><div className="hint">Deposits, milestones, or several payers.</div></div>
          <div className="field"><label htmlFor="minPartial">Minimum partial amount</label><input id="minPartial" name="minPartial" type="number" defaultValue={0} min="0" /></div>
          <div className="field"><label htmlFor="lateFee">Late fee % (one-time)</label><input id="lateFee" name="lateFee" type="number" defaultValue={0} min="0" step="any" /></div>
          <div className="field"><label htmlFor="earlyDiscount">Early-payment discount %</label><input id="earlyDiscount" name="earlyDiscount" type="number" defaultValue={0} min="0" step="any" /></div>
          <div className="field"><label htmlFor="earlyDays">…if paid within (days)</label><input id="earlyDays" name="earlyDays" type="number" defaultValue={10} min="1" /></div>
        </div>
        <div className="field"><label htmlFor="notes">Notes and payment instructions</label><input id="notes" name="notes" /></div>
        <FlashNotice flash={flash} />
        {created ? <div className="notice ok">Invoice {created.number} created, total {minor(created.total, created.currency)}. <a href={created.url} target="_blank" rel="noreferrer">Open the client's invoice page</a></div> : null}
        <div><button className="btn" disabled={pending}>{pending ? "Creating…" : "Create invoice"}</button></div>
      </form>
    </Card>
  );
}
