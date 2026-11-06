// End-to-end test of the extension features on the Whitechain testnet (needs `npm run testnet` running):
// credit notes, recurring invoices + off-chain test clock, statements/exports, period close, auditor key, x402, agent policies, metering,
// subscription refunds and marketplace splits. Contract timers use real, short durations (payout delay 60s, splitter hold 40s).
const T = require("../support/testnet");
const { ethers, until } = T;
const zlib = require("zlib");
const B = T.API, KEY = T.KEY;
const raw = (p, o = {}, key = KEY) => fetch(B + p, { ...o, headers: { "content-type": "application/json", authorization: "Bearer " + key, ...(o.headers || {}) }, body: o.body && JSON.stringify(o.body) });
const j = async (p, o, key) => (await raw(p, o, key)).json();
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok  ", m); };
(async () => {
  const cfg = await j("/api/config"), ext = await j("/api/extensions");
  const rpc = T.provider;
  const owner = T.deployer; // owns merchant #1
  const [human, agent] = await T.fresh(2); // a payer and an AI agent, new every run
  const tok = (w) => new ethers.Contract(cfg.token, ["function mint(address,uint256)", "function approve(address,uint256)", "function balanceOf(address) view returns (uint256)"], w);
  const payAbi = require("../../artifacts/contracts/WhitePay.sol/WhitePay.json").abi;
  const pay = (w) => new ethers.Contract(cfg.pay, payAbi, w);
  assert(ext.agent && ext.metered, "agent and metering modules are deployed");
  const humanAddr = await human.getAddress();
  await (await tok(owner).mint(humanAddr, 2_000_000_000n)).wait();

  // ── Credit notes ──
  const inv = await j("/api/invoices", { method: "POST", body: { clientName: "Acme", currency: "USD", items: [{ description: "Work", qty: 1, unitPrice: 100 }] } });
  const cn = await j(`/api/invoices/${inv.id}/credit-notes`, { method: "POST", body: { amount: 30, reason: "pricing_error" } });
  assert(cn.number === "CN-0001" && cn.invoice.balance === 7000 && cn.invoice.credits === 3000, "credit note reduces the balance to 70.00");
  const over = await j(`/api/invoices/${inv.id}/credit-notes`, { method: "POST", body: { amount: 80 } });
  assert(over.error?.code === "invalid_amount", "credit note above the remaining invoice value is rejected");
  const full = await j(`/api/invoices/${inv.id}/credit-notes`, { method: "POST", body: { amount: 70 } });
  assert(full.invoice.status === "credited" && full.invoice.balance === 0, "fully credited invoice has nothing left to pay");

  // ── Recurring invoices + test clock ──
  const rec = await j("/api/recurring-invoices", { method: "POST", body: { frequency: "monthly", template: { clientName: "Retainer Co", currency: "USD", items: [{ description: "Retainer", unitPrice: 500 }] } } });
  assert(rec.runs === 1 && rec.lastInvoiceId, "recurring schedule issues its first invoice immediately");
  const bad = await j("/api/recurring-invoices", { method: "POST", body: { frequency: "monthly", template: { clientName: "X", items: [] } } });
  assert(bad.error?.code === "invalid_items", "an invalid template is rejected up front");
  const c0 = await j("/api/test-clock");
  assert(c0.enabled, "the off-chain test clock is enabled");
  await j("/api/test-clock/advance", { method: "POST", body: { days: 65 } });
  const recs = await j("/api/recurring-invoices");
  const mine = recs.find((r) => r.id === rec.id);
  assert(mine.runs === 3, `two more invoices after 65 days (runs=${mine.runs})`);
  await j(`/api/recurring-invoices/${rec.id}/pause`, { method: "POST" });
  await j("/api/test-clock/advance", { method: "POST", body: { days: 40 } });
  assert((await j("/api/recurring-invoices")).find((r) => r.id === rec.id).runs === 3, "a paused schedule issues nothing");
  const resumed = await j(`/api/recurring-invoices/${rec.id}/resume`, { method: "POST" });
  assert(resumed.runs === 3 && resumed.nextRun > (await j("/api/test-clock")).now, "resuming skips the paused period instead of back-billing");

  // ── A real payment, then statements ──
  // The chain is persistent: subscriptions from earlier runs may still be charging, so measure the INCREASE caused by this payment.
  const rev0 = BigInt((await j("/api/statements?format=json")).summary.revenue);
  const it = await j("/api/intents", { method: "POST", body: { amount: 25, currency: "USD", description: "Stmt", policy: "seen", orderRef: "ext_" + Date.now() } });
  const fi = await j("/api/intents/" + it.id), q = fi.quote;
  await (await tok(human).approve(cfg.pay, q.amount)).wait();
  await (await pay(human).pay([q.merchantId, q.intentId, q.token, q.amount, q.expiry], fi.signature)).wait();
  const stJson = await until(async () => { const x = await j("/api/statements?format=json"); return BigInt(x.summary.revenue) - rev0 >= 25_000_000n && x; }, 90) || await j("/api/statements?format=json");
  assert(BigInt(stJson.summary.revenue) - rev0 >= 25_000_000n, "statement summary counts the payment as revenue");
  const xl = Buffer.from(await (await raw("/api/statements?format=xlsx")).arrayBuffer());
  assert(xl.slice(0, 2).toString() === "PK" && xl.includes("xl/workbook.xml") && xl.includes("xl/worksheets/sheet2.xml"), "xlsx export is a valid workbook zip");
  const pdf = Buffer.from(await (await raw("/api/statements?format=pdf")).arrayBuffer());
  assert(pdf.slice(0, 5).toString() === "%PDF-" && pdf.includes("%%EOF"), "pdf export is a PDF");
  const xero = await (await raw("/api/statements?format=xero")).text();
  if (!(xero.includes('"1010"') && xero.includes('"4000"'))) console.log("xero output was:\n" + xero.slice(0, 500));
  assert(xero.startsWith('"*Narration",') && xero.includes('"1010"') && xero.includes('"4000"'), "xero journal CSV uses account codes");
  const qb = await (await raw("/api/statements?format=quickbooks")).text();
  assert(qb.startsWith('"JournalNo"') && qb.includes("USDT Wallet"), "quickbooks journal CSV uses account names");
  const sumDebits = qb.split("\r\n").slice(1).filter(Boolean).reduce((a, l) => { const c = l.split('","'); return a + Number(c[5] || 0) - Number(c[6] || 0); }, 0);
  assert(Math.abs(sumDebits) < 1e-6, "exported journals balance (debits = credits)");

  // ── Period close ──
  const t = (await j("/api/test-clock")).now;
  const open = await j("/api/periods/close", { method: "POST", body: { from: 0, to: t + 1000 } });
  assert(open.error?.code === "period_not_ended", "cannot close a period that has not ended");
  const closed = await j("/api/periods/close", { method: "POST", body: { from: 0, to: t - 1, label: "All history" } });
  assert(closed.status === "closed" && closed.drift === false && closed.hash.length === 64, "period closes with a snapshot hash");
  const overlap = await j("/api/periods/close", { method: "POST", body: { from: 10, to: 20 } });
  assert(overlap.error?.code === "period_overlap", "overlapping close is rejected");
  const backdated = await j("/api/invoices", { method: "POST", body: { clientName: "Late", issueDate: 5, items: [{ description: "x", unitPrice: 1 }] } });
  assert(backdated.error?.code === "period_closed", "back-dating an invoice into a closed period is rejected");
  const reopened = await j(`/api/periods/${closed.id}/reopen`, { method: "POST", body: { reason: "e2e cleanup" } });
  assert(reopened.status === "reopened", "a closed period can be reopened with a reason");

  // ── Auditor key ──
  const ak = await j("/api/auditor-key", { method: "POST" });
  assert(ak.auditorKey?.startsWith("wp_audit_"), "auditor key issued");
  const aRead = await raw("/api/ledger", {}, ak.auditorKey);
  assert(aRead.status === 200, "auditor key can read the ledger");
  const aWrite = await j("/api/invoices", { method: "POST", body: { clientName: "x", items: [{ description: "x", unitPrice: 1 }] } }, ak.auditorKey);
  assert(aWrite.error?.code === "read_only", "auditor key cannot create anything");
  const aClose = await j("/api/periods/close", { method: "POST", body: { from: 0, to: 1 } }, ak.auditorKey);
  assert(aClose.error?.code === "read_only", "auditor key cannot close periods or rotate keys");
  await j("/api/auditor-key/revoke", { method: "POST" });
  assert((await raw("/api/ledger", {}, ak.auditorKey)).status === 401, "revoked auditor key stops working");

  // ── x402 ──
  const r1 = await raw("/api/x402/demo");
  const ch = await r1.json();
  assert(r1.status === 402 && ch.accepts[0].extra.signature, "paid resource answers 402 with a signed quote");
  const a0 = ch.accepts[0], xq = a0.extra.quote;
  const unpaid = await raw("/api/x402/demo", { headers: { "x-payment": Buffer.from(JSON.stringify({ paymentId: a0.paymentId })).toString("base64") } });
  assert(unpaid.status === 402, "claiming access before paying is refused");
  await (await tok(human).approve(cfg.pay, xq.amount)).wait();
  await (await pay(human).pay([xq.merchantId, xq.intentId, xq.token, xq.amount, xq.expiry], a0.extra.signature)).wait();
  const hdr = { "x-payment": Buffer.from(JSON.stringify({ paymentId: a0.paymentId })).toString("base64") };
  const ok = await until(async () => { const r = await raw("/api/x402/demo", { headers: hdr }); return r.status === 200 ? r : (await r.arrayBuffer(), null); });
  assert(ok && (await ok.json()).answer, "paying the quote unlocks the resource");
  assert((await raw("/api/x402/demo", { headers: hdr })).status === 402, "one payment buys one response");

  // ── Agent policies ──
  const agentAddr = await agent.getAddress();
  const agentC = (w) => new ethers.Contract(ext.agent, require("../../artifacts/contracts/WhitePayAgent.sol/WhitePayAgent.json").abi, w);
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400 + 100 * 86400;
  await (await tok(human).approve(cfg.pay, 500_000_000n)).wait();
  await (await agentC(human).setPolicy(agentAddr, 10_000_000n, 15_000_000n, exp, false)).wait();
  const pol = await j(`/api/agents/policy?owner=${humanAddr}&agent=${agentAddr}`);
  assert(pol.active && pol.perPayment === "10000000", "policy is readable through the API");
  const ag = async (amt) => { const i = await j("/api/intents", { method: "POST", body: { amount: amt, currency: "USD", orderRef: "ag_" + Math.random() } }); const f = await j("/api/intents/" + i.id); return { i, f, q: f.quote }; };
  const a1 = await ag(8);
  await (await agentC(agent).agentPay(humanAddr, [a1.q.merchantId, a1.q.intentId, a1.q.token, a1.q.amount, a1.q.expiry], a1.f.signature)).wait();
  const paidByAgent = await until(async () => { const x = await j("/api/intents/" + a1.i.id); return x.payer && x; }) || await j("/api/intents/" + a1.i.id);
  assert(paidByAgent.payer?.toLowerCase() === humanAddr.toLowerCase() && ["seen", "safe", "finalized"].includes(paidByAgent.status), "agent payment is indexed as the owner's payment");
  const a2 = await ag(8);
  let blocked = false;
  try { await agentC(agent).agentPay.staticCall(humanAddr, [a2.q.merchantId, a2.q.intentId, a2.q.token, a2.q.amount, a2.q.expiry], a2.f.signature); } catch (e) { blocked = e.revert?.name === "OverDailyLimit"; if (!blocked) console.log("   got:", e.revert?.name, e.shortMessage, e.info?.error?.message); }
  assert(blocked, "the daily limit stops a second 8 USDT payment (8 + 8 > 15)");
  await (await agentC(human).revoke(agentAddr)).wait();
  let revoked = false;
  try { await agentC(agent).agentPay.staticCall(humanAddr, [a2.q.merchantId, a2.q.intentId, a2.q.token, a2.q.amount, a2.q.expiry], a2.f.signature); } catch (e) { revoked = e.revert?.name === "NoPolicy"; }
  assert(revoked, "a revoked agent can no longer spend");
  const ch2 = await j(`/api/customers/${humanAddr}/agents`);
  assert(ch2.length >= 1 && ch2[0].agent === agentAddr, "the owner's portal lists what their agent spent");

  // ── Metering ──
  const mc = (w) => new ethers.Contract(ext.metered, require("../../artifacts/contracts/WhitePayMetered.sol/WhitePayMetered.json").abi, w);
  await (await tok(human).approve(ext.metered, 1_000_000_000n)).wait();
  const end = Math.floor(Date.now() / 1000) + 400 * 86400 + 200 * 86400;
  const rc = await (await mc(human).open(cfg.merchantId, cfg.token, { seatPrice: 5_000_000n, seats: 3, unitPrice: 10_000n, usageBudget: 20_000_000n, period: 30n * 86400n, cap: 500_000_000n, end })).wait();
  const meterId = Number(new ethers.Interface(["event MeterOpened(uint256 indexed meterId,uint256 indexed merchantId,address indexed payer,address token,(uint128,uint32,uint128,uint128,uint64,uint128,uint64) terms)"]).parseLog(rc.logs.find((l) => l.address.toLowerCase() === ext.metered.toLowerCase())).args.meterId);
  await (await mc(owner).chargeSeats(meterId)).wait();
  const m1 = await j("/api/meters/" + meterId);
  assert(m1.charged === "15000000" && m1.seats === 3, "seat billing charged 3 × 5 USDT");
  const portal = await j(`/api/customers/${humanAddr}/meters`);
  assert(portal.some((m) => m.id === meterId), "the payer's portal lists the meter");
  // the quote signer needs gas to report usage
  const signerAddr = cfg.signerAddress;
  await (await owner.sendTransaction({ to: signerAddr, value: ethers.parseEther("0.02") })).wait(); // gas for the quote signer
  const u1 = await j(`/api/meters/${meterId}/usage`, { method: "POST", body: { units: 1000, reportId: "batch-1" } });
  assert(u1.ok && u1.txHash, "usage report charges 1000 units at the payer's 0.01 price");
  const u2 = await j(`/api/meters/${meterId}/usage`, { method: "POST", body: { units: 1000, reportId: "batch-1" } });
  assert(u2.error?.code === "usage_rejected", "the same report id cannot be billed twice");
  const u3 = await j(`/api/meters/${meterId}/usage`, { method: "POST", body: { units: 5000, reportId: "batch-2" } });
  assert(u3.error?.code === "usage_rejected", "usage above the payer's period budget is rejected by the contract");

  // ── Credit note after payment → refund plan → onchain refund ──
  const pi = await j("/api/invoices", { method: "POST", body: { clientName: "Paid Co", currency: "USD", items: [{ description: "Goods", qty: 1, unitPrice: 40 }] } });
  const pr = await j(`/api/invoices/${pi.id}/pay`, { method: "POST", body: { policy: "seen" } });
  const payId = new URL(pr.checkoutUrl, "http://x").searchParams.get("i");
  const pf = await j("/api/intents/" + payId);
  await (await tok(human).approve(cfg.pay, pf.quote.amount)).wait();
  await (await pay(human).pay([pf.quote.merchantId, pf.quote.intentId, pf.quote.token, pf.quote.amount, pf.quote.expiry], pf.signature)).wait();
  assert(await until(async () => (await j("/api/invoices/" + pi.id)).status === "paid"), "invoice is paid");
  const cn2 = await j(`/api/invoices/${pi.id}/credit-notes`, { method: "POST", body: { amount: 15, reason: "returned_goods" } });
  assert(cn2.invoice.refundDue === 1500 && cn2.invoice.refundPlan.length === 1, "credit note after payment reports 15.00 owed back and a refund plan");
  const plan = cn2.invoice.refundPlan[0];
  assert(plan.usdt === "15000000" && plan.paymentId === payId, "the plan refunds exactly 15 USDT of the payment that was made");
  await (await tok(owner).mint(await owner.getAddress(), 100_000_000n)).wait();
  await (await tok(owner).approve(cfg.pay, plan.usdt)).wait();
  await (await pay(owner).refund(plan.intentId, plan.usdt, ethers.ZeroAddress, "0x", ethers.encodeBytes32String("other"))).wait();
  const settled = await until(async () => { const x = await j("/api/invoices/" + pi.id); return x.refundDue === 0 ? x : null; });
  assert(settled && settled.refundPlan.length === 0 && settled.status === "paid", "after the refund the invoice owes nothing back and stays paid");
  // A second credit note larger than what is left of the first payment splits across payments only as far as money exists.
  const cn3 = await j(`/api/invoices/${pi.id}/credit-notes`, { method: "POST", body: { amount: 25 } });
  assert(cn3.invoice.refundDue === 2500 && cn3.invoice.refundPlan[0].usdt === "25000000", "crediting the rest plans the remaining 25 USDT");

  // ── Subscription refund: prorated quote → onchain refund → ledger and reconciliation ──
  const nowTs = (await rpc.getBlock("latest")).timestamp;
  await (await tok(human).approve(cfg.pay, 1_000_000_000n)).wait();
  const subTx = await (await pay(human).subscribe(1, cfg.token, 30_000_000n, 30 * 86400, nowTs + 365 * 86400, 300_000_000n)).wait();
  const subId = Number(pay(human).interface.parseLog(subTx.logs.find((l) => { try { return pay(human).interface.parseLog(l).name === "SubscriptionCreated"; } catch { return false; } })).args.subId);
  await (await pay(human).charge(subId)).wait();
  const sq = await until(async () => { const x = await j(`/api/subscriptions/${subId}/refund-quote?at=${nowTs + 5}`); return x.lastCharge === "30000000" ? x : null; });

  assert(sq && sq.maxRefundable === "30000000" && BigInt(sq.suggested) > 29_000_000n, "refund quote suggests nearly the whole charge right after charging");
  const half = await j(`/api/subscriptions/${subId}/refund-quote?at=${sq.periodStart + 15 * 86400}`);
  assert(Math.abs(Number(half.suggested) - 15_000_000) < 20_000, "halfway through the period the suggested refund is about half");
  const late = await j(`/api/subscriptions/${subId}/refund-quote?at=${sq.periodEnd + 5}`);
  assert(late.suggested === "0", "after the period ends nothing is left to refund");
  await (await tok(owner).approve(cfg.pay, 12_000_000n)).wait();
  await (await pay(owner).refundSubscription(subId, 12_000_000n, ethers.encodeBytes32String("other"))).wait();
  const after = await until(async () => { const x = await j(`/api/subscriptions/${subId}/refund-quote?at=${nowTs + 5}`); return x.alreadyRefunded === "12000000" ? x : null; });
  assert(after && after.maxRefundable === "18000000", "the indexer records the refund and lowers what can still be refunded");
  const recon = await until(async () => { const r = await j("/api/reconcile"); return r.ok ? r : null; }, 20);
  assert(recon, "reconciliation still balances with a subscription refund in the ledger");
  const evs = await until(async () => { const e = await j("/api/events?after_id=0&limit=500"); return e.some((x) => x.type === "subscription.refunded") ? e : null; });
  assert(evs, "a subscription.refunded webhook event is emitted");

  // ── Marketplace: deploy a splitter from the artifact the dashboard uses, make it the payout, pay, sweep, return, release ──
  const art = await j("/api/splitter-artifact");
  assert(art.bytecode?.length > 100 && art.abi?.length, "the server serves the compiled splitter for in-browser deployment");
  const HOLD = 120, ownerAddr = await owner.getAddress(), feeAddr = await agent.getAddress(), originalPayout = cfg.payout;
  const splitter = await (await new ethers.ContractFactory(art.abi, art.bytecode, owner).deploy(ownerAddr, ownerAddr, [feeAddr], [1000], HOLD)).waitForDeployment();
  const spAddr = await splitter.getAddress();
  const spInfo = await j("/api/splitters/" + spAddr);
  assert(spInfo.seller === ownerAddr && spInfo.totalSplitBps === 1000 && spInfo.recipients[0].bps === 1000 && spInfo.holdSeconds === HOLD, "the server reads the splitter's rules from the chain");
  assert((await j("/api/splitters/" + ownerAddr)).error?.code === "not_a_splitter", "a normal wallet is not accepted as a splitter");
  await (await pay(owner).queuePayout(1, spAddr)).wait();
  await new Promise((r) => setTimeout(r, (cfg.payoutDelay + 20) * 1000)); // the payout-change timelock is enforced by the chain's own clock
  await (await pay(owner).applyPayout(1)).wait();
  assert(await until(async () => (await j("/api/splitters/" + spAddr)).payoutOf.includes(1)), "after the timelock the splitter is the merchant's payout wallet");
  const mi = await j("/api/intents", { method: "POST", body: { amount: 50, currency: "USD", policy: "seen", orderRef: "mk_" + Date.now() } });
  const mf = await j("/api/intents/" + mi.id);
  await (await tok(human).approve(cfg.pay, mf.quote.amount)).wait();
  await (await pay(human).pay([mf.quote.merchantId, mf.quote.intentId, mf.quote.token, mf.quote.amount, mf.quote.expiry], mf.signature)).wait();
  const bal = (w, a) => tok(w).balanceOf(a);
  assert(await bal(owner, spAddr) === 50_000_000n, "the buyer's 50 USDT arrives in the splitter, not in the seller's wallet");
  const fee0 = await bal(agent, feeAddr);
  await (await new ethers.Contract(spAddr, art.abi, owner).sweep(cfg.token)).wait();
  const sweptAt = (await rpc.getBlock("latest")).timestamp;
  assert((await bal(agent, feeAddr)) - fee0 === 5_000_000n, "sweep pays the platform fee (10%) immediately");
  assert((await j("/api/splitters/" + spAddr)).held === "45000000", "the seller's 45 USDT is held");
  const h0 = await bal(human, humanAddr);
  await (await new ethers.Contract(spAddr, art.abi, owner).returnHeld(cfg.token, humanAddr, 10_000_000n, ethers.encodeBytes32String("refund"))).wait();
  assert((await bal(human, humanAddr)) - h0 === 10_000_000n && (await j("/api/splitters/" + spAddr)).held === "35000000", "the arbiter returns 10 USDT of held funds to the buyer");
  const s0 = await bal(owner, ownerAddr);
  await (await new ethers.Contract(spAddr, art.abi, owner).release(cfg.token)).wait();
  assert((await bal(owner, ownerAddr)) === s0, "nothing is released to the seller before the hold ends");
  while ((await rpc.getBlock("latest")).timestamp < sweptAt + HOLD + 2) await new Promise((r) => setTimeout(r, 2000)); // wait out the hold on-chain
  await (await new ethers.Contract(spAddr, art.abi, owner).release(cfg.token, { gasLimit: 300000 })).wait(); // explicit limit: don't let a stale gas estimate decide
  assert((await bal(owner, ownerAddr)) - s0 === 35_000_000n, "after the hold the remaining 35 USDT is released to the seller");
  const exc = await j("/api/exceptions");
  assert(!exc.some((x) => x.sender?.toLowerCase?.() === spAddr.toLowerCase()), "splitter movements don't raise payout-wallet exceptions");
  // Put the payout wallet back so the next suites see merchant #1 as it was deployed.
  await (await pay(owner).queuePayout(1, originalPayout)).wait();
  await new Promise((r) => setTimeout(r, (cfg.payoutDelay + 20) * 1000));
  await (await pay(owner).applyPayout(1)).wait();
  assert(await until(async () => !(await j("/api/splitters/" + spAddr)).payoutOf.includes(1)), "the payout wallet is restored");

  console.log("\nAll extension checks passed.");
})().catch((e) => { console.error(e); process.exit(1); });
void zlib;
