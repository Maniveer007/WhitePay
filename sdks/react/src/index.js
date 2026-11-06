// @whitepay/react: a pay button and a hook around the WhitePay checkout widget.
//   <PayButton host="https://pay.example.com" paymentId={payment.id} onPaid={(p) => …}>Pay with USDT</PayButton>
// Callbacks are for UX only. Ship goods only after your server sees the `payment.fulfillable` webhook.
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { loadWidget, openCheckout } from "./loader.js";

export { loadWidget, openCheckout };

/** const { open, ready, error } = useWhitePay(host); open("pay_…", { mode: "modal", onPaid }) */
export function useWhitePay(host) {
  const [ready, setReady] = useState(false), [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    loadWidget(host).then(() => live && setReady(true)).catch((e) => live && setError(e));
    return () => { live = false; };
  }, [host]);
  const open = useCallback((target, opts) => openCheckout(host, target, opts), [host]);
  return { ready, error, open };
}

export function PayButton({ host, paymentId, invoiceId, mode = "modal", lang, onPaid, onStatus, onClose, children, ...rest }) {
  const { ready, open } = useWhitePay(host);
  const cb = useRef({});
  cb.current = { onPaid, onStatus, onClose }; // latest callbacks without re-opening the checkout
  const target = paymentId || invoiceId;
  return createElement("button", {
    type: "button", disabled: !ready || !target, ...rest,
    onClick: () => open(target, { mode, lang, onPaid: (s) => cb.current.onPaid?.(s), onStatus: (s) => cb.current.onStatus?.(s), onClose: () => cb.current.onClose?.() }),
  }, children ?? (invoiceId ? "Pay invoice with USDT" : "Pay with USDT"));
}
