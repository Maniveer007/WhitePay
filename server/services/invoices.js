// Invoices: fiat-denominated B2B billing built on top of payment intents.
// Every payment toward an invoice is an ordinary exact, expiring onchain quote, so the contract
// is unchanged. Invoice status is DERIVED from its paid intents (never stored), which means
// reorgs and refunds automatically flow through to invoice balances.
const crypto = require("crypto");
const { db } = require("../db");
const wh = require("./webhooks");
const merchants = require("./merchants");

const DAY = 86400;
const { now } = require("./clock");
const TERMS = { due_on_receipt: 0, net_15: 15, net_30: 30, net_60: 60 };
const PAID_STATES = ["seen", "safe", "finalized"];

db.exec(`
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, number TEXT, status TEXT DEFAULT 'open',   -- draft | open | void (paid/overdue are derived)
  currency TEXT, client_name TEXT, client_email TEXT, client_tax_id TEXT, po_ref TEXT, notes TEXT,
  items TEXT,                                                            -- JSON [{description, qty, unitPrice(minor), taxBps}]
  issue_date INTEGER, due_date INTEGER, terms TEXT,
  allow_partial INTEGER DEFAULT 0, min_partial INTEGER DEFAULT 0,
  late_fee_bps INTEGER DEFAULT 0, early_discount_bps INTEGER DEFAULT 0, early_discount_until INTEGER,
  subtotal INTEGER, tax INTEGER, total INTEGER, created_at INTEGER, voided_at INTEGER
);`);
db.exec(`
CREATE TABLE IF NOT EXISTS credit_notes (
  id TEXT PRIMARY KEY, number TEXT, invoice_id TEXT, merchant_id INTEGER, amount INTEGER, currency TEXT,
  reason TEXT, note TEXT, created_at INTEGER, voided_at INTEGER
);`);
for (const col of ["invoice_id TEXT", "invoice_discount INTEGER DEFAULT 0"]) { try { db.exec(`ALTER TABLE intents ADD COLUMN ${col}`); } catch {} }
for (const col of ["language TEXT DEFAULT 'en'", "client_phone TEXT", "merchant_id INTEGER", "source TEXT"]) { try { db.exec(`ALTER TABLE invoices ADD COLUMN ${col}`); } catch {} }
const LANGS = ["en", "hi", "ta", "te", "mr", "bn", "ar"]; // invoice page + emails are localized in these

const bad = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const minor = (x) => Math.round(Number(x) * 100); // all supported currencies use 2 decimal places

/** Validate input and compute totals in integer minor units (no float money). */
function validate(body, currencies) {
  const b = body || {};
  if (!currencies[b.currency || "USD"]) throw bad("unsupported_currency", `Unsupported currency ${b.currency}`);
  if (!b.clientName) throw bad("invalid_client", "clientName is required");
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 100) throw bad("invalid_items", "items must have 1–100 lines");
  const items = b.items.map((it, n) => {
    const qty = Number(it.qty ?? 1), unitPrice = minor(it.unitPrice), taxBps = Math.round(Number(it.taxPercent || 0) * 100);
    if (!it.description || !(qty > 0) || !(unitPrice >= 0) || taxBps < 0 || taxBps > 10000) throw bad("invalid_items", `Line ${n + 1} is invalid`);
    const net = Math.round(qty * unitPrice);
    return { description: String(it.description).slice(0, 200), qty, unitPrice, taxBps, net, tax: Math.round((net * taxBps) / 10000) };
  });
  const subtotal = items.reduce((a, i) => a + i.net, 0), tax = items.reduce((a, i) => a + i.tax, 0), total = subtotal + tax;
  if (total <= 0) throw bad("invalid_items", "Invoice total must be greater than 0");
  const terms = b.terms || "net_30";
  if (!(terms in TERMS) && !b.dueDate) throw bad("invalid_terms", "terms must be due_on_receipt | net_15 | net_30 | net_60, or pass dueDate");
  const issue = b.issueDate ? Number(b.issueDate) : now();
  const due = b.dueDate ? Number(b.dueDate) : issue + TERMS[terms] * DAY;
  const pct = (x, max) => { const v = Math.round(Number(x || 0) * 100); if (v < 0 || v > max) throw bad("invalid_terms", "percentage out of range"); return v; };
  if (b.language && !LANGS.includes(b.language)) throw bad("invalid_language", "language must be one of " + LANGS.join(", "));
  if (b.clientPhone && !/^\+?[0-9]{8,15}$/.test(String(b.clientPhone))) throw bad("invalid_phone", "clientPhone must be in international format, e.g. +919812345678");
  return { b, items, subtotal, tax, total, terms, issue, due, pct };
}

/** Create an invoice. `opts.source` makes creation idempotent (used by recurring schedules). */
function create(body, currencies, mid, opts = {}) {
  const { b, items, subtotal, tax, total, terms, issue, due, pct } = validate(body, currencies);
  if (opts.source) { const dup = db.prepare("SELECT id FROM invoices WHERE source=?").get(opts.source); if (dup) return state(dup.id); }
  const seq = db.prepare("SELECT COUNT(*) n FROM invoices WHERE merchant_id=?").get(mid).n + 1; // numbering is per merchant
  const id = "inv_" + crypto.randomBytes(8).toString("hex");
  const insert = (number) => db.prepare(`INSERT INTO invoices(id,number,status,currency,client_name,client_email,client_tax_id,po_ref,notes,items,issue_date,due_date,terms,
    allow_partial,min_partial,late_fee_bps,early_discount_bps,early_discount_until,subtotal,tax,total,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, number, b.draft ? "draft" : "open", b.currency || "USD",
    String(b.clientName).slice(0, 200), b.clientEmail || null, b.clientTaxId || null, b.poRef || null, b.notes ? String(b.notes).slice(0, 1000) : null,
    JSON.stringify(items), issue, due, terms, b.allowPartial ? 1 : 0, minor(b.minPartial || 0),
    pct(b.lateFeePercent, 5000), pct(b.earlyDiscountPercent, 5000),
    b.earlyDiscountDays ? issue + Number(b.earlyDiscountDays) * DAY : null, subtotal, tax, total, now());
  const number = b.number || `INV-${String(seq).padStart(4, "0")}`;
  // Databases created before multi-merchant kept invoice numbers globally unique: suffix the merchant on a clash.
  try { insert(number); } catch (e) { if (!/UNIQUE/.test(e.message)) throw e; insert(`${number}-M${mid}`); }
  db.prepare("UPDATE invoices SET language=?,client_phone=?,merchant_id=?,source=? WHERE id=?").run(b.language || "en", b.clientPhone ? String(b.clientPhone).replace(/^\+/, "") : null, mid, opts.source || null, id);
  const inv = state(id);
  if (inv.status !== "draft") wh.emit(`evt_inv_${id}_created`, "invoice.created", inv);
  return inv;
}

/** Which payments to refund, and how much of each, to give back `refundDue` (minor units). Newest payment first.
 *  The server can't move funds (the merchant's own wallet funds a refund), so this is the exact list to execute. */
function refundPlan(payments, refundDue) {
  const plan = []; let left = refundDue;
  for (const p of [...payments].reverse()) {
    if (left <= 0) break;
    const room = BigInt(p.usdt) - BigInt(p.refunded || 0);
    if (room <= 0n || !p.original) continue;
    const roomFiat = Math.floor(Number((room * BigInt(p.original) * 1000n) / BigInt(p.usdt)) / 1000);
    const fiat = Math.min(left, roomFiat);
    if (fiat <= 0) continue;
    const usdt = fiat === roomFiat ? room : (BigInt(p.usdt) * BigInt(fiat)) / BigInt(p.original);
    plan.push({ paymentId: p.paymentId, intentId: p.intentId, fiat, usdt: String(usdt > room ? room : usdt) });
    left -= fiat;
  }
  return plan;
}

/** Everything about an invoice that depends on payments is computed here, from intents. */
function state(id) {
  const inv = db.prepare("SELECT * FROM invoices WHERE id=?").get(id);
  if (!inv) return null;
  const pays = db.prepare("SELECT * FROM intents WHERE invoice_id=? ORDER BY created_at").all(inv.id);
  let paid = 0, discounts = 0, paidByDue = 0;
  const payments = [];
  for (const p of pays) {
    if (!PAID_STATES.includes(p.finality)) continue;
    // A refunded payment no longer counts toward the invoice (pro-rata for partial refunds).
    const share = 1 - Number(BigInt(p.refunded || 0) * 10000n / BigInt(p.amount)) / 10000;
    const fiat = Math.round(minor(p.fiat_amount) * share);
    paid += fiat;
    if (p.paid_at && p.paid_at <= inv.due_date) paidByDue += fiat;
    if (share === 1) discounts += p.invoice_discount || 0;
    payments.push({ paymentId: p.public_id, intentId: p.id, amount: fiat, original: minor(p.fiat_amount), usdt: p.amount, refunded: p.refunded, finality: p.finality, payer: p.payer, paidAt: p.paid_at, txHash: p.tx_hash });
  }
  const t = now();
  const overdue = t > inv.due_date;
  // Late fee: one-time, only if the invoice wasn't covered by the due date.
  const lateFee = overdue && inv.late_fee_bps && paidByDue + discounts < inv.total ? Math.round((inv.total * inv.late_fee_bps) / 10000) : 0;
  const notes = db.prepare("SELECT id,number,amount,reason,note,created_at FROM credit_notes WHERE invoice_id=? AND voided_at IS NULL ORDER BY created_at").all(inv.id);
  const credits = notes.reduce((a, n) => a + n.amount, 0);
  const owed = Math.max(0, inv.total + lateFee - discounts - credits);
  const balance = Math.max(0, owed - paid);
  const refundDue = Math.max(0, paid - owed); // a credit note issued after payment: the client is owed money back
  // Early-payment discount: only for a single full payment, before the cutoff, with nothing paid yet.
  const discountAvailable = inv.early_discount_bps && inv.early_discount_until && t <= inv.early_discount_until && paid === 0
    ? Math.round((inv.total * inv.early_discount_bps) / 10000) : 0;
  let status = inv.status;
  if (status === "open") status = balance === 0 ? (paid === 0 && credits > 0 && owed === 0 ? "credited" : "paid") : paid > 0 ? (overdue ? "overdue" : "partially_paid") : overdue ? "overdue" : "open";
  return {
    id: inv.id, merchantId: inv.merchant_id, merchant: merchants.branding(merchants.byOnchainId(inv.merchant_id)),
    number: inv.number, status, currency: inv.currency,
    client: { name: inv.client_name, email: inv.client_email, taxId: inv.client_tax_id, phone: inv.client_phone }, language: inv.language || "en", poRef: inv.po_ref, notes: inv.notes,
    items: JSON.parse(inv.items), issueDate: inv.issue_date, dueDate: inv.due_date, terms: inv.terms,
    allowPartial: !!inv.allow_partial, minPartial: inv.min_partial,
    lateFeePercent: inv.late_fee_bps / 100, earlyDiscountPercent: inv.early_discount_bps / 100, earlyDiscountUntil: inv.early_discount_until,
    subtotal: inv.subtotal, tax: inv.tax, total: inv.total, lateFee, discountsApplied: discounts,
    credits, creditNotes: notes.map((n) => ({ id: n.id, number: n.number, amount: n.amount, reason: n.reason, note: n.note, createdAt: n.created_at })), refundDue, refundPlan: refundDue > 0 ? refundPlan(payments, refundDue) : [],
    paid, balance, payNowFull: Math.max(0, balance - discountAvailable), discountAvailable,
    payments, createdAt: inv.created_at, voidedAt: inv.voided_at,
  };
}

/** Amount (minor units) and discount for a payment the client wants to make now. */
function quotePayment(inv, body) {
  if (["void", "draft"].includes(inv.status)) throw bad("not_payable", `Invoice is ${inv.status}`, 409);
  if (inv.balance === 0) throw bad("already_paid", "Invoice is fully paid", 409);
  if (!body?.amount || body.full) return { amount: inv.payNowFull, discount: inv.discountAvailable };
  if (!inv.allowPartial) throw bad("partial_not_allowed", "This invoice must be paid in full");
  const amount = minor(body.amount);
  const floor = Math.min(inv.minPartial || 1, inv.balance);
  if (amount < floor || amount > inv.balance) throw bad("invalid_amount", `Amount must be between ${floor / 100} and ${inv.balance / 100} ${inv.currency}`);
  return { amount, discount: 0 };
}

function list(mid) {
  return db.prepare("SELECT id FROM invoices WHERE merchant_id=? ORDER BY created_at DESC LIMIT 500").all(mid).map((r) => state(r.id));
}

/** Accounts-receivable aging by days past due (amounts in minor units, per currency). */
function aging(mid) {
  const out = {};
  for (const inv of list(mid)) {
    if (!["open", "partially_paid", "overdue"].includes(inv.status)) continue;
    const days = Math.floor((now() - inv.dueDate) / DAY);
    const bucket = days <= 0 ? "current" : days <= 30 ? "1_30" : days <= 60 ? "31_60" : days <= 90 ? "61_90" : "over_90";
    out[inv.currency] ||= { current: 0, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0, total: 0 };
    out[inv.currency][bucket] += inv.balance;
    out[inv.currency].total += inv.balance;
  }
  return out;
}

const CREDIT_REASONS = ["adjustment", "returned_goods", "pricing_error", "goodwill", "cancelled_service", "other"];

/** Credit note: reduces what the client owes without rewriting the original invoice. amount is in major units. */
function createCreditNote(invoiceId, body, mid) {
  const inv = state(invoiceId);
  if (!inv || inv.merchantId !== mid) throw bad("not_found", "Unknown invoice", 404);
  if (["void", "draft"].includes(inv.status)) throw bad("not_creditable", `Invoice is ${inv.status}`, 409);
  const reason = body?.reason || "adjustment";
  if (!CREDIT_REASONS.includes(reason)) throw bad("invalid_reason", "reason must be one of " + CREDIT_REASONS.join(", "));
  const amount = minor(body?.amount);
  const room = inv.total + inv.lateFee - inv.discountsApplied - inv.credits; // can't credit more than the invoice is worth
  if (!(amount > 0) || amount > room) throw bad("invalid_amount", `Amount must be between 0.01 and ${room / 100} ${inv.currency}`);
  const id = "cn_" + crypto.randomBytes(8).toString("hex");
  const seq = db.prepare("SELECT COUNT(*) n FROM credit_notes WHERE merchant_id=?").get(mid).n + 1;
  db.prepare("INSERT INTO credit_notes(id,number,invoice_id,merchant_id,amount,currency,reason,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(id, `CN-${String(seq).padStart(4, "0")}`, inv.id, mid, amount, inv.currency, reason, body?.note ? String(body.note).slice(0, 500) : null, now());
  const after = state(inv.id);
  const cn = db.prepare("SELECT * FROM credit_notes WHERE id=?").get(id);
  wh.emit(`evt_cn_${id}`, "credit_note.created", { merchantId: mid, id, number: cn.number, invoiceId: inv.id, amount, currency: inv.currency, reason, refundDue: after.refundDue, refundPlan: after.refundPlan });
  if (after.status === "paid" || after.status === "credited") wh.emit(`evt_inv_${inv.id}_paid`, "invoice.paid", after);
  return { id, number: cn.number, invoiceId: inv.id, amount, currency: inv.currency, reason, note: cn.note, createdAt: cn.created_at, invoice: after };
}

function listCreditNotes(mid) {
  return db.prepare("SELECT * FROM credit_notes WHERE merchant_id=? AND voided_at IS NULL ORDER BY created_at DESC LIMIT 500").all(mid)
    .map((n) => ({ id: n.id, number: n.number, invoiceId: n.invoice_id, amount: n.amount, currency: n.currency, reason: n.reason, note: n.note, createdAt: n.created_at }));
}

function voidInvoice(id) {
  const inv = state(id);
  if (!inv) throw bad("not_found", "Unknown invoice", 404);
  if (inv.paid > 0) throw bad("has_payments", "Refund the payments first; an invoice with payments can't be voided", 409);
  db.prepare("UPDATE invoices SET status='void',voided_at=? WHERE id=?").run(now(), inv.id);
  wh.emit(`evt_inv_${inv.id}_void`, "invoice.voided", state(inv.id));
  return state(inv.id);
}

/** Called by the indexer after any payment change on an invoice-linked intent. */
function onPaymentChange(invoiceId, key) {
  const inv = state(invoiceId);
  if (!inv) return;
  wh.emit(`evt_inv_${invoiceId}_${key}`, "invoice.payment_updated", inv);
  if (inv.status === "paid") wh.emit(`evt_inv_${invoiceId}_paid`, "invoice.paid", inv);
}

/** Collections: deterministic event ids make each reminder fire exactly once per invoice. */
function remindDue() {
  for (const inv of db.prepare("SELECT id FROM invoices WHERE status='open'").all().map((r) => state(r.id))) {
    if (!["open", "partially_paid", "overdue"].includes(inv.status)) continue;
    const d = inv.dueDate, t = now();
    if (t >= d - 3 * DAY && t < d) wh.emit(`evt_inv_${inv.id}_due_soon`, "invoice.reminder", { ...inv, reminder: "due_soon" });
    if (t >= d) wh.emit(`evt_inv_${inv.id}_overdue`, "invoice.reminder", { ...inv, reminder: "overdue" });
    if (t >= d + 7 * DAY) wh.emit(`evt_inv_${inv.id}_overdue_7`, "invoice.reminder", { ...inv, reminder: "overdue_7_days" });
    if (t >= d + 30 * DAY) wh.emit(`evt_inv_${inv.id}_overdue_30`, "invoice.reminder", { ...inv, reminder: "overdue_30_days" });
  }
}

module.exports = { create, validate, state, list, aging, quotePayment, voidInvoice, createCreditNote, listCreditNotes, CREDIT_REASONS, onPaymentChange, remindDue, TERMS };
