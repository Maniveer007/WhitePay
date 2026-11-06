"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/components/I18n";
import { jget, jpost } from "@/lib/customer";
import { usdt } from "@/lib/format";

export type PublicInvoice = {
  id: string; number: string; status: string; currency: string; issueDate: number; dueDate: number; terms: string; notes: string | null; poRef: string | null;
  merchant: { name: string; color: string | null; taxId: string; address: string };
  client: { name: string; email?: string; taxId?: string };
  items: { description: string; qty: number; unitPrice: number; taxBps: number; net: number; tax: number }[];
  subtotal: number; tax: number; lateFee: number; lateFeePercent: number; discountsApplied: number; total: number; paid: number; balance: number;
  allowPartial: boolean; minPartial: number; payNowFull: number; discountAvailable: number; earlyDiscountPercent: number;
  payments: { paymentId: string; amount: number; original: number; usdt: string; refunded: string; finality: string; paidAt: number | null }[];
};
const TONE: Record<string, string> = { paid: "ok", partially_paid: "brand", open: "brand", overdue: "bad", void: "", credited: "warn" };

export function InvoiceClient({ id, initial }: { id: string; initial: PublicInvoice }) {
  const { t, tr, num, money: fmt, date, dir } = useI18n();
  const [inv, setInv] = useState(initial);
  const [part, setPart] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const poll = setInterval(() => { if (!document.hidden && !document.activeElement?.closest("input")) jget<PublicInvoice>(`/api/invoices/${id}`).then(setInv).catch(() => {}); }, 5000);
    return () => clearInterval(poll);
  }, [id]);
  useEffect(() => { document.title = `${inv.number} · ${inv.merchant?.name ?? "Invoice"}`; }, [inv.number, inv.merchant?.name]);

  const m = inv.merchant, c = inv.currency, money = (v: number) => <span dir="ltr">{fmt(v, c)}</span>;
  const terms = inv.terms && inv.terms !== "custom" ? ` (${tr("terms." + inv.terms, inv.terms.replace("_", " "))})` : "";
  async function start(body: object) {
    try { const r = await jpost<{ checkoutUrl: string }>(`/api/invoices/${id}/pay`, body); location.href = r.checkoutUrl; } catch (e: any) { setMsg(e.message); }
  }
  const canPay = inv.balance > 0 && inv.status !== "void";
  const disc = inv.discountAvailable ? " " + t("inv.inclDiscount", { pct: num(inv.earlyDiscountPercent) }) : "";

  return (
    <div style={{ ["--brandc" as string]: m?.color || "var(--brand)" }}>
      <div className="card invoice" aria-live="polite">
        <div className="inv-head">
          <div><div style={{ fontWeight: 700, fontSize: 18 }}>{m?.name}</div>
            {m?.address ? <div className="mut">{m.address}</div> : null}{m?.taxId ? <div className="mut">{t("inv.taxId", { id: m.taxId })}</div> : null}</div>
          <div className="end"><div className="inv-num">{t("inv.title", { number: inv.number })}</div>
            <div><span className={`badge ${TONE[inv.status] ?? ""}`}>{tr("st." + inv.status, inv.status)}</span></div>
            <div className="mut">{t("inv.issued", { date: date(inv.issueDate) })} · {t("inv.due", { date: date(inv.dueDate) })}{terms}</div></div>
        </div>
        <div className="row" style={{ margin: "18px 0", alignItems: "flex-start" }}>
          <div><div className="mut">{t("inv.billTo")}</div><div style={{ fontWeight: 600 }}>{inv.client.name}</div>
            {inv.client.email ? <div dir="ltr">{inv.client.email}</div> : null}{inv.client.taxId ? <div className="mut">{t("inv.taxId", { id: inv.client.taxId })}</div> : null}</div>
          {inv.poRef ? <div><div className="mut">{t("inv.po")}</div><div>{inv.poRef}</div></div> : null}
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>{t("inv.desc")}</th><th className="end">{t("inv.qty")}</th><th className="end">{t("inv.unit")}</th><th className="end">{t("inv.tax")}</th><th className="end">{t("inv.amount")}</th></tr></thead>
            <tbody>{inv.items.map((it, n) => (
              <tr key={n}><td>{it.description}</td><td className="end">{num(it.qty)}</td><td className="end">{money(it.unitPrice)}</td><td className="end">{num(it.taxBps / 100)}%</td><td className="end">{money(it.net + it.tax)}</td></tr>
            ))}</tbody>
          </table>
        </div>
        <div className="totals">
          <div className="kv"><span>{t("inv.subtotal")}</span><span>{money(inv.subtotal)}</span></div>
          <div className="kv"><span>{t("inv.tax")}</span><span>{money(inv.tax)}</span></div>
          {inv.lateFee ? <div className="kv"><span>{t("inv.lateFee", { pct: num(inv.lateFeePercent) })}</span><span>{money(inv.lateFee)}</span></div> : null}
          {inv.discountsApplied ? <div className="kv"><span>{t("inv.discount")}</span><span>−{money(inv.discountsApplied)}</span></div> : null}
          <div className="kv"><span>{t("inv.total")}</span><span>{money(inv.total + inv.lateFee - inv.discountsApplied)}</span></div>
          <div className="kv"><span>{t("inv.paid")}</span><span>{money(inv.paid)}</span></div>
          <div className="kv big"><span>{t("inv.balance")}</span><span>{money(inv.balance)}</span></div>
        </div>
        {inv.notes ? <p className="mut" style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>{inv.notes}</p> : null}
        {inv.payments.length ? (
          <>
            <h2 style={{ marginTop: 18 }}>{t("inv.payments")}</h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th>{t("inv.date")}</th><th>{t("inv.amount")}</th><th>{t("inv.paidUsdt")}</th><th>{t("inv.status")}</th><th className="noprint" /></tr></thead>
                <tbody>{inv.payments.map((p) => (
                  <tr key={p.paymentId}>
                    <td>{p.paidAt ? date(p.paidAt) : "—"}</td>
                    <td>{p.amount !== p.original ? <s className="mut">{money(p.original)} </s> : null}{money(p.amount)}</td>
                    <td dir="ltr">{usdt(p.usdt)}{BigInt(p.refunded) > 0n ? <span className="mut"> {t("inv.refundedX", { amount: usdt(p.refunded) })}</span> : null}</td>
                    <td><span className="badge">{tr("st." + p.finality, p.finality)}</span></td>
                    <td className="noprint"><a href={`/receipt?i=${p.paymentId}`}>{t("inv.verify")}</a></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </>
        ) : null}
        <p className="mut small" style={{ marginTop: 16 }}>{t("inv.footnote")}</p>
        <p className="noprint"><button className="btn secondary" onClick={() => window.print()}>{t("inv.print")}</button></p>
      </div>

      {canPay ? (
        <div className="card noprint">
          <h2>{t("inv.payTitle")}</h2>
          <button className="btn full lg" onClick={() => start({ full: true })}>{t("inv.payFull", { amount: fmt(inv.payNowFull, c) })}{disc}</button>
          {inv.allowPartial ? (
            <div style={{ marginTop: 16 }}>
              <div className="row">
                <div className="field"><label htmlFor="part">{t("inv.payPartLabel", { min: fmt(Math.min(inv.minPartial || 1, inv.balance), c), max: fmt(inv.balance, c) })}</label>
                  <input id="part" type="number" step="0.01" min="0" max={inv.balance / 100} dir="ltr" placeholder={t("inv.amountIn", { ccy: c })} value={part} onChange={(e) => setPart(e.target.value)} /></div>
                <button className="btn secondary" onClick={() => start({ amount: Number(part) })}>{t("inv.payPart")}</button>
              </div>
              <div className="mut small" style={{ marginTop: 6 }}>{t("inv.partNote")}</div>
            </div>
          ) : null}
          {msg ? <div className="notice bad" role="alert" dir={dir}>{msg}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
