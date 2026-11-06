const { ethers } = require("ethers");
const { db, kv } = require("../db");
const cfg = require("../config");
const wh = require("./webhooks");
const invoices = require("./invoices");
const subs = require("./subscriptions");
const merchants = require("./merchants");
const abi = require("../../artifacts/contracts/WhitePay.sol/WhitePay.json").abi;

const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, undefined, { staticNetwork: true });
const iface = new ethers.Interface(abi);
subs.init({ provider, abi });
const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const ORDER = ["created", "seen", "safe", "finalized"];
const CHUNK = Number(process.env.LOG_CHUNK || 2000); // public RPCs cap getLogs ranges

const now = () => Math.floor(Date.now() / 1000);
const big = (x) => BigInt(x ?? 0);

/** getLogs that adapts to the RPC's range limit: a rejected range is split in half and retried (public RPCs vary, and change). */
async function getLogsRange(filter, from, to) {
  try { return await provider.getLogs({ ...filter, fromBlock: from, toBlock: to }); }
  catch (e) {
    if (to - from < 16) throw e; // small ranges failing is a real error, not a range limit
    const mid = from + Math.floor((to - from) / 2);
    return [...await getLogsRange(filter, from, mid), ...await getLogsRange(filter, mid + 1, to)];
  }
}
async function getLogsChunked(filter, from, to) {
  const out = [];
  for (let a = from; a <= to; a += CHUNK) out.push(...await getLogsRange(filter, a, Math.min(a + CHUNK - 1, to)));
  return out;
}

const tsCache = new Map();
async function blockTime(n) {
  if (!tsCache.has(n)) { tsCache.set(n, (await provider.getBlock(n)).timestamp); if (tsCache.size > 5000) tsCache.clear(); }
  return tsCache.get(n);
}

// ───────── Ledger ─────────
const insLine = db.prepare(`INSERT OR IGNORE INTO ledger(ts,entry_group,account,debit,credit,intent_id,memo,tx_hash,log_index,block_number,merchant_id)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
/** Double-entry: every pair of lines is tied to one onchain log, in one merchant's books. */
function post(group, ts, ref, memo, log, debitAcct, creditAcct, amount, mid) {
  insLine.run(ts, group, debitAcct, String(amount), "0", ref, memo, log.transactionHash, log.index, log.blockNumber, mid);
  insLine.run(ts, group, creditAcct, "0", String(amount), ref, memo, log.transactionHash, log.index, log.blockNumber, mid);
}
/** Append-only: a reorg never deletes lines, it adds mirrored reversal lines. */
function reverseGroup(group) {
  for (const l of db.prepare("SELECT * FROM ledger WHERE entry_group=?").all(group))
    insLine.run(now(), `rev:${group}`, l.account, l.credit, l.debit, l.intent_id, `REORG reversal: ${l.memo}`, l.tx_hash, l.log_index, l.block_number, l.merchant_id);
}

// ───────── Derived state (recomputed from active events) ─────────
function recomputeIntent(id) {
  const refunded = db.prepare("SELECT amount FROM chain_events WHERE ref=? AND name='Refunded' AND status='active'").all(id)
    .reduce((a, r) => a + big(r.amount), 0n);
  db.prepare("UPDATE intents SET refunded=? WHERE id=?").run(String(refunded), id);
}

function record(log, name, ref, amount, group, extra = {}) {
  db.prepare(`INSERT OR IGNORE INTO chain_events(key,name,ref,amount,block_number,block_hash,tx_hash,log_index,ledger_group,seen_at,reason,operator,counterparty)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventKey(log), name, ref, amount == null ? null : String(amount), log.blockNumber, log.blockHash,
    log.transactionHash, log.index, group, now(), extra.reason ?? null, extra.operator ?? null, extra.counterparty ?? null);
}
/** bytes32 reason code -> readable string (falls back to hex for non-text codes). */
const reasonText = (b) => { try { return ethers.decodeBytes32String(b); } catch { return b; } };
const eventKey = (l) => `${l.transactionHash}:${l.index}:${l.blockHash}`;
const known = (l) => !!db.prepare("SELECT 1 FROM chain_events WHERE key=?").get(eventKey(l));

const SUB_EVENTS = new Set(["SubscriptionCreated", "PlanSubscribed", "SubscriptionCharged", "PlanChanged", "SubscriptionPaused",
  "SubscriptionResumed", "SubscriptionCancelled", "SubscriptionRefunded", "PlanCreated", "PlanStatus"]);

async function handleLog(log) {
  if (known(log)) return; // idempotent: re-scans after restarts or reorgs are safe
  const ev = iface.parseLog(log);
  if (!ev) return;
  const ts = await blockTime(log.blockNumber);
  const key = eventKey(log);

  if (ev.name === "PaymentReceived") {
    const id = ev.args.intentId;
    const row = db.prepare("SELECT * FROM intents WHERE id=?").get(id);
    if (!row || row.merchant_id !== Number(ev.args.merchantId)) return; // not created through this server for that merchant
    const rcpt = await provider.getTransactionReceipt(log.transactionHash);
    const group = `pay:${key}`;
    db.prepare(`UPDATE intents SET payer=?,tx_hash=?,block_number=?,block_hash=?,log_index=?,paid_at=?,finality='seen',fulfillable=0,
      gas_used=?,gas_price=?,gas_payer=? WHERE id=?`).run(ev.args.payer, log.transactionHash, log.blockNumber, log.blockHash, log.index,
      ts, String(rcpt.gasUsed), String(rcpt.gasPrice ?? 0), rcpt.from, id);
    post(group, ts, id, row.invoice_id ? `Invoice payment ${row.public_id}` : `Payment ${row.order_ref || row.public_id}`, log,
      "assets:usdt_wallet", row.invoice_id ? "revenue:invoices" : "revenue:sales", ev.args.amount, row.merchant_id);
    record(log, ev.name, id, ev.args.amount, group);
    wh.emit(`evt_${key}_seen`, "payment.seen", publicIntent(id));
    if (row.invoice_id) invoices.onPaymentChange(row.invoice_id, `pay_${key}`);
  } else if (ev.name === "Refunded") {
    const id = ev.args.intentId;
    const row = db.prepare("SELECT * FROM intents WHERE id=?").get(id);
    if (!row) return;
    const group = `refund:${key}`, reason = reasonText(ev.args.reason);
    post(group, ts, id, `Refund ${row.order_ref || row.public_id} (${reason})`, log, "contra:refunds", "assets:usdt_wallet", ev.args.amount, row.merchant_id);
    record(log, ev.name, id, ev.args.amount, group, { reason, operator: ev.args.operator, counterparty: ev.args.to });
    recomputeIntent(id);
    // An open customer request is resolved once refunds cover what was asked for.
    const refundedNow = big(db.prepare("SELECT refunded FROM intents WHERE id=?").get(id).refunded);
    db.prepare(`UPDATE refund_requests SET status='refunded',resolved_at=?,resolution=? WHERE intent_id=? AND status='open'
      AND CAST(amount AS INTEGER) <= ?`).run(now(), log.transactionHash, id, String(refundedNow));
    const full = big(ev.args.totalRefunded) === big(row.amount);
    if (row.invoice_id) invoices.onPaymentChange(row.invoice_id, `refund_${key}`);
    wh.emit(`evt_${key}_refund`, full ? "payment.refunded" : "payment.partially_refunded",
      { ...publicIntent(id), refund: { amount: String(ev.args.amount), reason, operator: ev.args.operator, to: ev.args.to, tx: log.transactionHash } });
  } else if (SUB_EVENTS.has(ev.name)) {
    await subs.onEvent(ev, log, ts, { post, record, reasonText });
  } else if (ev.name === "MerchantRegistered") {
    // Remember owner/payout; the QuoteSignerSet in the same tx links it to a pending WhitePay merchant.
    kv.set(`reg:${ev.args.merchantId}`, JSON.stringify({ owner: ev.args.owner, payout: ev.args.payout }));
  } else if (ev.name === "QuoteSignerSet") {
    const reg = JSON.parse(kv.get(`reg:${ev.args.merchantId}`) || "{}");
    const m = merchants.onSignerSet(ev.args.merchantId, ev.args.signer, ev.args.allowed, reg.owner, reg.payout);
    if (m) { record(log, ev.name, null, null, null); wh.emit(`evt_${key}`, "merchant.activated", { merchantId: m.onchain_id, uid: m.uid }); }
  } else if (ev.name === "PayoutChanged") {
    if (!merchants.isKnown(ev.args.merchantId)) return;
    merchants.onPayoutChanged(ev.args.merchantId, ev.args.payout);
    record(log, ev.name, null, null, null);
    wh.emit(`evt_${key}`, "merchant.payout_changed", { merchantId: Number(ev.args.merchantId), payout: ev.args.payout });
  } else if (ev.name === "RefunderSet") {
    const mid = Number(ev.args.merchantId);
    if (!merchants.isKnown(mid)) return;
    db.prepare(`INSERT INTO refund_operators(merchant_id,address,per_refund,per_day,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(merchant_id,address) DO UPDATE SET per_refund=excluded.per_refund,per_day=excluded.per_day,updated_at=excluded.updated_at`)
      .run(mid, ev.args.refunder, String(ev.args.perRefund), String(ev.args.perDay), ts);
    record(log, ev.name, null, null, null);
    wh.emit(`evt_${key}`, "merchant.refund_operator_changed", { merchantId: mid, operator: ev.args.refunder, perRefund: String(ev.args.perRefund), perDay: String(ev.args.perDay) });
  } else if (ev.name === "PayoutQueued") {
    // Security signal: a payout change is the #1 thing an attacker with the owner key would try.
    if (!merchants.isKnown(ev.args.merchantId)) return;
    record(log, ev.name, null, null, null);
    wh.emit(`evt_${key}`, "merchant.payout_change_queued", { merchantId: Number(ev.args.merchantId), payout: ev.args.payout, eta: Number(ev.args.eta) });
  }
}

/** Money that hit the payout wallet but not through WhitePay: exchange withdrawals, wrong token, manual sends. */
async function scanExceptions(from, to) {
  const owners = new Map(merchants.payouts().map((p) => [p.payout.toLowerCase(), p.onchain_id]));
  if (!owners.size) return;
  const topics = [...owners.keys()].map((a) => ethers.zeroPadValue(a, 32));
  let logs;
  try { logs = await getLogsChunked({ topics: [TRANSFER, null, topics] }, from, to); } // OR across every merchant's payout wallet
  catch { return; } // some RPCs reject address-less filters; exceptions are best-effort
  for (const l of logs) {
    const mid = owners.get(ethers.getAddress(ethers.dataSlice(l.topics[2], 12)).toLowerCase());
    if (l.address.toLowerCase() === cfg.dep.token.toLowerCase()) {
      const rc = await provider.getTransactionReceipt(l.transactionHash);
      if (rc.logs.some((x) => x.address.toLowerCase() === cfg.dep.pay.toLowerCase())) continue; // came via the contract
    }
    const kind = l.address.toLowerCase() === cfg.dep.token.toLowerCase() ? "unattributed_transfer" : "wrong_token";
    const sender = ethers.getAddress(ethers.dataSlice(l.topics[1], 12));
    db.prepare(`INSERT OR IGNORE INTO exceptions(key,kind,token,sender,amount,tx_hash,block_number,created_at,merchant_id) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(`${l.transactionHash}:${l.index}`, kind, l.address, sender, String(big(l.data)), l.transactionHash, l.blockNumber, now(), mid);
    wh.emit(`evt_exc_${l.transactionHash}_${l.index}`, `exception.${kind}`, { merchantId: mid, token: l.address, sender, amount: String(big(l.data)), tx: l.transactionHash });
  }
}

/** Re-verify every not-yet-final event. If its block was replaced, undo it and re-scan. */
async function checkReorgs(finalizedBlock) {
  const open = db.prepare("SELECT * FROM chain_events WHERE status='active' AND block_number>?").all(finalizedBlock);
  let rescanFrom = null;
  for (const e of open) {
    const rc = await provider.getTransactionReceipt(e.tx_hash).catch(() => undefined);
    if (rc === undefined) continue; // RPC hiccup: decide next tick, never on missing data
    if (rc && rc.blockHash === e.block_hash) continue;
    db.prepare("UPDATE chain_events SET status='reorged' WHERE key=?").run(e.key);
    if (e.ledger_group) reverseGroup(e.ledger_group);
    if (e.name === "PaymentReceived") {
      db.prepare("UPDATE intents SET finality='reorged',fulfillable=0 WHERE id=? AND block_hash=?").run(e.ref, e.block_hash);
      wh.emit(`evt_${e.key}_reorg`, "payment.reorged", publicIntent(e.ref));
      const inv = db.prepare("SELECT invoice_id FROM intents WHERE id=?").get(e.ref)?.invoice_id;
      if (inv) invoices.onPaymentChange(inv, `reorg_${e.key}`);
    }
    if (e.name === "Refunded") recomputeIntent(e.ref);
    // Subscription/plan state is re-read from the canonical chain (the contract is the source of truth).
    if (e.ref?.startsWith("sub:")) await subs.sync(Number(e.ref.split(":")[1])).catch(() => {});
    if (e.ref?.startsWith("plan:")) await subs.syncPlan(Number(e.ref.split(":")[1])).catch(() => {});
    rescanFrom = Math.min(rescanFrom ?? e.block_number, e.block_number);
  }
  if (rescanFrom !== null) kv.set("cursor", rescanFrom - 1); // a replacement tx in the new chain gets picked up
}

/** seen → safe → finalized per intent, and "fulfillable" once the merchant's chosen level is reached. */
async function updateFinality(head, tags) {
  const rows = db.prepare("SELECT * FROM intents WHERE tx_hash IS NOT NULL AND finality IN ('seen','safe')").all();
  for (const r of rows) {
    const confs = head - r.block_number + 1;
    const level = tags
      ? (r.block_number <= tags.finalized ? "finalized" : r.block_number <= tags.safe ? "safe" : "seen")
      : (confs >= cfg.confirmations.finalized ? "finalized" : confs >= cfg.confirmations.safe ? "safe" : "seen");
    if (level !== r.finality) {
      db.prepare("UPDATE intents SET finality=? WHERE id=?").run(level, r.id);
      wh.emit(`evt_${r.tx_hash}_${r.block_hash}_${level}`, `payment.${level}`, publicIntent(r.id));
    }
    if (ORDER.indexOf(level) >= ORDER.indexOf(r.policy) && !r.fulfillable) {
      db.prepare("UPDATE intents SET fulfillable=1 WHERE id=?").run(r.id);
      wh.emit(`evt_${r.tx_hash}_${r.block_hash}_fulfillable`, "payment.fulfillable", publicIntent(r.id));
    }
  }
}

/** Finality heads. OP Stack (Whitechain): safe = batch on L1, finalized = L1 finalized.
 *  Local Hardhat reports those tags as latest, so it uses confirmation counts instead. */
async function finalityHeads(head) {
  if (cfg.finalityMode !== "tags") return { tags: null, finalized: head - cfg.confirmations.finalized };
  const [s, f] = await Promise.all([provider.getBlock("safe"), provider.getBlock("finalized")]);
  kv.set("safeHead", s.number);
  kv.set("finalizedHead", f.number);
  return { tags: { safe: s.number, finalized: f.number }, finalized: f.number };
}

function publicIntent(id) {
  const r = db.prepare("SELECT * FROM intents WHERE id=?").get(id);
  return r && toApi(r);
}

function status(r) {
  if (r.finality === "created") return r.expiry < now() ? "expired" : "created";
  if (r.finality !== "reorged" && big(r.refunded) > 0n) return big(r.refunded) >= big(r.amount) ? "refunded" : "partially_refunded";
  return r.finality;
}

/** Refund history from the event store (active = still on the canonical chain). */
function refundsOf(id) {
  return db.prepare("SELECT tx_hash,amount,reason,operator,counterparty,block_number,status FROM chain_events WHERE ref=? AND name='Refunded' ORDER BY block_number")
    .all(id).map((e) => ({ tx: e.tx_hash, amount: e.amount, reason: e.reason, operator: e.operator, to: e.counterparty, block: e.block_number, status: e.status }));
}

function toApi(r) {
  return {
    id: r.public_id, intentId: r.id, merchantId: r.merchant_id, orderRef: r.order_ref, description: r.description,
    fiatAmount: r.fiat_amount, currency: r.currency, rate: r.rate, amount: r.amount, token: r.token,
    expiry: r.expiry, policy: r.policy, status: status(r), finality: r.finality, fulfillable: !!r.fulfillable,
    payer: r.payer, txHash: r.tx_hash, blockNumber: r.block_number, paidAt: r.paid_at, refunded: r.refunded,
    gasUsed: r.gas_used, gasPrice: r.gas_price, createdAt: r.created_at,
    gasless: !!r.gas_payer && !!r.payer && r.gas_payer.toLowerCase() !== r.payer.toLowerCase(),
    fee: { protocol: "0", gasWei: r.gas_used ? String(big(r.gas_used) * big(r.gas_price)) : null,
      note: r.gas_payer && r.payer && r.gas_payer.toLowerCase() !== r.payer.toLowerCase() ? "gas sponsored by merchant" : "gas paid by payer" },
  };
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const latest = await provider.getBlock("latest");
    const head = latest.number;
    kv.set("headTs", latest.timestamp);
    const fin = await finalityHeads(head);
    await checkReorgs(fin.finalized);
    let cursor = Number(kv.get("cursor", cfg.dep.deployBlock - 1));
    while (cursor < head) {
      const to = Math.min(cursor + CHUNK, head);
      for (const l of await getLogsRange({ address: cfg.dep.pay }, cursor + 1, to)) await handleLog(l);
      await scanExceptions(cursor + 1, to);
      cursor = to;
      kv.set("cursor", cursor);
    }
    await updateFinality(head, fin.tags);
    kv.set("head", head);
    kv.set("lastSync", now());
    kv.set("rpcOk", 1);
  } catch (e) {
    kv.set("rpcOk", 0);
    console.error("[indexer]", e.shortMessage || e.message);
  } finally { running = false; }
}

// ───────── Keeper ─────────
const errIface = new ethers.Interface([...abi.filter((x) => x.type === "error"),
  "error ERC20InsufficientBalance(address,uint256,uint256)", "error ERC20InsufficientAllowance(address,uint256,uint256)"]);
const reasonOf = (e) => {
  try { return errIface.parseError(e.data || e.info?.error?.data)?.name; } catch {}
  return e.reason || e.shortMessage || e.message;
};
function start() {
  tick();
  setInterval(tick, 2000);
  setInterval(() => wh.deliverDue().catch(() => {}), 2000);
  setInterval(() => subs.keeper(reasonOf).catch((e) => console.error("[keeper]", e.shortMessage || e.message)), Number(process.env.KEEPER_INTERVAL_MS || 15000));
}

module.exports = { start, tick, toApi, refundsOf, provider, abi, iface, getLogsChunked, reasonOf };
