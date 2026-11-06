// End-to-end test of the SaaS layer on the Whitechain testnet (needs `npm run testnet` running):
// signup, plan limits, feature gates, per-tenant rate limit, suspension, operator console, upgrade-by-payment.
const T = require("../support/testnet");
const { ethers, until } = T;
const B = T.API, PLATFORM = T.PLATFORM;
const call = async (p, o = {}, key) => {
  const r = await fetch(B + p, { ...o, headers: { "content-type": "application/json", ...(key ? { authorization: "Bearer " + key } : {}) }, body: o.body && JSON.stringify(o.body) });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
};
const sleep = T.sleep;
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok  ", m); };
(async () => {
  const plans = (await call("/api/saas/plans")).body;
  assert(plans.signupOpen && plans.plans.length === 4 && plans.plans[0].id === "free", "public plan list is served and signup is open");

  // ── Signup: a person and their business (no API key at this point) ──
  const pw = "Correct-horse-battery-9", ip = { "x-forwarded-for": "198.51.100.77" };
  const acct = async (path, o = {}) => { const r = await fetch(B + path, { method: o.method || "GET", headers: { "content-type": "application/json", ...ip, ...(o.token ? { authorization: "Bearer " + o.token } : {}) }, body: o.body && JSON.stringify(o.body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const email = `owner${Date.now()}@shop.test`;
  const su = await acct("/api/account/signup", { method: "POST", body: { businessName: "Tulsi Traders", name: "Tulsi Rao", email, password: pw } });
  assert(su.status === 201 && su.body.token?.startsWith("wps_") && !JSON.stringify(su.body).includes("wp_test_"), "signup creates the owner and the business without exposing an API key");
  assert((await acct("/api/account/signup", { method: "POST", body: { businessName: "Tulsi Again", name: "Other Person", email: email.toUpperCase(), password: pw } })).body.error?.code === "email_taken", "the same email can't sign up twice (case-insensitive)");
  const session = su.body.token, me0 = (await acct("/api/account/me", { token: session })).body;
  assert(me0.merchant.signerAddress && me0.merchant.status === "pending", "the business starts pending, with a signing address for the on-chain step");
  assert((await acct("/api/saas/usage", { token: session })).status === 403, "a business can't use the platform before registering on-chain");

  // ── Go live on-chain, then it activates by itself ──
  const cfg = (await call("/api/config")).body;
  const rpc = T.provider;
  assert(cfg.chainId === 1874, "running against the Whitechain testnet (chain 1874)");
  const [owner, buyer] = await T.fresh(2); // the new business's owner wallet, and a payer for the plan upgrade
  const payC = (w) => new ethers.Contract(cfg.pay, require("../../artifacts/contracts/WhitePay.sol/WhitePay.json").abi, w);
  const tok = (w) => new ethers.Contract(cfg.token, ["function mint(address,uint256)", "function approve(address,uint256)"], w);
  await (await payC(owner).registerMerchant(await owner.getAddress(), me0.merchant.signerAddress)).wait();
  assert(await until(async () => (await acct("/api/account/me", { token: session })).body.merchant.status === "active"), "on-chain registration activates the business");

  // A developer creates their own API key in the console. That needs a confirmed email address.
  assert((await acct("/api/merchants/me/rotate-key", { method: "POST", token: session, body: {} })).body.error?.code === "email_unverified", "creating an API key needs a confirmed email");
  const mails = (await acct("/api/dev/mailbox?to=" + encodeURIComponent(email))).body;
  const vtok = mails.find((m) => /verify-email\?token=/.test(m.body)).body.match(/token=([\w-]+)/)[1];
  assert((await acct("/api/account/verify-email", { method: "POST", body: { token: vtok } })).status === 200, "the email is confirmed from the link we sent");
  const KEY = (await acct("/api/merchants/me/rotate-key", { method: "POST", token: session, body: {} })).body.apiKey, T = (p, o) => call(p, o, KEY);
  assert(KEY?.startsWith("wp_test_"), "the owner creates an API key for their developer");

  // ── Free plan: usage, limits, gates ──
  let u = (await T("/api/saas/usage")).body;
  assert(u.plan.id === "free" && u.plan.limits.invoicesPerMonth === 10 && u.usage.invoices === 0 && u.remaining.invoices === 10, "free plan usage starts at zero");
  const inv = () => T("/api/invoices", { method: "POST", body: { clientName: "Acme", currency: "USD", items: [{ description: "Work", qty: 1, unitPrice: 10 }] } });
  for (let i = 0; i < 10; i++) { const r = await inv(); if (r.status !== 201) assert(false, `invoice ${i + 1} should be allowed, got ${r.status}`); }
  const over = await inv();
  assert(over.status === 402 && over.body.error.code === "plan_limit_exceeded" && over.body.error.upgrade, "the 11th invoice on the free plan is refused with an upgrade hint");
  assert((await T("/api/saas/usage")).body.usage.invoices === 10, "usage reports 10 invoices");
  const p1 = await T("/api/intents", { method: "POST", body: { amount: 5, currency: "USD", orderRef: "t1" } });
  assert(p1.status === 201 && (await T("/api/saas/usage")).body.usage.payments === 1, "payments still work and are counted");
  assert((await T("/api/recurring-invoices", { method: "POST", body: { frequency: "monthly", template: { clientName: "R", items: [{ description: "x", unitPrice: 5 }] } } })).status === 402, "recurring schedules need a paid plan");
  const fin = await T("/api/statements");
  assert(fin.status === 402 && fin.body.error.code === "plan_feature", "statements are a paid feature");
  assert(over.headers.get("whitepay-plan") === "free", "every response carries the WhitePay-Plan header");

  // ── Per-tenant rate limit (free = 60/min) ──
  const burst = await Promise.all(Array.from({ length: 90 }, () => T("/api/saas/usage")));
  const limited = burst.filter((r) => r.status === 429).length;
  assert(limited > 0 && burst.some((r) => r.status === 200), `a burst beyond the plan's rate limit gets 429s (${limited} of 90)`);
  assert((await call("/api/v1/platform/overview", {}, PLATFORM)).status === 200, "the operator is not rate limited by a tenant's bucket");

  // ── Operator console ──
  await sleep(3); // the burst emptied this tenant's bucket
  assert((await call("/api/platform/tenants", {}, KEY)).status === 401, "tenants can't use the operator console");
  const ov = (await call("/api/platform/overview", {}, PLATFORM)).body;
  assert(ov.tenants >= 1 && ov.byPlan.free >= 1 && ov.mrrUsd === 0, "overview counts tenants by plan (MRR 0 on free)");
  const list = (await call("/api/platform/tenants", {}, PLATFORM)).body;
  const me = list.find((t) => t.email === email.toLowerCase());
  assert(me && me.usage.invoices === 10 && me.plan === "free", "tenant list shows each tenant's plan and usage");

  // Suspension is read-only, not deletion, and the chain keeps being indexed.
  await sleep(2); // let the rate-limit bucket refill
  const sus = await call(`/api/platform/tenants/${me.uid}/suspend`, { method: "POST", body: { reason: "chargeback review" } }, PLATFORM);
  assert(sus.body.suspended === true, "operator can suspend a tenant");
  const blocked = await T("/api/intents", { method: "POST", body: { amount: 5, currency: "USD", orderRef: "t2" } });
  assert(blocked.status === 403 && blocked.body.error.code === "account_suspended", "a suspended tenant can't create payments");
  assert((await T("/api/payments")).status === 200 && (await T("/api/saas/usage")).body.suspended === true, "a suspended tenant can still read its data");
  const pub = await call("/api/intents/" + p1.body.id);
  assert(pub.status === 200, "customers can still open a suspended tenant's existing checkout");
  await call(`/api/platform/tenants/${me.uid}/resume`, { method: "POST" }, PLATFORM);
  assert((await T("/api/intents", { method: "POST", body: { amount: 5, currency: "USD", orderRef: "t2" } })).status === 201, "resuming restores write access");

  // ── Comp a plan: limits and gates lift ──
  const granted = await call(`/api/platform/tenants/${me.uid}/plan`, { method: "POST", body: { plan: "starter", days: 30 } }, PLATFORM);
  assert(granted.body.plan === "starter", "operator can grant a plan");
  const rc = await T("/api/recurring-invoices", { method: "POST", body: { frequency: "monthly", template: { clientName: "R", items: [{ description: "x", unitPrice: 5 }] } } });
  if (rc.status !== 201) console.log(rc.status, JSON.stringify(rc.body));
  assert(rc.status === 201, "recurring invoices work on a paid plan");
  assert((await T("/api/statements")).status === 200, "statements work on a paid plan");
  assert((await call("/api/platform/overview", {}, PLATFORM)).body.mrrUsd === 29, "MRR reflects the paid plan");
  await call(`/api/platform/tenants/${me.uid}/plan`, { method: "POST", body: { plan: "free" } }, PLATFORM);
  assert((await T("/api/saas/usage")).body.plan.id === "free", "plan can be set back to free");

  // ── Upgrade by paying in USDT through WhitePay itself ──
  assert((await T("/api/saas/upgrade", { method: "POST", body: { plan: "free" } })).body.error?.code === "invalid_plan", "upgrade only accepts paid plans");
  const up = await T("/api/saas/upgrade", { method: "POST", body: { plan: "growth", months: 2 } });
  assert(up.status === 201 && up.body.priceUsd === 198 && up.body.checkoutUrl, "upgrade returns a checkout for 2 months of Growth ($198)");
  const fi = (await call("/api/intents/" + up.body.paymentId)).body, q = fi.quote;
  assert(q.merchantId === 1, "the upgrade is paid to the platform's own merchant, not to the tenant");
  assert((await T("/api/saas/usage")).body.plan.id === "free", "the plan does not change until the payment is made");
  await T.ensureUsdt(buyer, 1_000_000_000n);
  await (await tok(buyer).approve(cfg.pay, q.amount)).wait();
  await (await payC(buyer).pay([q.merchantId, q.intentId, q.token, q.amount, q.expiry], fi.signature)).wait();
  const upgraded = await until(async () => { const x = (await T("/api/saas/usage")).body; return x.plan.id === "growth" ? x : null; });
  assert(upgraded && upgraded.planUntil > Date.now() / 1000 + 55 * 86400, "paying activates Growth for 2 months automatically");
  const fu = (await T("/api/saas/usage")).body; if (fu.remaining.invoices !== 989) console.log(JSON.stringify(fu));
  assert(fu.remaining.invoices === 989, "Growth limits apply (1000 invoices; 10 manual + 1 from the recurring schedule used)");
  console.log("\nAll SaaS checks passed.");
})().catch((e) => { console.error(e); process.exit(1); });
