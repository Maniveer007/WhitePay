// WhitePay service worker: makes the customer pages installable and keeps a friendly offline page.
// It only ever touches the customer pages. The website, signed-in consoles, /auth, /bff, /api and Next's own assets always go to the
// network: caching them could show a signed-out visitor a signed-in page, or serve stale code. Money and status are never cached.
const VERSION = "wp-shell-v3"; // bumped: v2 listed the old static pages
const CUSTOMER_PAGE = /^\/(pay|invoice|receipt|portal|subscribe|store|widget-demo)(\.html)?$/;
const SHELL = ["/offline.html", "/icon.svg"];

self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (!(CUSTOMER_PAGE.test(url.pathname) || SHELL.includes(url.pathname))) return;
  if (req.mode === "navigate") { // pages: always live; if the network is gone, show the offline page
    e.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
