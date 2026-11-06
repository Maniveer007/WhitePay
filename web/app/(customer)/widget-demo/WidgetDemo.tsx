"use client";
import Script from "next/script";
import { useEffect, useState } from "react";
import { jpost } from "@/lib/customer";

declare global { interface Window { WhitePay?: any } }

/** A live demo of widget.js: the embeddable script merchants add to their own sites. */
export function WidgetDemo() {
  const [ready, setReady] = useState(false);
  const [ids, setIds] = useState<[string, string] | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const add = (m: string) => setLog((l) => [...l, m]);
  const origin = typeof window === "undefined" ? "" : location.origin;

  useEffect(() => {
    (async () => {
      const mk = async (item: string) => new URL((await jpost<{ checkoutUrl: string }>("/api/demo/checkout", { item })).checkoutUrl, location.origin).searchParams.get("i")!;
      setIds([await mk("sticker"), await mk("hoodie")]);
    })().catch((e) => add("error: " + e.message));
  }, []);
  useEffect(() => {
    if (!ready || !ids) return;
    window.WhitePay?.upgrade();
    const onPaid = (e: Event) => add(`whitepay:paid ${(e as CustomEvent).detail.id} (${(e as CustomEvent).detail.status})`);
    document.addEventListener("whitepay:paid", onPaid);
    return () => document.removeEventListener("whitepay:paid", onPaid);
  }, [ready, ids]);

  return (
    <>
      <Script src="/widget.js" strategy="afterInteractive" onReady={() => setReady(true)} />
      <h1>Embeddable checkout</h1>
      <p className="mut">Add WhitePay to any site with one script tag. Your server creates the payment (keeping the API key secret); the page only gets the payment id.</p>
      <div className="grid">
        <div className="card"><h2>No-code button</h2>
          <p className="mut">{ids ? <button className="btn" data-whitepay-payment={ids[0]}>Pay with USDT</button> : "Creating a demo payment…"}</p>
          <pre className="code">{`<script src="${origin}/widget.js" async></script>\n<button data-whitepay-payment="pay_…">Pay with USDT</button>`}</pre></div>
        <div className="card"><h2>Modal (iframe)</h2>
          <p className="mut">{ids ? <button className="btn" onClick={() => window.WhitePay?.checkout(ids[1], { mode: "modal", onStatus: (s: any) => add(`status ${s.id}: ${s.status}`), onPaid: (s: any) => add(`paid ${s.id}`), onClose: () => add("closed") })}>Open modal checkout</button> : "…"}</p>
          <pre className="code">{`WhitePay.checkout("pay_…", {\n  mode: "modal", lang: "hi",\n  onPaid: (p) => showThanks(p.id),\n});`}</pre></div>
      </div>
      <div className="card"><h2>Events received from checkout</h2><div className="mono mut" style={{ whiteSpace: "pre-wrap" }}>{log.length ? log.join("\n") : "—"}</div>
        <p className="mut small">These browser events are for UX. Fulfil orders from the <code>payment.fulfillable</code> webhook, which is signed and can't be faked.</p></div>
    </>
  );
}
