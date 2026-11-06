"use client";
import { useState } from "react";
import { useI18n } from "@/components/I18n";
import { jpost } from "@/lib/customer";

export function StoreClient() {
  const { T } = useI18n();
  const [item, setItem] = useState("sticker");
  const [policy, setPolicy] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function buy() {
    setBusy(true); setErr("");
    try {
      // The store's backend creates the payment with its secret API key; the browser never sees the key.
      const p = await jpost<{ checkoutUrl: string }>("/api/demo/checkout", { item, policy });
      location.href = p.checkoutUrl;
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }
  return (
    <>
      <h1>{T("Get paid in USDT on Whitechain.")}</h1>
      <p className="mut">{T("Non-custodial checkout where the contract enforces the rules: exact amounts, capped refunds, customer-controlled subscriptions, and a payout address a stolen API key can't change.")}</p>
      <div className="grid" style={{ marginTop: 20 }}>
        <div className="card">
          <h2>{T("Demo store")}</h2>
          <p className="mut">{T("A merchant using the WhitePay API. Pick an item to create a payment intent.")}</p>
          <div className="stack">
            <div className="field"><label htmlFor="item">{T("Item")}</label>
              <select id="item" value={item} onChange={(e) => setItem(e.target.value)}><option value="sticker">Sticker pack — $12</option><option value="hoodie">Hoodie — $49</option><option value="pass">Conference pass — ₹999</option></select></div>
            <div className="field"><label htmlFor="policy">{T("Release goods at")}</label>
              <select id="policy" value={policy} onChange={(e) => setPolicy(e.target.value)}>
                <option value="auto">Auto by amount (&lt;$20 seen, &lt;$500 safe, else finalized)</option><option value="seen">Seen (instant, risky)</option><option value="safe">Safe (batch posted to L1)</option><option value="finalized">Finalized</option></select></div>
            <button className="btn full lg" onClick={buy} disabled={busy}>{T("Checkout with USDT")}</button>
            {err ? <div className="notice bad">{err}</div> : null}
          </div>
        </div>
        <div className="card">
          <h2>{T("What the contract guarantees")}</h2>
          {["Funds go wallet → merchant wallet, never held by WhitePay", "Quote is exact, signed and expires", "Refunds capped at amount paid; payer-signed fallback address", "Subscriptions: payer-set cap, end date, cancel anytime", "Payout change is timelocked; API key only signs quotes"].map((x) => <div className="check ok" key={x}>{T(x)}</div>)}
        </div>
      </div>
    </>
  );
}
