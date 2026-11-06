// Loads the WhitePay checkout widget once and opens checkouts. No React imports here, so it is testable on its own.
const loading = new Map();

/** Load `${host}/widget.js` once per host. Resolves with window.WhitePay. */
export function loadWidget(host, doc = typeof document !== "undefined" ? document : undefined, win = typeof window !== "undefined" ? window : undefined) {
  if (!doc || !win) return Promise.reject(new Error("WhitePay widget needs a browser"));
  const base = String(host || "").replace(/\/+$/, "");
  if (!base) return Promise.reject(new Error("host is required, e.g. https://pay.example.com"));
  if (win.WhitePay?.checkout && win.WhitePay.origin === base) return Promise.resolve(win.WhitePay);
  if (loading.has(base)) return loading.get(base);
  const p = new Promise((resolve, reject) => {
    const s = doc.createElement("script");
    s.src = base + "/widget.js"; s.async = true;
    s.onload = () => (win.WhitePay?.checkout ? resolve(win.WhitePay) : reject(new Error("widget.js loaded but WhitePay is missing")));
    s.onerror = () => { loading.delete(base); reject(new Error("could not load " + s.src)); };
    doc.head.appendChild(s);
  });
  loading.set(base, p);
  return p;
}

/** Open the checkout for a payment id (pay_…) or invoice id (inv_…). */
export async function openCheckout(host, target, opts = {}) {
  const w = await loadWidget(host);
  w.checkout(target, opts);
  return w;
}
