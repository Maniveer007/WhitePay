/*! WhitePay checkout widget. Drop-in, no dependencies.
 *
 * No-code button:
 *   <script src="https://YOUR-WHITEPAY-HOST/widget.js" async></script>
 *   <button data-whitepay-payment="pay_…">Pay with USDT</button>            (a payment your server created)
 *   <a data-whitepay-invoice="inv_…">Pay invoice</a>
 *
 * JavaScript:
 *   WhitePay.checkout("pay_…", { mode: "popup" | "modal", lang: "hi", onStatus(s) {}, onPaid(s) {}, onClose() {} })
 *
 * Callbacks are for UX only (close the dialog, show "thanks"). Ship goods only after your server sees the
 * `payment.fulfillable` webhook or reads the payment from the API — a browser event can be faked.
 */
(function () {
  if (window.WhitePay && window.WhitePay.checkout) return;
  const script = document.currentScript || [...document.scripts].find((s) => /\/widget\.js(\?|$)/.test(s.src));
  const ORIGIN = new URL(script ? script.src : location.href).origin;
  const PAID = ["seen", "safe", "finalized"];
  let active = null; // one checkout at a time

  const css = `.wp-btn{font:600 15px/1 system-ui,sans-serif;background:#111827;color:#fff;border:0;border-radius:10px;padding:12px 18px;cursor:pointer}
    .wp-btn:hover{opacity:.9}.wp-ov{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:2147483647}
    .wp-fr{width:min(440px,94vw);height:min(680px,92vh);border:0;border-radius:16px;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.35)}
    .wp-x{position:absolute;top:12px;inset-inline-end:16px;font:28px/1 system-ui;color:#fff;background:none;border:0;cursor:pointer}`;
  const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);

  function url(target, lang) {
    const u = target.startsWith("inv_") ? new URL("/invoice.html", ORIGIN) : new URL("/pay.html", ORIGIN);
    u.searchParams.set(target.startsWith("inv_") ? "id" : "i", target);
    u.searchParams.set("embed", "1");
    if (lang) u.searchParams.set("lang", lang);
    return u.toString();
  }

  function close() {
    if (!active) return;
    const a = active; active = null;
    window.removeEventListener("message", a.onMsg);
    clearInterval(a.watch);
    if (a.overlay) a.overlay.remove();
    if (a.popup && !a.popup.closed) a.popup.close();
    a.opts.onClose && a.opts.onClose();
  }

  function checkout(target, opts = {}) {
    if (!target) throw new Error("WhitePay.checkout needs a payment id (pay_…) or invoice id (inv_…)");
    if (active) close();
    const mode = opts.mode || "popup", src = url(String(target), opts.lang);
    active = { opts, paid: false };
    active.onMsg = (e) => {
      // Only trust messages from the WhitePay origin this script came from AND from the exact checkout window we opened.
      const win = active.popup || active.overlay?.querySelector("iframe")?.contentWindow;
      if (e.origin !== ORIGIN || e.source !== win || !e.data || e.data.source !== "whitepay") return;
      const s = e.data.payment;
      opts.onStatus && opts.onStatus(s);
      if (PAID.includes(s.status) && !active.paid) {
        active.paid = true;
        opts.onPaid && opts.onPaid(s);
        if (mode === "modal" && opts.autoClose !== false) setTimeout(close, 2500);
      }
    };
    window.addEventListener("message", active.onMsg);
    if (mode === "modal") {
      const ov = document.createElement("div");
      ov.className = "wp-ov"; ov.setAttribute("role", "dialog"); ov.setAttribute("aria-label", "WhitePay checkout");
      ov.innerHTML = `<button class="wp-x" aria-label="Close">×</button><iframe class="wp-fr" title="WhitePay checkout" allow="clipboard-write" src="${src}"></iframe>`;
      ov.querySelector(".wp-x").onclick = close;
      ov.onclick = (e) => { if (e.target === ov) close(); };
      document.addEventListener("keydown", function esc(e) { if (e.key === "Escape") { document.removeEventListener("keydown", esc); close(); } });
      document.body.appendChild(ov);
      active.overlay = ov;
    } else {
      const w = 440, h = 700, left = screenX + (outerWidth - w) / 2, top = screenY + (outerHeight - h) / 2;
      active.popup = window.open(src, "whitepay_checkout", `width=${w},height=${h},left=${left},top=${top}`);
      if (!active.popup) { location.href = src.replace("&embed=1", ""); return; } // popup blocked → full-page checkout
      active.watch = setInterval(() => { if (active && active.popup.closed) close(); }, 500);
    }
  }

  function upgrade(root = document) {
    root.querySelectorAll("[data-whitepay-payment],[data-whitepay-invoice]").forEach((el) => {
      if (el.dataset.whitepayReady) return;
      el.dataset.whitepayReady = "1";
      if (!el.textContent.trim()) el.textContent = el.dataset.whitepayInvoice ? "Pay invoice with USDT" : "Pay with USDT";
      if (el.tagName === "BUTTON" && !el.className) el.className = "wp-btn";
      el.addEventListener("click", (e) => {
        e.preventDefault();
        checkout(el.dataset.whitepayPayment || el.dataset.whitepayInvoice, { mode: el.dataset.whitepayMode, lang: el.dataset.whitepayLang,
          onPaid: (s) => el.dispatchEvent(new CustomEvent("whitepay:paid", { detail: s, bubbles: true })) });
      });
    });
  }

  window.WhitePay = { checkout, close, upgrade, origin: ORIGIN };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => upgrade());
  else upgrade();
})();
