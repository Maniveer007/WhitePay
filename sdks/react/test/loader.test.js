import test from "node:test";
import assert from "node:assert/strict";
import { loadWidget, openCheckout } from "../src/loader.js";

// A tiny fake browser: appending the script "loads" it by defining window.WhitePay.
function fakeBrowser({ fail = false } = {}) {
  const calls = { appended: [], checkout: [] };
  const win = {};
  const doc = {
    createElement: () => ({}),
    head: { appendChild(s) {
      calls.appended.push(s.src);
      queueMicrotask(() => { if (fail) return s.onerror(); win.WhitePay = { origin: s.src.replace("/widget.js", ""), checkout: (...a) => calls.checkout.push(a) }; s.onload(); });
    } },
  };
  return { doc, win, calls };
}

test("loads widget.js once per host and reuses it", async () => {
  const { doc, win, calls } = fakeBrowser();
  const [a, b] = await Promise.all([loadWidget("https://pay.test/", doc, win), loadWidget("https://pay.test", doc, win)]);
  assert.equal(a, b);
  assert.deepEqual(calls.appended, ["https://pay.test/widget.js"]);
  await loadWidget("https://pay.test", doc, win);
  assert.equal(calls.appended.length, 1);
});

test("rejects without a host, and recovers after a failed load", async () => {
  await assert.rejects(loadWidget("", {}, {}), /host is required/);
  const bad = fakeBrowser({ fail: true });
  await assert.rejects(loadWidget("https://down.test", bad.doc, bad.win), /could not load/);
  const good = fakeBrowser();
  await loadWidget("https://down.test", good.doc, good.win); // a retry is not stuck on the cached failure
  assert.equal(good.calls.appended.length, 1);
});

test("openCheckout forwards the target and options to the widget", async () => {
  const { doc, win, calls } = fakeBrowser();
  globalThis.document = doc; globalThis.window = win;
  await openCheckout("https://pay3.test", "pay_abc", { mode: "modal", lang: "hi" });
  delete globalThis.document; delete globalThis.window;
  assert.deepEqual(calls.checkout, [["pay_abc", { mode: "modal", lang: "hi" }]]);
});
