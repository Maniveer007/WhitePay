// Subscriptions: plans, lifecycle state, keeper (charging + dunning + renewal alerts) and SaaS metrics.
// The contract is the source of truth for subscription STATE (price, cap, charged, next charge, paused, plan):
// after any subscription event or reorg we re-read it from chain. Money movements are still booked from events.
const { ethers } = require("ethers");
const { db, kv } = require("../db");
const cfg = require("../config");
const wh = require("./webhooks");
const merchants = require("./merchants");

const now = () => Math.floor(Date.now() / 1000); // real time on purpose: charges are timed by the contract, not the test clock
const big = (x) => BigInt(x ?? 0);
const DAY = 86400;
const RETRY = (process.env.DUNNING_RETRY_SECONDS || `3600,${DAY},${3 * DAY},${7 * DAY}`).split(",").map(Number); // smart retries after a failed charge
const GRACE = Number(process.env.DUNNING_GRACE_DAYS || 7) * DAY; // past_due → unpaid after this
const NOTICE = Number(process.env.RENEWAL_NOTICE_HOURS || 72) * 3600;

db.exec(`CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY, merchant_id INTEGER, token TEXT, amount TEXT, intro_amount TEXT, intro_cycles INTEGER,
  period INTEGER, trial INTEGER, active INTEGER, name TEXT, created_at INTEGER)`);
for (const col of ["plan_id INTEGER", "pending_plan_id INTEGER", "charges INTEGER DEFAULT 0", "paused_by TEXT",
  "first_charge_at INTEGER", "fail_count INTEGER DEFAULT 0", "retry_at INTEGER", "past_due_since INTEGER", "unpaid INTEGER DEFAULT 0",
  "cancelled_at INTEGER", "past_due_count INTEGER DEFAULT 0", "recovered_count INTEGER DEFAULT 0", "created_at INTEGER", "last_failure TEXT"]) {
  try { db.exec(`ALTER TABLE subs ADD COLUMN ${col}`); } catch {}
}

let ctx; // { provider, abi }
const contract = () => new ethers.Contract(cfg.dep.pay, ctx.abi, ctx.provider);
function init(c) { ctx = c; }

/** Re-read one subscription's state from the contract. */
async function sync(id) {
  const c = contract();
  const [s, x] = await Promise.all([c.subscriptions(id), c.subState(id)]);
  if (s.payer === ethers.ZeroAddress) return;
  db.prepare(`UPDATE subs SET amount=?,cap=?,charged=?,next_charge=?,end_ts=?,cancelled=?,plan_id=?,pending_plan_id=?,charges=?,paused_by=? WHERE id=?`)
    .run(String(s.amount), String(s.cap), String(s.charged), Number(s.nextCharge), Number(s.end), s.cancelled ? 1 : 0,
      Number(x.planId) || null, Number(x.pendingPlanId) || null, Number(x.charges), x.pausedBy === ethers.ZeroAddress ? null : x.pausedBy, id);
}

async function syncPlan(id) {
  const p = await contract().plans(id);
  if (!merchants.isKnown(p.merchantId)) return;
  db.prepare(`INSERT INTO plans(id,merchant_id,token,amount,intro_amount,intro_cycles,period,trial,active,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET active=excluded.active`).run(id, Number(p.merchantId), p.token, String(p.amount), String(p.introAmount),
    Number(p.introCycles), Number(p.period), Number(p.trial), p.active ? 1 : 0, now());
}

function status(s) {
  if (s.cancelled) return "cancelled";
  if (s.unpaid) return "unpaid";
  if (s.paused_by) return "paused";
  if (s.fail_count > 0) return "past_due";
  if (s.plan_id && s.charges === 0 && s.first_charge_at && s.first_charge_at > (s.created_at || 0)) return "trialing";
  return "active";
}

function toApi(s) {
  const plan = s.plan_id ? db.prepare("SELECT * FROM plans WHERE id=?").get(s.plan_id) : null;
  return {
    id: s.id, merchantId: s.merchant_id, status: status(s), payer: s.payer, token: s.token, amount: s.amount, period: s.period, cap: s.cap, charged: s.charged,
    nextCharge: s.next_charge, end: s.end_ts, planId: s.plan_id, planName: plan?.name || null, pendingPlanId: s.pending_plan_id,
    charges: s.charges, pausedBy: s.paused_by, trialEndsAt: status(s) === "trialing" ? s.first_charge_at : null,
    failCount: s.fail_count, retryAt: s.retry_at, pastDueSince: s.past_due_since, lastFailure: s.last_failure, cancelledAt: s.cancelled_at,
    // Back-compat fields used by the existing pages.
    next_charge: s.next_charge, end_ts: s.end_ts, cancelled: s.cancelled,
  };
}

function planApi(p) {
  return { id: p.id, name: p.name, token: p.token, amount: p.amount, period: p.period, trial: p.trial,
    introAmount: p.intro_amount, introCycles: p.intro_cycles, active: !!p.active };
}

/** Called by the indexer for every subscription/plan event (merchant already filtered where the event carries it). */
async function onEvent(ev, log, ts, helpers) {
  const key = `${log.transactionHash}:${log.index}:${log.blockHash}`;
  const id = ev.args.subId !== undefined ? Number(ev.args.subId) : null;
  const known = id !== null ? db.prepare("SELECT * FROM subs WHERE id=?").get(id) : null;
  const merchantId = known?.merchant_id ?? (ev.args.merchantId !== undefined ? Number(ev.args.merchantId) : undefined);
  switch (ev.name) {
    case "SubscriptionCreated":
      if (!merchants.isKnown(ev.args.merchantId)) return;
      db.prepare(`INSERT OR IGNORE INTO subs(id,merchant_id,payer,token,amount,period,cap,next_charge,end_ts,tx_hash,first_charge_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, Number(ev.args.merchantId), ev.args.payer, ev.args.token, String(ev.args.amount),
        Number(ev.args.period), String(ev.args.cap), ts, Number(ev.args.end), log.transactionHash, ts, ts);
      helpers.record(log, ev.name, `sub:${id}`, null, null);
      wh.emit(`evt_${key}`, "subscription.created", { merchantId, id, payer: ev.args.payer });
      break;
    case "PlanSubscribed":
      if (!known) return;
      db.prepare("UPDATE subs SET first_charge_at=? WHERE id=?").run(Number(ev.args.firstChargeAt), id);
      helpers.record(log, ev.name, `sub:${id}`, null, null);
      if (Number(ev.args.firstChargeAt) > ts) wh.emit(`evt_${key}`, "subscription.trial_started", { merchantId, id, planId: Number(ev.args.planId), trialEndsAt: Number(ev.args.firstChargeAt) });
      break;
    case "SubscriptionCharged": {
      if (!known) return;
      const group = `sub:${key}`;
      helpers.post(group, ts, `sub:${id}`, `Subscription #${id} charge`, log, "assets:usdt_wallet", "revenue:subscriptions", ev.args.amount, merchantId);
      helpers.record(log, ev.name, `sub:${id}`, ev.args.amount, group);
      if (known.fail_count > 0) {
        db.prepare("UPDATE subs SET fail_count=0,retry_at=NULL,past_due_since=NULL,unpaid=0,last_failure=NULL,recovered_count=recovered_count+1 WHERE id=?").run(id);
        wh.emit(`evt_${key}_recovered`, "subscription.recovered", { merchantId, id, amount: String(ev.args.amount) });
      }
      wh.emit(`evt_${key}`, "subscription.charged", { merchantId, id, amount: String(ev.args.amount) });
      break;
    }
    case "SubscriptionRefunded": {
      if (!known) return;
      const group = `subrefund:${key}`, reason = helpers.reasonText ? helpers.reasonText(ev.args.reason) : "refund";
      helpers.post(group, ts, `sub:${id}`, `Subscription #${id} refund`, log, "contra:refunds", "assets:usdt_wallet", ev.args.amount, merchantId);
      helpers.record(log, ev.name, `sub:${id}`, ev.args.amount, group, { reason, operator: ev.args.operator, counterparty: ev.args.to });
      wh.emit(`evt_${key}`, "subscription.refunded", { merchantId, id, amount: String(ev.args.amount), totalRefunded: String(ev.args.totalRefunded), reason, operator: ev.args.operator, to: ev.args.to, tx: log.transactionHash });
      break;
    }
    case "PlanChanged": {
      if (!known) return;
      const prorated = big(ev.args.proratedCharge), group = `sub:${key}`;
      if (prorated > 0n) helpers.post(group, ts, `sub:${id}`, `Subscription #${id} upgrade (prorated)`, log, "assets:usdt_wallet", "revenue:subscriptions", prorated, merchantId);
      helpers.record(log, ev.name, `sub:${id}`, prorated > 0n ? prorated : null, prorated > 0n ? group : null);
      wh.emit(`evt_${key}`, ev.args.immediate ? "subscription.upgraded" : "subscription.downgrade_scheduled",
        { merchantId, id, fromPlan: Number(ev.args.fromPlan), toPlan: Number(ev.args.toPlan), proratedCharge: String(prorated) });
      break;
    }
    case "SubscriptionPaused": case "SubscriptionResumed":
      if (!known) return;
      helpers.record(log, ev.name, `sub:${id}`, null, null);
      wh.emit(`evt_${key}`, ev.name === "SubscriptionPaused" ? "subscription.paused" : "subscription.resumed", { merchantId, id, by: ev.args.by });
      break;
    case "SubscriptionCancelled":
      if (!known) return;
      db.prepare("UPDATE subs SET cancelled_at=? WHERE id=?").run(ts, id);
      helpers.record(log, ev.name, `sub:${id}`, null, null);
      wh.emit(`evt_${key}`, "subscription.cancelled", { merchantId, id });
      break;
    case "PlanCreated": case "PlanStatus":
      if (ev.name === "PlanCreated" && !merchants.isKnown(ev.args.merchantId)) return;
      await syncPlan(Number(ev.args.planId));
      helpers.record(log, ev.name, `plan:${Number(ev.args.planId)}`, null, null);
      return;
    default:
      return;
  }
  await sync(id);
}

/** Permissionless keeper with dunning. Anyone can run one; this is the merchant's own (fallback) keeper. */
let keeperWallet;
async function keeper(reasonOf) {
  const t = (await ctx.provider.getBlock("latest")).timestamp; // the contract checks chain time, not wall clock
  const tok = new ethers.Contract(cfg.dep.token, ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"], ctx.provider);
  const funds = async (s) => {
    const [bal, allow] = await Promise.all([tok.balanceOf(s.payer), tok.allowance(s.payer, cfg.dep.pay)]).catch(() => [null, null]);
    return bal === null ? null : bal < big(s.amount) ? "low_balance" : allow < big(s.amount) ? "low_allowance" : "ok";
  };

  // Pre-renewal notices (and trial-ending notices) so customers can top up or cancel before being charged.
  for (const s of db.prepare(`SELECT * FROM subs WHERE cancelled=0 AND unpaid=0 AND paused_by IS NULL AND next_charge>? AND next_charge<=?`).all(t, t + NOTICE)) {
    const api = toApi(s);
    const type = api.status === "trialing" ? "subscription.trial_will_end" : "subscription.renewal_upcoming";
    wh.emit(`evt_sub_${s.id}_notice_${s.next_charge}`, type, { ...api, chargesAt: s.next_charge });
    const f = await funds(s);
    if (f && f !== "ok") wh.emit(`evt_sub_${s.id}_atrisk_${s.next_charge}`, "subscription.renewal_at_risk", { ...api, reason: f });
  }

  if (!cfg.keeperKey) return;
  keeperWallet ||= new ethers.Wallet(cfg.keeperKey, ctx.provider);
  const c = new ethers.Contract(cfg.dep.pay, ctx.abi, keeperWallet);
  const due = db.prepare(`SELECT * FROM subs WHERE cancelled=0 AND unpaid=0 AND paused_by IS NULL AND next_charge<=? AND end_ts>=?
    AND (retry_at IS NULL OR retry_at<=?)`).all(t, t, now());
  for (const s of due) {
    try {
      await c.charge.staticCall(s.id); // pre-charge simulation: never pay gas for a charge that would revert
      const nonce = await ctx.provider.getTransactionCount(keeperWallet.address, "pending");
      await (await c.charge(s.id, { nonce })).wait();
    } catch (e) {
      const reason = (await funds(s)) === "ok" ? reasonOf(e) : await funds(s);
      if (reason === "CapReached") { // the customer's own cap: not a failure to chase
        wh.emit(`evt_sub_${s.id}_cap`, "subscription.cap_reached", { merchantId: s.merchant_id, id: s.id });
        db.prepare("UPDATE subs SET retry_at=? WHERE id=?").run(now() + 30 * DAY, s.id);
        continue;
      }
      const fails = s.fail_count + 1, since = s.past_due_since || now();
      const unpaid = now() - since >= GRACE;
      db.prepare(`UPDATE subs SET fail_count=?,retry_at=?,past_due_since=?,unpaid=?,last_failure=?,past_due_count=past_due_count+? WHERE id=?`)
        .run(fails, now() + RETRY[Math.min(fails - 1, RETRY.length - 1)], since, unpaid ? 1 : 0, reason, fails === 1 ? 1 : 0, s.id);
      if (fails === 1) wh.emit(`evt_sub_${s.id}_pastdue_${s.next_charge}`, "subscription.past_due", { ...toApi({ ...s, fail_count: 1 }), reason });
      else wh.emit(`evt_sub_${s.id}_retry_${s.next_charge}_${fails}`, "subscription.charge_failed", { merchantId: s.merchant_id, id: s.id, attempt: fails, reason });
      if (unpaid) wh.emit(`evt_sub_${s.id}_unpaid_${s.next_charge}`, "subscription.unpaid", { ...toApi({ ...s, unpaid: 1 }), reason });
    }
  }
}

/** SaaS metrics. MRR normalises every active plan to 30 days (USDT base units). */
function metrics(mid) {
  const all = db.prepare("SELECT * FROM subs WHERE merchant_id=?").all(mid).map((s) => ({ ...s, st: status(s) }));
  const month = 30 * DAY, t = now();
  const paying = all.filter((s) => ["active", "past_due"].includes(s.st));
  const mrr = paying.reduce((a, s) => a + (big(s.amount) * BigInt(month)) / BigInt(s.period || month), 0n);
  const cancelled30 = all.filter((s) => s.cancelled_at && s.cancelled_at >= t - month).length;
  const base = paying.length + all.filter((s) => s.st === "trialing").length + cancelled30;
  const pastDueEpisodes = all.reduce((a, s) => a + (s.past_due_count || 0), 0), recovered = all.reduce((a, s) => a + (s.recovered_count || 0), 0);
  const count = (st) => all.filter((s) => s.st === st).length;
  return {
    mrr: String(mrr), arr: String(mrr * 12n),
    counts: { active: count("active"), trialing: count("trialing"), past_due: count("past_due"), paused: count("paused"), unpaid: count("unpaid"), cancelled: count("cancelled") },
    churn30d: base ? cancelled30 / base : 0,
    failedPaymentRecovery: pastDueEpisodes ? recovered / pastDueEpisodes : null,
  };
}

module.exports = { init, sync, syncPlan, onEvent, keeper, metrics, toApi, planApi, status };
