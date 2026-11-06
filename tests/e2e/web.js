// Tests the Next.js web app (website, console, operator console) against the running testnet stack (`npm run testnet -- --prod`: API :3000 + web :3001).
// Covers what a business actually does (sign up, sign in, invite a team, reset a password) and the security-relevant behaviour:
// route gating, cookie flags, tokens never exposed to page code, CSRF origin check, proxy scoping, roles in the console.
const T = require("../support/testnet");
const W = T.WEB, API = T.API;
const DEMO = T.OWNER, PLATFORM = T.PLATFORM; // the first owner of the platform's own business, and the operator key (see .env.testnet)
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok  ", m); };
let ipN = 100;
const req = (base, p, o = {}) => fetch(base + p, { redirect: "manual", ...o, headers: { "x-forwarded-for": `198.51.100.${ipN++ % 250}`, ...(o.headers || {}) }, body: o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body) });
const web = (p, o) => req(W, p, o);
const json = { "content-type": "application/json" };
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).find((c) => c.startsWith(name + "="));
const jar = (...cs) => cs.filter(Boolean).map((c) => c.split(";")[0]).join("; ");
const mailTo = async (to, re) => { for (let i = 0; i < 20; i++) { const rows = await (await req(API, "/api/dev/mailbox?to=" + encodeURIComponent(to))).json(); const hit = rows.find((r) => re.test(r.body)); if (hit) return hit; await new Promise((r) => setTimeout(r, 250)); } return null; };
const PW = "Correct-horse-battery-9";

(async () => {
  // ── Public pages ──
  const home = await web("/");
  const homeHtml = await home.text();
  assert(home.status === 200 && homeHtml.includes("Accept USDT without giving up custody"), "landing page renders");
  const pricing = await (await web("/pricing")).text();
  assert(["Free", "Starter", "Growth", "Scale"].every((n) => pricing.includes(n)) && pricing.includes("$99"), "pricing page shows the plans served by the API");
  for (const p of ["/signup", "/login", "/forgot-password"]) assert((await web(p)).status === 200, `${p} renders`);
  const loginHtml = await (await web("/login")).text();
  assert(loginHtml.includes("Email") && loginHtml.includes("Password") && !/API key/i.test(loginHtml), "sign-in asks for email and password, not an API key");
  assert((await web("/api/config")).status === 200 && (await web("/pay.html")).status === 200 && (await web("/openapi.json")).status === 200, "the API, checkout pages and OpenAPI are served through the same origin");
  assert((await web("/api/payments")).status === 401, "the API still requires credentials when reached through the front door");

  // ── Gating ──
  const c1 = await web("/console");
  assert(c1.status === 307 && c1.headers.get("location").includes("/login"), "the console redirects to sign-in without a session");
  const a1 = await web("/admin");
  assert(a1.status === 307 && a1.headers.get("location").includes("/admin/login"), "the operator console redirects to its own sign-in");
  assert((await web("/bff/payments")).status === 401 && (await web("/bff-admin/overview")).status === 401, "both proxies refuse requests without a session");

  // ── Sign in ──
  const bad = await web("/auth/login", { method: "POST", headers: json, body: { email: DEMO.email, password: "Wrong-password-1" } });
  assert(bad.status === 401 && !cookieOf(bad, "wp_session"), "a wrong password is rejected and sets no cookie");
  const ok = await web("/auth/login", { method: "POST", headers: json, body: DEMO });
  const sc = cookieOf(ok, "wp_session");
  assert(ok.status === 200 && sc && /HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc), "sign-in sets an httpOnly, SameSite=Strict session cookie");
  const okBody = JSON.stringify(await ok.json());
  assert(!okBody.includes("wps_") && !okBody.includes("wp_test_"), "the session token is never sent to page code");
  const session = jar(sc);

  // ── Console and proxy for the owner ──
  const con = await web("/console", { headers: { cookie: session } });
  const conHtml = await con.text();
  assert(con.status === 200 && conHtml.includes("Welcome back") && !conHtml.includes(T.KEY) && !conHtml.includes("wps_"), "the console renders for the signed-in owner without leaking any credential into the page");
  for (const p of ["payments", "invoices", "subscriptions", "refunds", "customers", "finance", "ledger", "marketplace", "settings", "team", "security", "activity", "developers", "plan"]) {
    const r = await web(`/console/${p}`, { headers: { cookie: session } });
    if (r.status !== 200) assert(false, `/console/${p} should render for the owner, got ${r.status}`);
  }
  console.log("ok   all fourteen console sections render for the owner");
  assert((await (await web("/console/payments", { headers: { cookie: session } })).text()).includes("create a payment link"), "the payments page offers a plain-language payment link form");
  const pay = await web("/bff/payments", { headers: { cookie: session } });
  assert(pay.status === 200 && Array.isArray(await pay.json()), "the proxy attaches the session and returns API data");
  assert((await web("/bff/platform/overview", { headers: { cookie: session } })).status === 403, "the business proxy can't reach platform endpoints");
  const xl = await web("/bff/statements?format=xlsx&from=0&to=9999999999", { headers: { cookie: session } });
  assert(xl.status === 200 && Buffer.from(await xl.arrayBuffer()).subarray(0, 2).toString() === "PK", "binary downloads (Excel statements) stream through the proxy intact");

  // ── CSRF ──
  assert((await web("/bff/intents", { method: "POST", headers: { ...json, cookie: session, origin: "https://evil.example" }, body: { amount: 5 } })).status === 403, "a cross-site write through the proxy is refused");
  assert((await web("/auth/login", { method: "POST", headers: { ...json, origin: "https://evil.example" }, body: DEMO })).status === 403, "a cross-site sign-in attempt is refused");
  assert((await web("/bff/intents", { method: "POST", headers: { ...json, cookie: session, origin: W }, body: { amount: 5, currency: "USD", description: "web test", orderRef: "web_" + Date.now() } })).status === 201, "a same-site write through the proxy succeeds");

  // ── Operator console ──
  assert((await web("/auth/admin-login", { method: "POST", headers: json, body: { key: "nope" } })).status === 401, "a wrong platform key is rejected");
  const adm = await web("/auth/admin-login", { method: "POST", headers: json, body: { key: PLATFORM } });
  const ac = cookieOf(adm, "wp_admin");
  assert(adm.status === 200 && ac && /HttpOnly/i.test(ac), "the operator session is an httpOnly cookie");
  const admin = jar(ac);
  assert((await (await web("/admin", { headers: { cookie: admin } })).text()).includes("Tenants"), "the operator console renders");
  assert((await web("/bff-admin/overview", { headers: { cookie: admin } })).status === 200, "the operator proxy returns platform data");
  assert((await web("/bff-admin/overview", { headers: { cookie: session } })).status === 401 && (await web("/admin", { headers: { cookie: session } })).status === 307, "a business session can't use the operator console");

  // ── A new business signs up ──
  const email = `web${Date.now()}@shop.test`;
  const su = await web("/auth/signup", { method: "POST", headers: json, body: { businessName: "Web Test Co", name: "Wanda Webb", email, password: PW } });
  assert(su.status === 201 && cookieOf(su, "wp_session"), "signup creates the person and the business and signs them in");
  assert((await web("/auth/signup", { method: "POST", headers: json, body: { businessName: "Web Test Co", name: "Wanda Webb", email, password: PW } })).status === 409, "a duplicate email is refused");
  assert((await web("/auth/signup", { method: "POST", headers: json, body: { businessName: "Weak Co", name: "Wendy Weak", email: `weak${Date.now()}@shop.test`, password: "password123" } })).status === 400, "a weak password is refused");
  const mine = jar(cookieOf(su, "wp_session"));
  const pend = await (await web("/console", { headers: { cookie: mine } })).text();
  assert(pend.includes("Finish setup") && !pend.includes("confirm your email"), "a new business sees the wallet step, with no email-confirmation prompt");

  // ── Forgot and reset password ──
  assert((await web("/auth/public/forgot", { method: "POST", headers: json, body: { email } })).status === 200, "forgot-password accepts the request");
  const rm = await mailTo(email, /reset-password\?token=/);
  const rtok = rm.body.match(/token=([\w-]+)/)[1];
  assert((await (await web(`/reset-password?token=${rtok}`)).text()).includes("Choose a new password"), "the reset page renders from the email link");
  assert((await web("/auth/public/reset", { method: "POST", headers: json, body: { token: rtok, password: "A-brand-new-passphrase-1" } })).status === 200, "the new password is saved");
  assert((await web("/console", { headers: { cookie: mine } })).status === 307, "the old session is signed out by the reset");
  assert((await web("/auth/login", { method: "POST", headers: json, body: { email, password: "A-brand-new-passphrase-1" } })).status === 200, "the new password signs in");
  assert((await web("/auth/public/nonsense", { method: "POST", headers: json, body: {} })).status === 404, "only the intended public account actions exist");

  // ── Roles in the console: the owner invites a viewer and a finance person ──
  const invite = async (role) => {
    const em = `${role}${Date.now()}@shop.test`;
    const ir = await web("/bff/team/invite", { method: "POST", headers: { ...json, cookie: session, origin: W }, body: { email: em, role } });
    assert(ir.status === 201, `the owner invites a ${role} from the console`);
    const itok = (await ir.json()).link.split("/invite/")[1]; // the link comes back in the response
    assert((await (await web(`/invite/${itok}`)).text()).includes("Join "), `the invitation page for the ${role} renders`);
    const acc = await web("/auth/accept-invite", { method: "POST", headers: json, body: { token: itok, name: `Sam ${role}`, password: "Invited-person-2026" } });
    assert(acc.status === 201 && cookieOf(acc, "wp_session"), `the ${role} joins and is signed in`);
    return jar(cookieOf(acc, "wp_session"));
  };
  const viewer = await invite("viewer"), finance = await invite("finance");
  const vp2 = await (await web("/console/payments", { headers: { cookie: viewer } })).text();
  assert(!vp2.includes("create a payment link"), "a viewer's payments page has no create form");
  assert((await web("/bff/intents", { method: "POST", headers: { ...json, cookie: viewer, origin: W }, body: { amount: 5, currency: "USD" } })).status === 403, "…and the server refuses a viewer's write too");
  const denied = await web("/console/team", { headers: { cookie: viewer } });
  assert(denied.status === 307 && denied.headers.get("location").includes("denied=team"), "a viewer who opens the Team page is sent home with an explanation");
  const home2 = await (await web("/console?denied=team", { headers: { cookie: viewer } })).text();
  assert(home2.includes("can&#x27;t open") || home2.includes("can't open"), "…and told why");
  const finNav = await (await web("/console", { headers: { cookie: finance } })).text();
  assert(finNav.includes("Reports &amp; accounting") && !finNav.includes("API keys &amp; webhooks") && !finNav.includes(">Team<"), "a finance person's menu shows accounting but not developer tools or the team");
  assert((await web("/console/developers", { headers: { cookie: finance } })).status === 307, "…and can't open the developer page");
  assert((await web("/console/finance", { headers: { cookie: finance } })).status === 200, "…but can open reports");
  const team = await (await web("/console/team", { headers: { cookie: session } })).text();
  assert(team.includes("Invite someone") && team.includes("What each role can do"), "the owner's team page shows people, invitations and a role guide");

  // ── Security page, two-step setup, activity log ──
  assert((await (await web("/console/security", { headers: { cookie: session } })).text()).includes("Two-step sign-in"), "the security page offers two-step sign-in");
  assert((await (await web("/console/activity", { headers: { cookie: session } })).text()).includes("Invited someone"), "the activity log shows team changes in plain language");

  // ── Regressions found in earlier reviews ──
  const toWeb = await req(API, "/console", { redirect: "manual" });
  assert(toWeb.status === 302 && toWeb.headers.get("location") === W + "/console", "the API's own address redirects site pages to the web app instead of a 404");
  const oldUrl = await req(API, "/pay.html?i=pay_x", { redirect: "manual" });
  assert(oldUrl.status === 302 && oldUrl.headers.get("location") === W + "/pay.html?i=pay_x", "an old checkout URL on the API's address is sent to the web app");
  assert((await web("/index.html")).status === 200 && (await (await web("/index.html")).text()).includes("Demo store"), "the demo store is still reachable at its old /index.html address");
  const stale = "wp_session=wps_this_session_does_not_exist";
  const sp = await web("/signup", { headers: { cookie: stale } });
  assert(sp.status === 200 && (await sp.text()).includes("Create your account"), "a stale session cookie doesn't block the signup page");
  assert((await web("/login", { headers: { cookie: stale } })).status === 200, "…or the login page");
  const sc2 = await web("/console", { headers: { cookie: stale } });
  assert(sc2.status === 307 && sc2.headers.get("location").includes("/auth/expired"), "an invalid session sends the console to the cookie-clearing route, not a loop");
  const ex = await web("/auth/expired", { headers: { cookie: stale } });
  assert(ex.status === 307 && /Max-Age=0|Expires=/i.test((ex.headers.getSetCookie?.() || []).join(";")), "/auth/expired clears the bad cookie");
  assert(!(await (await web("/", { headers: { cookie: stale } })).text()).includes("Open console"), "the header doesn't claim you're signed in with a stale cookie");
  const sw = await (await web("/sw.js")).text();
  assert(sw.includes("wp-shell-v3") && sw.includes("CUSTOMER_PAGE"), "the service worker only handles customer pages (it can't cache the console or admin)");
  assert((await web("/_next/static/does-not-exist.js")).status === 404, "Next's own asset paths are not forwarded to the API");

  // ── Customer pages (checkout, invoice, receipt, portal, subscribe, store): in Next, at their original URLs ──
  const KEY = T.KEY, api = (p, o = {}) => req(API, p, { ...o, headers: { ...json, authorization: "Bearer " + KEY, ...(o.headers || {}) }, body: o.body });
  const pmt = await (await api("/api/intents", { method: "POST", body: { amount: 9, currency: "USD", description: "Customer page test", orderRef: "cust_" + Date.now() } })).json();
  const payPage = await web(`/pay.html?i=${pmt.id}`);
  assert(payPage.status === 200 && (await payPage.text()).includes("<title>Checkout"), "the old checkout URL (/pay.html?i=…) serves the new checkout page");
  assert((await web(`/pay?i=${pmt.id}`)).status === 200, "…and so does the clean URL");
  const invc = await (await api("/api/invoices", { method: "POST", body: { clientName: "Customer Page Co", currency: "USD", items: [{ description: "Widgets", unitPrice: 40 }] } })).json();
  const invHtml = await (await web(invc.url)).text();
  assert(invHtml.includes(invc.number) && invHtml.includes("Customer Page Co") && invHtml.includes("Pay this invoice"), "the invoice page renders the invoice and a pay button on the server, so it prints and shares well");
  assert((await web("/invoice.html?id=inv_nope")).status === 200 && (await (await web("/invoice.html?id=inv_nope")).text()).includes("Unknown invoice"), "an unknown invoice link shows a clear message");
  for (const p of ["/receipt?i=" + pmt.id, "/portal", "/subscribe", "/store", "/widget-demo", "/receipt.html?i=" + pmt.id, "/portal.html", "/subscribe.html"]) assert((await web(p)).status === 200, `${p} renders`);
  assert((await (await web("/store?lang=hi")).text()).includes("USDT में"), "?lang=hi shows the page in Hindi, rendered on the server (no flash of English)");
  const ar = await (await web("/store?lang=ar")).text();
  assert(ar.includes('dir="rtl"') && ar.includes('lang="ar"'), "Arabic switches the page to right-to-left");
  assert((await (await web("/store", { headers: { cookie: "wp_lang=ta" } })).text()).includes("USDT"), "a saved language choice (cookie) is honoured");
  assert((await (await web("/store", { headers: { "accept-language": "hi-IN,hi;q=0.9" } })).text()).includes("USDT में"), "the browser's language is used when nothing was chosen");
  assert(!(await (await web("/store?lang=xx")).text()).includes("lang=\"xx\""), "an unknown language falls back to English");
  const embed = await (await web(`/pay.html?i=${pmt.id}&embed=1`)).text();
  assert(!embed.includes('aria-label="Main"'), "embedded checkout (widget iframe/popup) has no site header");
  assert((await web("/widget.js")).status === 200 && (await (await web("/widget.js")).text()).includes("whitepay"), "widget.js is served for merchants' sites");
  assert(JSON.stringify(await (await web("/manifest.webmanifest")).json()).includes('"/portal"'), "the installable-app manifest points at the new payer portal");
  assert((await web("/style.css")).status === 404, "the old stylesheet and scripts are gone");

  // ── A new business goes live by registering its owner wallet on-chain (Whitechain testnet) ──
  const live = await web("/auth/signup", { method: "POST", headers: json, body: { businessName: "Testnet Live Co", name: "Dana Live", email: `live${Date.now()}@shop.test`, password: PW } });
  const lj = jar(cookieOf(live, "wp_session"));
  const meLive = await (await web("/bff/account/me", { headers: { cookie: lj } })).json();
  assert(meLive.merchant.status === "pending" && meLive.merchant.nextStep?.contract === T.dep.pay, "a new business is pending and is told which contract to register with");
  const [ownerW] = await T.fresh(1);
  await (await new T.ethers.Contract(T.dep.pay, T.abi("WhitePay"), ownerW).registerMerchant(await ownerW.getAddress(), meLive.merchant.signerAddress)).wait();
  const active = await T.until(async () => (await (await web("/bff/account/me", { headers: { cookie: lj } })).json()).merchant?.status === "active", 90);
  assert(active, "the indexer picks up the on-chain registration and the business becomes active");
  assert((await (await web("/console/payments", { headers: { cookie: lj } })).text()).includes("create a payment link"), "the live business gets the full console");
  assert((await web("/bff/demo/activate", { method: "POST", headers: { ...json, cookie: lj }, body: {} })).status === 404, "there is no wallet-free shortcut to go live");

  // ── Sign out ends the session on the server ──
  const out = await web("/auth/logout", { method: "POST", headers: { cookie: session } });
  assert(out.status === 200 && /Max-Age=0|Expires=/i.test((out.headers.getSetCookie?.() || []).join(";")), "sign-out clears the cookies");
  assert((await web("/console", { headers: { cookie: session } })).status === 307, "…and the old session no longer works even if someone kept the cookie");
  console.log("\nWeb checks passed.");
})().catch((e) => { console.error(e); process.exit(1); });
