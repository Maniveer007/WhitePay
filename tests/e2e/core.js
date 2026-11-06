// End-to-end test on the Whitechain testnet (needs `npm run testnet` running): payments, refunds, operator limits, subscriptions with
// dunning, invoices, gasless checkout, exceptions, and multi-merchant isolation. Uses the fast "seen" confirmation level: "safe" and
// "finalized" take ~8 and ~37 minutes on testnet.
const T = require("../support/testnet");
const { ethers, sleep } = T;
const abi = T.abi("WhitePay");
const B = T.API, KEY = T.KEY;
const j = async (p, o = {}) => (await fetch(B + p, { ...o, headers: { "content-type": "application/json", authorization: "Bearer " + KEY }, body: o.body && JSON.stringify(o.body) })).json();
const subsOf = async (addr) => (await fetch(`${B}/api/v1/customers/${addr}/subscriptions`)).json();
const subUntil = async (addr, pred, secs = 90) => (await T.until(async () => { const m = await subsOf(addr); return m.length && pred(m[0]) ? m : null; }, secs)) || subsOf(addr);
const invUntil = async (id, pred, secs = 60) => (await T.until(async () => { const x = await j("/api/invoices/" + id); return pred(x) ? x : null; }, secs)) || j("/api/invoices/" + id);
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok  ", m); };

(async () => {
  const cfg = await j("/api/config");
  assert(cfg.chainId === 1874 && T.dep.mockToken, "running against the Whitechain testnet (chain 1874) with the mintable test USDT");
  const rpc = T.provider;
  const owner = T.deployer; // owns merchant #1
  const [buyer, op, subber, second, ownerB] = await T.fresh(5); // new wallets every run: the chain remembers allowances, budgets and subscriptions
  const tok = (w) => new ethers.Contract(cfg.token, ["function mint(address,uint256)", "function approve(address,uint256)", "function transfer(address,uint256)", "function balanceOf(address) view returns (uint256)"], w);
  const pay = (w) => new ethers.Contract(cfg.pay, abi, w);

  const buyerAddr = await buyer.getAddress();
  await (await tok(owner).mint(buyerAddr, 1_000_000_000n)).wait();
  const it = await j("/api/intents", { method: "POST", body: { amount: 49, currency: "USD", description: "Hoodie", policy: "seen", orderRef: "e2e_" + Date.now() } });
  assert(it.amount === "49000000", "quote locks 49 USDT");
  const full = await j("/api/intents/" + it.id);
  await (await tok(buyer).approve(cfg.pay, full.amount)).wait();
  const q = full.quote;
  // tampered amount must fail
  try { await pay(buyer).pay.staticCall([q.merchantId, q.intentId, q.token, "1", q.expiry], full.signature); assert(false, "tamper rejected"); } catch { assert(true, "tampered quote rejected"); }
  await (await pay(buyer).pay([q.merchantId, q.intentId, q.token, q.amount, q.expiry], full.signature)).wait();
  let s = await T.until(async () => { const x = await j("/api/intents/" + it.id); return ["seen", "safe", "finalized"].includes(x.status) ? x : null; }, 90) || await j("/api/intents/" + it.id);
  assert(["seen", "safe", "finalized"].includes(s.status), "payment indexed as " + s.status);
  s = await T.until(async () => { const x = await j("/api/intents/" + it.id); return x.fulfillable ? x : null; }) || s;
  assert(s.fulfillable, "fulfillable as soon as it is seen (policy: seen)");

  await (await tok(owner).approve(cfg.pay, 20_000_000n)).wait();
  const RC = (s) => ethers.encodeBytes32String(s);
  await (await pay(owner).refund(q.intentId, 20_000_000n, ethers.ZeroAddress, "0x", RC("requested_by_customer"))).wait();
  let overRejected = false;
  try { await pay(owner).refund.staticCall(q.intentId, 30_000_000n, ethers.ZeroAddress, "0x", RC("other")); } catch (e) { overRejected = e.revert?.name === "RefundExceedsPayment"; }
  assert(overRejected, "over-refund rejected on-chain (RefundExceedsPayment)");
  s = await T.until(async () => { const x = await j("/api/intents/" + it.id); return x.status === "partially_refunded" ? x : null; }, 90) || await j("/api/intents/" + it.id);
  assert(s.status === "partially_refunded" && s.refunded === "20000000", "partial refund indexed");
  assert(s.refunds.length === 1 && s.refunds[0].reason === "requested_by_customer" && s.refunds[0].operator === await owner.getAddress(), "refund history has reason code and operator");

  // ── Customer refund request: only the paying wallet can ask ──
  const msgFor = (amt, reason) => `WhitePay refund request\nPayment: ${it.id}\nAmount: ${amt}\nReason: ${reason}`;
  const postReq = (body) => fetch(`${B}/api/intents/${it.id}/refund-requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const forged = await postReq({ amount: "5000000", reason: "duplicate", signature: await owner.signMessage(msgFor("5000000", "duplicate")) });
  assert(forged.status === 403, "refund request signed by someone else is refused");
  const tooMuch = await postReq({ amount: "30000000", reason: "duplicate", signature: await buyer.signMessage(msgFor("30000000", "duplicate")) });
  assert(tooMuch.status === 400, "refund request above what's left is refused");
  const okReq = await postReq({ amount: "5000000", reason: "product_not_received", note: "never arrived", signature: await buyer.signMessage(msgFor("5000000", "product_not_received")) });
  assert(okReq.status === 201, "payer's signed refund request accepted");
  const dupReq = await postReq({ amount: "5000000", reason: "product_not_received", signature: await buyer.signMessage(msgFor("5000000", "product_not_received")) });
  assert(dupReq.status === 409, "only one open request per payment");

  // Merchant approves via a bulk refund (two payments in one tx, one reason code)
  const it2 = await j("/api/intents", { method: "POST", body: { amount: 11, description: "Bulk refund target" } });
  const f2 = await j("/api/intents/" + it2.id);
  await (await tok(buyer).approve(cfg.pay, f2.amount)).wait();
  await (await pay(buyer).pay([f2.quote.merchantId, f2.quote.intentId, f2.quote.token, f2.quote.amount, f2.quote.expiry], f2.signature)).wait();
  await (await tok(owner).approve(cfg.pay, 16_000_000n)).wait();
  await (await pay(owner).refundBatch([q.intentId, f2.quote.intentId], [5_000_000n, 11_000_000n], RC("product_not_received"))).wait();
  await T.until(async () => (await j("/api/intents/" + it.id)).refunded === "25000000" && (await j("/api/intents/" + it2.id)).status === "refunded", 90);
  const after1 = await j("/api/intents/" + it.id), after2 = await j("/api/intents/" + it2.id);
  assert(after1.refunded === "25000000" && after2.status === "refunded", "bulk refund settled both payments in one tx");
  assert(after1.refundRequests[0].status === "refunded", "customer request auto-resolved by the on-chain refund");

  // Operator limits are enforced by the contract
  await (await pay(owner).setRefunder(1, await op.getAddress(), 5_000_000n, 8_000_000n)).wait();
  await (await tok(owner).mint(await op.getAddress(), 50_000_000n)).wait();
  await (await tok(op).approve(cfg.pay, 50_000_000n)).wait();
  let limitHit = false;
  try { await pay(op).refund.staticCall(q.intentId, 6_000_000n, ethers.ZeroAddress, "0x", RC("other")); } catch (e) { limitHit = e.revert?.name === "RefundLimitExceeded"; }
  assert(limitHit, "operator refund above per-refund max is rejected on-chain");
  await (await pay(op).refund(q.intentId, 5_000_000n, ethers.ZeroAddress, "0x", RC("duplicate"))).wait();
  const opAddr = await op.getAddress();
  const ops = await T.until(async () => { const l = await j("/api/refund-operators"); return l.some((o) => o.address === opAddr && o.per_refund === "5000000") ? l : null; }, 60) || [];
  assert(ops.some((o) => o.address === opAddr && o.per_refund === "5000000"), "operator and limits indexed from chain");

  // subscription via keeper (cancel leftovers from earlier runs so they don't share this allowance)
  for (const old of await j("/api/subscriptions"))
    if (!old.cancelled && old.payer.toLowerCase() === buyerAddr.toLowerCase()) await (await pay(buyer).cancel(old.id)).wait();
  await (await tok(buyer).approve(cfg.pay, 30_000_000n)).wait();
  const end = Math.floor(Date.now() / 1000) + 86400;
  await (await pay(buyer).subscribe(1, cfg.token, 10_000_000n, 20, end, 30_000_000n)).wait();
  const subs = await T.until(async () => { const l = await j("/api/subscriptions"); return l.length && BigInt(l[0].charged) >= 10_000_000n ? l : null; }, 120) || await j("/api/subscriptions"); // the keeper charges it, then it is indexed
  assert(subs.length && BigInt(subs[0].charged) >= 10_000_000n, "keeper charged subscription (charged " + subs[0].charged + ")");

  // ── Idempotency: a retried create returns the same payment ──
  const ik = "idem_" + Date.now();
  const h = { "content-type": "application/json", authorization: "Bearer " + KEY, "idempotency-key": ik };
  const a1 = await (await fetch(B + "/api/intents", { method: "POST", headers: h, body: JSON.stringify({ amount: 5 }) })).json();
  const a2r = await fetch(B + "/api/intents", { method: "POST", headers: h, body: JSON.stringify({ amount: 5 }) });
  const a2 = await a2r.json();
  assert(a1.id === a2.id && a2r.headers.get("idempotent-replayed") === "true", "Idempotency-Key replays the original payment");

  // ── Expired quote can't be paid, but can be re-quoted ──
  const ex = await j("/api/intents", { method: "POST", body: { amount: 3, ttl: 1 } });
  await sleep(4);
  let exs = await j("/api/intents/" + ex.id);
  try { await pay(buyer).pay.staticCall([exs.quote.merchantId, exs.quote.intentId, exs.quote.token, exs.quote.amount, exs.quote.expiry], exs.signature); assert(false, "expired rejected"); }
  catch { assert(exs.status === "expired", "expired quote rejected on-chain"); }
  await j(`/api/intents/${ex.id}/requote`, { method: "POST" });
  exs = await j("/api/intents/" + ex.id);
  assert(exs.status === "created" && exs.expiry > Math.floor(Date.now() / 1000), "re-quote issues a fresh, payable quote");

  // (Reorg handling is covered by the in-memory contract tests and the indexer's unit logic: a public testnet can't be rolled back on demand.)

  // ── Exception: USDT sent straight to the payout wallet, bypassing the contract ──
  await (await tok(buyer).transfer(cfg.payout, 1_234_567n)).wait();
  const flagged = await T.until(async () => (await j("/api/exceptions")).some((e) => e.kind === "unattributed_transfer" && e.amount === "1234567"), 60);
  assert(flagged, "direct transfer flagged as unattributed exception");

  // ── Gasless checkout: a wallet with ZERO gas token pays with one signature ──
  const fresh = ethers.Wallet.createRandom();
  await (await tok(owner).mint(fresh.address, 50_000_000n)).wait();
  const QT = { Quote: [{ name: "merchantId", type: "uint256" }, { name: "intentId", type: "bytes32" }, { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "expiry", type: "uint64" }] };
  const RWA = { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };
  const authFor = async (qq) => {
    const nonce = ethers.TypedDataEncoder.hash(cfg.domain, QT, qq);
    return fresh.signTypedData(cfg.tokenDomain, RWA, { from: fresh.address, to: cfg.pay, value: qq.amount, validAfter: 0, validBefore: qq.expiry, nonce });
  };
  const g = await j("/api/intents/" + (await j("/api/intents", { method: "POST", body: { amount: 9, description: "Gasless" } })).id);
  const other = await j("/api/intents/" + (await j("/api/intents", { method: "POST", body: { amount: 9, description: "Other" } })).id);
  const gsig = await authFor(g.quote);
  const bad = await fetch(`${B}/api/intents/${other.id}/relay`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ payer: fresh.address, validAfter: 0, validBefore: g.quote.expiry, signature: gsig }) });
  assert(bad.status === 400, "signature for one payment is rejected for another (simulated, no gas spent)");
  const ok = await fetch(`${B}/api/intents/${g.id}/relay`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ payer: fresh.address, validAfter: 0, validBefore: g.quote.expiry, signature: gsig }) });
  assert(ok.status === 202, "relayer accepted gasless payment");
  const gs = await T.until(async () => { const x = await j("/api/intents/" + g.id); return x.payer ? x : null; }, 90) || await j("/api/intents/" + g.id);
  assert(["seen", "safe", "finalized"].includes(gs.status) && gs.payer === fresh.address && gs.gasless, "gasless payment indexed, payer recorded, gas sponsored");
  assert((await rpc.getBalance(fresh.address)) === 0n, "payer spent zero gas token");

  // ── Subscription lifecycle: plans, intro price, pause/resume, upgrade, dunning, metrics ──
  const ownerAddr = await owner.getAddress();
  await (await pay(owner).createPlan(1, cfg.token, 4_000_000n, 20, 0, 1_000_000n, 1)).wait();     // Basic: 4/20s, first cycle 1
  await (await pay(owner).createPlan(1, cfg.token, 8_000_000n, 20, 0, 0, 0)).wait();               // Pro: 8/20s
  const plans = await T.until(async () => { const l = await (await fetch(B + "/api/v1/plans")).json(); return l.some((p) => p.amount === "4000000") && l.some((p) => p.amount === "8000000") ? l : null; }, 60) || [];
  const basic = plans.find((p) => p.amount === "4000000"), pro = plans.find((p) => p.amount === "8000000");
  assert(basic && pro && basic.introAmount === "1000000", "plans indexed from chain and listed publicly");
  const subberAddr = await subber.getAddress();
  await (await tok(owner).mint(subberAddr, 100_000_000n)).wait();
  await (await tok(subber).approve(cfg.pay, 40_000_000n)).wait();
  await (await pay(subber).subscribeToPlan(basic.id, 40_000_000n, Math.floor(Date.now() / 1000) + 86400)).wait();
  let mine = await subUntil(subberAddr, (x) => x.charged === "1000000" && x.status === "active");
  const sid = mine[0].id;
  assert(mine[0].charged === "1000000" && mine[0].status === "active", "keeper charged the intro price first (1 USDT)");
  await (await pay(subber).pauseSubscription(sid)).wait();
  mine = await subUntil(subberAddr, (x) => x.status === "paused");
  assert(mine[0].status === "paused", "customer paused: status paused");
  await sleep(20);
  mine = await (await fetch(`${B}/api/v1/customers/${subberAddr}/subscriptions`)).json();
  assert(mine[0].charged === "1000000", "no charges while paused");
  await (await pay(subber).resumeSubscription(sid)).wait();
  await (await pay(subber).changePlan(sid, pro.id)).wait();                                    // upgrade (resume moved next charge to now, so nothing to prorate here)
  mine = await subUntil(subberAddr, (x) => x.planId === pro.id && BigInt(x.charged) > 1_000_000n);
  assert(mine[0].planId === pro.id && BigInt(mine[0].charged) > 1_000_000n, "upgrade applied; next renewal billed at the Pro price (charged " + mine[0].charged + "; proration amounts are covered by the contract tests)");
  // Dunning: customer revokes the allowance → past_due → re-approves → recovered
  await (await tok(subber).approve(cfg.pay, 0)).wait();
  mine = await subUntil(subberAddr, (x) => x.status === "past_due" && x.lastFailure === "low_allowance");
  assert(mine[0].status === "past_due" && mine[0].lastFailure === "low_allowance", "failed renewal → past_due (reason low_allowance)");
  await (await tok(subber).approve(cfg.pay, 40_000_000n)).wait();
  mine = await subUntil(subberAddr, (x) => x.status === "active");
  assert(mine[0].status === "active", "smart retry recovered the subscription");
  const subHooks = (await j("/api/webhooks")).map((h) => h.type);
  assert(["subscription.paused", "subscription.resumed", "subscription.upgraded", "subscription.past_due", "subscription.recovered", "subscription.renewal_upcoming"]
    .every((t) => subHooks.includes(t)), "lifecycle webhooks: paused, resumed, upgraded, past_due, recovered, renewal_upcoming");
  const m = await j("/api/subscriptions/metrics");
  assert(BigInt(m.mrr) > 0n && m.failedPaymentRecovery > 0, `metrics: MRR ${Number(m.mrr) / 1e6} USDT, recovery ${m.failedPaymentRecovery}`);
  await (await pay(subber).cancel(sid)).wait();

  // ── Invoices ──
  const payIntent = async (w, checkoutUrl) => {
    const pid = new URL(checkoutUrl, B).searchParams.get("i");
    const x = await j("/api/intents/" + pid);
    await (await tok(w).approve(cfg.pay, x.amount)).wait();
    await (await pay(w).pay([x.quote.merchantId, x.quote.intentId, x.quote.token, x.quote.amount, x.quote.expiry], x.signature)).wait();
    return x;
  };
  const pub = (p, body) => fetch(B + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const items = [{ description: "Design sprint", qty: 1, unitPrice: 100, taxPercent: 18 }, { description: "Hosting", qty: 2, unitPrice: 50 }];
  const inv1 = await j("/api/invoices", { method: "POST", body: { clientName: "Acme Pvt Ltd", clientTaxId: "27AAACA1234A1Z5", poRef: "PO-77", items, terms: "net_15" } });
  assert(inv1.total === 21800 && inv1.tax === 1800 && inv1.status === "open", "invoice totals: 200 + 18% GST on line 1 = 218.00");
  assert((await pub(`/api/invoices/${inv1.id}/pay`, { amount: 50 })).status === 400, "partial payment refused when the invoice doesn't allow it");

  const inv2 = await j("/api/invoices", { method: "POST", body: { clientName: "Two-party client", items, allowPartial: true, minPartial: 10 } });
  await (await tok(owner).mint(await second.getAddress(), 500_000_000n)).wait();
  const part = await (await pub(`/api/invoices/${inv2.id}/pay`, { amount: 100 })).json();
  const firstPay = await payIntent(buyer, part.checkoutUrl);
  let s2 = await invUntil(inv2.id, (x) => x.status === "partially_paid");
  assert(s2.status === "partially_paid" && s2.paid === 10000 && s2.balance === 11800, "first party paid 100 → partially paid, 118 left");
  const rest = await (await pub(`/api/invoices/${inv2.id}/pay`, { full: true })).json();
  await payIntent(second, rest.checkoutUrl);
  s2 = await invUntil(inv2.id, (x) => x.status === "paid");
  assert(s2.status === "paid" && s2.balance === 0 && s2.payments.length === 2 && new Set(s2.payments.map((p) => p.payer)).size === 2, "second party paid the rest → invoice paid by two wallets");

  // Refunding a payment reopens the invoice (status is derived from payments, never stored)
  await (await tok(owner).approve(cfg.pay, BigInt(firstPay.amount))).wait();
  await (await pay(owner).refund(firstPay.quote.intentId, BigInt(firstPay.amount), ethers.ZeroAddress, "0x", RC("other"))).wait();
  s2 = await invUntil(inv2.id, (x) => x.status === "partially_paid" && x.balance === 10000);
  assert(s2.status === "partially_paid" && s2.balance === 10000, "refunded invoice payment reopens the balance");

  const day = 86400, t0 = Math.floor(Date.now() / 1000);
  const late = await j("/api/invoices", { method: "POST", body: { clientName: "Late payer", items, issueDate: t0 - 20 * day, dueDate: t0 - 5 * day, lateFeePercent: 5 } });
  assert(late.status === "overdue" && late.lateFee === 1090 && late.balance === 22890, "overdue invoice adds a one-time 5% late fee");
  const aging = await j("/api/invoices/aging");
  assert(aging.USD && aging.USD["1_30"] >= 22890, "AR aging puts it in the 1–30 days bucket");

  const early = await j("/api/invoices", { method: "POST", body: { clientName: "Early bird", items, earlyDiscountPercent: 2, earlyDiscountDays: 10 } });
  assert(early.discountAvailable === 436 && early.payNowFull === 21364, "2% early-payment discount offered on full payment");
  const ep = await (await pub(`/api/invoices/${early.id}/pay`, { full: true })).json();
  await payIntent(buyer, ep.checkoutUrl);
  const es = await invUntil(early.id, (x) => x.status === "paid");
  assert(es.status === "paid" && es.discountsApplied === 436, "discounted full payment settles the invoice");

  assert((await fetch(`${B}/api/invoices/${early.id}/void`, { method: "POST", headers: { authorization: "Bearer " + KEY } })).status === 409, "invoice with payments can't be voided");
  const vd = await j(`/api/invoices/${inv1.id}/void`, { method: "POST" });
  assert(vd.status === "void" && (await pub(`/api/invoices/${inv1.id}/pay`, { full: true })).status === 409, "voided invoice can't be paid");
  const hooksNow = await j("/api/webhooks");
  assert(["invoice.created", "invoice.paid", "invoice.reminder", "invoice.voided"].every((t) => hooksNow.some((h) => h.type === t)), "invoice webhooks emitted (created, paid, reminder, voided)");

  // ── Multi-merchant: onboard merchant B through the platform API; data stays isolated ──
  const PH = { "content-type": "application/json", authorization: "Bearer " + T.PLATFORM };
  assert((await fetch(B + "/api/v1/platform/merchants", { method: "POST", headers: { ...PH, authorization: "Bearer nope" }, body: "{}" })).status === 401, "platform onboarding needs the platform key");
  const mb = await (await fetch(B + "/api/v1/platform/merchants", { method: "POST", headers: PH, body: JSON.stringify({ name: "Bazaar Seller B" }) })).json();
  const jb = async (p, o = {}) => { const r = await fetch(B + p, { ...o, headers: { "content-type": "application/json", authorization: "Bearer " + mb.apiKey, ...(o.headers || {}) }, body: o.body && JSON.stringify(o.body) }); return { status: r.status, body: await r.json() }; };
  assert(mb.apiKey?.startsWith("wp_test_") && mb.signerAddress && mb.status === "pending", "platform created merchant B (API key + separate quote signer)");
  assert((await jb("/api/v1/payments", { method: "POST", body: { amount: 5 } })).status === 403, "pending merchant can't take payments before registering on-chain");
  await (await pay(ownerB).registerMerchant(await ownerB.getAddress(), mb.signerAddress)).wait();
  await T.until(async () => (await jb("/api/v1/merchants/me")).body.status === "active", 90);
  const meB = (await jb("/api/v1/merchants/me")).body;
  assert(meB.status === "active" && meB.merchantId > 1 && meB.owner === (await ownerB.getAddress()), `on-chain registration linked merchant B (merchantId ${meB.merchantId})`);
  const pB = (await jb("/api/v1/payments", { method: "POST", body: { amount: 5, description: "B's order" } })).body;
  const pBf = await j("/api/intents/" + pB.id);
  assert(pBf.quote.merchantId === meB.merchantId, "B's quote is signed for B's merchant id");
  await (await tok(buyer).approve(cfg.pay, pBf.amount)).wait();
  await (await pay(buyer).pay([pBf.quote.merchantId, pBf.quote.intentId, pBf.quote.token, pBf.quote.amount, pBf.quote.expiry], pBf.signature)).wait();
  await T.until(async () => { const l = (await jb("/api/v1/payments")).body; return l.length === 1 && l[0].status !== "created"; }, 60);
  const listB = (await jb("/api/v1/payments")).body, listA = await j("/api/v1/payments");
  assert(listB.length === 1 && listB[0].status !== "created" && !listA.some((p) => p.id === pB.id), "B sees its paid payment; A doesn't see B's");
  assert((await tok(buyer).balanceOf(await ownerB.getAddress())) >= 5_000_000n, "B's money went to B's own payout wallet");
  const ledgerB = (await jb("/api/v1/ledger")).body;
  assert(ledgerB.length === 2 && ledgerB.every((l) => l.merchant_id === meB.merchantId), "B's ledger holds only B's double entry");
  assert(await T.until(async () => (await jb("/api/v1/reconcile")).body.ok, 60), "B's books reconcile with the chain");
  const invB = (await jb("/api/v1/invoices", { method: "POST", body: { clientName: "B client", items: [{ description: "x", unitPrice: 1 }] } })).body;
  assert(invB.number === "INV-0001", "invoice numbering is per merchant");
  assert((await fetch(`${B}/api/v1/invoices/${invB.id}/void`, { method: "POST", headers: { authorization: "Bearer " + KEY } })).status === 404, "A can't void B's invoice");
  const idemA = await (await fetch(B + "/api/v1/payments", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + KEY, "idempotency-key": "shared-key" }, body: '{"amount":2}' })).json();
  const idemB = (await jb("/api/v1/payments", { method: "POST", headers: { "idempotency-key": "shared-key" }, body: { amount: 2 } })).body;
  assert(idemA.id !== idemB.id, "the same Idempotency-Key in two merchants doesn't collide");
  await T.until(async () => (await jb("/api/v1/webhooks")).body.length > 0, 30);
  const hooksB = (await jb("/api/v1/webhooks")).body;
  assert(hooksB.length && hooksB.every((h) => h.status === "no_endpoint"), "B's webhooks wait for B's own endpoint (none set), never sent to A's");
  const upd = (await jb("/api/v1/merchants/me", { method: "POST", body: { name: "Bazaar Seller B", color: "#16a34a", webhookUrl: "ftp://bad" } }));
  assert(upd.status === 400, "merchant settings validate the webhook URL");
  const rot = (await jb("/api/v1/merchants/me/rotate-key", { method: "POST", body: {} })).body;
  assert((await jb("/api/v1/payments")).status === 401 && rot.apiKey, "rotating B's key revokes the old one immediately");

  const rec = await T.until(async () => { const r = await j("/api/reconcile"); return r.ok ? r : null; }, 60) || await j("/api/reconcile");
  assert(rec.ok, "ledger reconciles with chain " + JSON.stringify(rec.ledger));
  const hooks = await j("/api/webhooks");
  assert(hooks.some((h) => h.status === "delivered"), "webhooks delivered: " + hooks.filter((h) => h.status === "delivered").length + "/" + hooks.length);
  const demo = await j("/api/_demo_webhook");
  assert(demo.length && demo.every((d) => d.valid), "all webhook HMACs verified by receiver");
  const csv = await (await fetch(B + "/api/ledger.csv", { headers: { authorization: "Bearer " + KEY } })).text();
  assert(csv.split("\n").length > 4, "CSV export has rows");
  console.log("ALL GOOD");
})().catch((e) => { console.error(e); process.exit(1); });
