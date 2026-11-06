// Finance: statements (Excel / PDF / CSV), accounting-system exports (Xero, QuickBooks), period close,
// and the read-only auditor role. Everything is derived from the append-only ledger, so it always agrees with the chain.
const crypto = require("crypto");
const { db } = require("../db");
const invoices = require("./invoices");
const files = require("./files");
const { now } = require("./clock");

db.exec(`CREATE TABLE IF NOT EXISTS periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT, merchant_id INTEGER, start_ts INTEGER, end_ts INTEGER, label TEXT,
  status TEXT DEFAULT 'closed', snapshot TEXT, hash TEXT, ledger_max_id INTEGER, closed_at INTEGER, closed_by TEXT, reopened_at INTEGER, reopen_reason TEXT
)`);

const bad = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const U = (units) => Number(units) / 1e6; // USDT has 6 decimals
const iso = (ts) => new Date(ts * 1000).toISOString();
const day = (ts) => iso(ts).slice(0, 10);

// Default chart of accounts. Merchants can override names/codes with ?map= JSON, since every accounting file has its own chart.
const CHART = {
  "assets:usdt_wallet": { code: "1010", name: "USDT Wallet" },
  "revenue:sales": { code: "4000", name: "Sales" },
  "revenue:invoices": { code: "4010", name: "Invoice Revenue" },
  "revenue:subscriptions": { code: "4020", name: "Subscription Revenue" },
  "contra:refunds": { code: "4900", name: "Refunds and Returns" },
};
const acct = (a, map) => ({ ...(CHART[a] || { code: "9999", name: a }), ...(map?.[a] || {}) });

function range(q) {
  const from = q.from ? Number(q.from) : 0, to = q.to ? Number(q.to) : now() + 1;
  if (!(from >= 0) || !(to > from)) throw bad("invalid_range", "from/to must be unix timestamps with to > from");
  return { from, to };
}

const lines = (mid, from, to) => db.prepare("SELECT * FROM ledger WHERE merchant_id=? AND ts>=? AND ts<? ORDER BY id").all(mid, from, to);

function totals(mid, from, to) {
  const t = {};
  for (const l of lines(mid, from, to)) {
    t[l.account] ||= { debit: 0n, credit: 0n };
    t[l.account].debit += BigInt(l.debit); t[l.account].credit += BigInt(l.credit);
  }
  return Object.fromEntries(Object.entries(t).sort().map(([a, v]) => [a, { debit: String(v.debit), credit: String(v.credit), net: String(v.debit - v.credit) }]));
}

function statement(mid, merchantName, q) {
  const { from, to } = range(q);
  const tot = totals(mid, from, to), map = q.map ? safeJson(q.map) : undefined;
  const ledger = lines(mid, from, to);
  const invs = invoices.list(mid).filter((i) => i.issueDate >= from && i.issueDate < to && i.status !== "draft");
  const cns = invoices.listCreditNotes(mid).filter((c) => c.createdAt >= from && c.createdAt < to);
  const revenue = ["revenue:sales", "revenue:invoices", "revenue:subscriptions"].reduce((a, k) => a + BigInt(tot[k]?.net || 0) * -1n, 0n);
  const refunds = BigInt(tot["contra:refunds"]?.net || 0);
  return { merchant: merchantName, from, to, generatedAt: now(), currency: "USDT", totals: tot, ledger, invoices: invs, creditNotes: cns, aging: invoices.aging(mid), map,
    summary: { revenue: String(revenue), refunds: String(refunds), netRevenue: String(revenue - refunds) } };
}
function safeJson(s) { try { const v = JSON.parse(s); return v && typeof v === "object" ? v : undefined; } catch { return undefined; } }

function statementRows(st) {
  const money = (x) => U(x);
  const sum = [["Statement", st.merchant], ["Period", `${day(st.from)} to ${day(st.to - 1)}`], ["Currency", st.currency], ["Generated", iso(st.generatedAt)], [],
    ["Account", "Code", "Debit", "Credit", "Net (debit - credit)"],
    ...Object.entries(st.totals).map(([a, v]) => [acct(a, st.map).name, acct(a, st.map).code, money(v.debit), money(v.credit), money(v.net)]), [],
    ["Revenue", money(st.summary.revenue)], ["Refunds", money(st.summary.refunds)], ["Net revenue", money(st.summary.netRevenue)]];
  const led = [["ID", "Date", "Entry group", "Account", "Debit", "Credit", "Memo", "Tx hash", "Log index", "Block"],
    ...st.ledger.map((l) => [l.id, iso(l.ts), l.entry_group, acct(l.account, st.map).name, money(l.debit), money(l.credit), l.memo || "", l.tx_hash || "", l.log_index ?? "", l.block_number ?? ""])];
  const inv = [["Number", "Status", "Client", "Currency", "Issued", "Due", "Total", "Credits", "Paid", "Balance"],
    ...st.invoices.map((i) => [i.number, i.status, i.client.name, i.currency, day(i.issueDate), day(i.dueDate), i.total / 100, i.credits / 100, i.paid / 100, i.balance / 100])];
  const cn = [["Number", "Invoice", "Date", "Amount", "Currency", "Reason", "Note"],
    ...st.creditNotes.map((c) => [c.number, c.invoiceId, day(c.createdAt), c.amount / 100, c.currency, c.reason, c.note || ""])];
  const age = [["Currency", "Current", "1-30", "31-60", "61-90", "90+", "Total"],
    ...Object.entries(st.aging).map(([c, a]) => [c, a.current / 100, a["1_30"] / 100, a["31_60"] / 100, a["61_90"] / 100, a.over_90 / 100, a.total / 100])];
  return { sum, led, inv, cn, age };
}

function toXlsx(st) {
  const r = statementRows(st);
  return files.xlsx([{ name: "Summary", rows: r.sum }, { name: "Ledger", rows: r.led }, { name: "Invoices", rows: r.inv }, { name: "Credit notes", rows: r.cn }, { name: "AR aging", rows: r.age }]);
}

function toPdf(st) {
  const pad = (s, n, right) => (right ? String(s).padStart(n) : String(s).padEnd(n)).slice(0, n);
  const fx = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const blocks = [{ text: `${st.merchant}   ${day(st.from)} to ${day(st.to - 1)}   (${st.currency})` }, { text: "Summary", bold: true },
    { text: pad("Account", 32) + pad("Debit", 18, 1) + pad("Credit", 18, 1) + pad("Net", 18, 1) + "\n" +
      Object.entries(st.totals).map(([a, v]) => pad(acct(a, st.map).name, 32) + pad(fx(U(v.debit)), 18, 1) + pad(fx(U(v.credit)), 18, 1) + pad(fx(U(v.net)), 18, 1)).join("\n") },
    { text: `Revenue ${fx(U(st.summary.revenue))}   Refunds ${fx(U(st.summary.refunds))}   Net revenue ${fx(U(st.summary.netRevenue))}` },
    { text: "Invoices issued", bold: true },
    { text: st.invoices.length ? pad("Number", 12) + pad("Client", 28) + pad("Status", 16) + pad("Total", 14, 1) + pad("Balance", 14, 1) + "\n" +
      st.invoices.map((i) => pad(i.number, 12) + pad(i.client.name, 28) + pad(i.status, 16) + pad(fx(i.total / 100) + " " + i.currency, 14, 1) + pad(fx(i.balance / 100), 14, 1)).join("\n") : "None" },
    { text: "Credit notes", bold: true },
    { text: st.creditNotes.length ? st.creditNotes.map((c) => pad(c.number, 10) + pad(day(c.createdAt), 12) + pad(c.reason, 22) + pad(fx(c.amount / 100) + " " + c.currency, 16, 1)).join("\n") : "None" },
    { text: "Ledger (" + st.ledger.length + " lines)", bold: true },
    { text: st.ledger.length ? pad("Date", 11) + pad("Account", 22) + pad("Debit", 14, 1) + pad("Credit", 14, 1) + "  Tx\n" +
      st.ledger.slice(0, 400).map((l) => pad(day(l.ts), 11) + pad(acct(l.account, st.map).name, 22) + pad(fx(U(l.debit)), 14, 1) + pad(fx(U(l.credit)), 14, 1) + "  " + String(l.tx_hash || "").slice(0, 14)).join("\n") +
      (st.ledger.length > 400 ? `\n... ${st.ledger.length - 400} more lines in the Excel or CSV export` : "") : "None" }];
  return files.pdf(`${st.merchant} - Statement`, blocks);
}

const csvEsc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const csv = (rows) => rows.map((r) => r.map(csvEsc).join(",")).join("\r\n") + "\r\n";

/** Xero "Manual Journals" import: one journal per ledger entry group; positive = debit, negative = credit. */
function toXero(st) {
  const groups = new Map();
  for (const l of st.ledger) { if (!groups.has(l.entry_group)) groups.set(l.entry_group, []); groups.get(l.entry_group).push(l); }
  const rows = [["*Narration", "*Date", "Description", "*AccountCode", "*TaxRate", "*Amount"]];
  for (const [g, ls] of groups) for (const l of ls) {
    const net = U(l.debit) - U(l.credit), a = acct(l.account, st.map);
    rows.push([`WhitePay ${g}`.slice(0, 100), day(l.ts), (l.memo || a.name).slice(0, 200), a.code, "Tax Exempt", Number(net.toFixed(6))]);
  }
  return csv(rows);
}

/** QuickBooks Online journal-entry CSV: one JournalNo per entry group. */
function toQuickBooks(st) {
  const rows = [["JournalNo", "JournalDate", "Currency", "Memo", "Account", "Debits", "Credits", "Description"]];
  for (const l of st.ledger) {
    const a = acct(l.account, st.map);
    rows.push([l.entry_group.slice(0, 20), day(l.ts), st.currency, (l.memo || "").slice(0, 400), a.name, U(l.debit) || "", U(l.credit) || "", `${l.tx_hash || ""}`.slice(0, 66)]);
  }
  return csv(rows);
}

function toCsv(st) { const r = statementRows(st); return csv([...r.sum, [], ["LEDGER"], ...r.led]); }

// ───────── Period close ─────────
function snapshotOf(mid, from, to) {
  const snap = { totals: totals(mid, from, to), lines: lines(mid, from, to).length };
  return { snap, hash: crypto.createHash("sha256").update(JSON.stringify(snap)).digest("hex") };
}

function closePeriod(mid, body, by) {
  const from = Number(body?.from), to = Number(body?.to);
  if (!(from >= 0) || !(to > from)) throw bad("invalid_range", "from and to (unix seconds) are required, with to > from");
  if (to > now()) throw bad("period_not_ended", "A period can only be closed after it has ended", 409);
  const overlap = db.prepare("SELECT 1 FROM periods WHERE merchant_id=? AND status='closed' AND start_ts<? AND end_ts>?").get(mid, to, from);
  if (overlap) throw bad("period_overlap", "This range overlaps an already closed period", 409);
  const { snap, hash } = snapshotOf(mid, from, to);
  const max = db.prepare("SELECT COALESCE(MAX(id),0) m FROM ledger WHERE merchant_id=? AND ts<?").get(mid, to).m;
  const r = db.prepare("INSERT INTO periods(merchant_id,start_ts,end_ts,label,snapshot,hash,ledger_max_id,closed_at,closed_by) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(mid, from, to, body?.label ? String(body.label).slice(0, 80) : `${day(from)} to ${day(to - 1)}`, JSON.stringify(snap), hash, max, now(), by);
  return periodApi(db.prepare("SELECT * FROM periods WHERE id=?").get(Number(r.lastInsertRowid)));
}

/** A closed period is checked against its snapshot: `drift` means ledger lines landed inside it afterwards (e.g. a late reorg reversal). */
function periodApi(p) {
  const cur = p.status === "closed" ? snapshotOf(p.merchant_id, p.start_ts, p.end_ts) : null;
  return { id: p.id, label: p.label, from: p.start_ts, to: p.end_ts, status: p.status, closedAt: p.closed_at, closedBy: p.closed_by, hash: p.hash,
    snapshot: JSON.parse(p.snapshot), drift: cur ? cur.hash !== p.hash : false, currentTotals: cur?.snap.totals, reopenedAt: p.reopened_at, reopenReason: p.reopen_reason };
}
const listPeriods = (mid) => db.prepare("SELECT * FROM periods WHERE merchant_id=? ORDER BY start_ts DESC").all(mid).map(periodApi);

function reopenPeriod(mid, id, reason) {
  const p = db.prepare("SELECT * FROM periods WHERE id=? AND merchant_id=?").get(Number(id), mid);
  if (!p) throw bad("not_found", "Unknown period", 404);
  if (p.status !== "closed") throw bad("not_closed", "Period is not closed", 409);
  if (!reason) throw bad("reason_required", "A reason is required to reopen a closed period");
  db.prepare("UPDATE periods SET status='reopened',reopened_at=?,reopen_reason=? WHERE id=?").run(now(), String(reason).slice(0, 300), p.id);
  return periodApi(db.prepare("SELECT * FROM periods WHERE id=?").get(p.id));
}

/** Throws if `ts` falls in a closed period: back-dated documents can't change numbers that were already reported. */
function assertOpen(mid, ts) {
  const p = db.prepare("SELECT label FROM periods WHERE merchant_id=? AND status='closed' AND start_ts<=? AND end_ts>?").get(mid, ts, ts);
  if (p) throw bad("period_closed", `The period "${p.label}" is closed; date this document after it`, 409);
}

module.exports = { statement, toXlsx, toPdf, toCsv, toXero, toQuickBooks, closePeriod, listPeriods, reopenPeriod, assertOpen, CHART };
