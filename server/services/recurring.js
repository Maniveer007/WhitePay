// Recurring invoices: a template plus a schedule. Each run creates an ordinary invoice, so everything downstream
// (payments, reminders, credit notes, reports) works unchanged. Runs are idempotent per (schedule, run number).
const crypto = require("crypto");
const { db } = require("../db");
const invoices = require("./invoices");
const wh = require("./webhooks");
const { now } = require("./clock");

db.exec(`CREATE TABLE IF NOT EXISTS recurring_invoices (
  id TEXT PRIMARY KEY, merchant_id INTEGER, template TEXT, frequency TEXT, every INTEGER DEFAULT 1,
  next_run INTEGER, end_ts INTEGER, max_runs INTEGER, runs INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active', created_at INTEGER, last_invoice_id TEXT
)`);

const FREQ = ["weekly", "monthly", "quarterly", "yearly"];
const bad = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

/** Calendar-aware step: Jan 31 + 1 month = Feb 28/29, and the day of month is restored when it exists (31st stays the 31st). */
function addInterval(ts, frequency, every, anchorDay) {
  const d = new Date(ts * 1000);
  if (frequency === "weekly") return ts + 7 * every * 86400;
  const months = (frequency === "monthly" ? 1 : frequency === "quarterly" ? 3 : 12) * every;
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Math.floor(Date.UTC(y, m, Math.min(anchorDay ?? d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000);
}

function toApi(r) {
  return { id: r.id, merchantId: r.merchant_id, status: r.status, frequency: r.frequency, every: r.every, nextRun: r.next_run, endDate: r.end_ts,
    maxRuns: r.max_runs, runs: r.runs, template: JSON.parse(r.template), lastInvoiceId: r.last_invoice_id, createdAt: r.created_at };
}

function create(body, currencies, mid) {
  const b = body || {};
  if (!FREQ.includes(b.frequency)) throw bad("invalid_frequency", "frequency must be one of " + FREQ.join(", "));
  const every = Math.floor(Number(b.every ?? 1));
  if (!(every >= 1 && every <= 52)) throw bad("invalid_interval", "every must be between 1 and 52");
  const t = b.template || {};
  // Dry-run the template through the real validator so a bad schedule is rejected now, not at 3am on the first run.
  invoices.validate({ ...t, draft: true }, currencies);
  const start = b.startDate ? Number(b.startDate) : now();
  if (!(start > 0)) throw bad("invalid_start", "startDate must be a unix timestamp");
  const id = "rec_" + crypto.randomBytes(8).toString("hex");
  db.prepare("INSERT INTO recurring_invoices(id,merchant_id,template,frequency,every,next_run,end_ts,max_runs,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(id, mid, JSON.stringify(t), b.frequency, every, start, b.endDate ? Number(b.endDate) : null, b.maxRuns ? Math.floor(Number(b.maxRuns)) : null, now());
  run(currencies); // a schedule that starts now issues its first invoice immediately
  return get(id, mid);
}

const get = (id, mid) => { const r = db.prepare("SELECT * FROM recurring_invoices WHERE id=? AND merchant_id=?").get(id, mid); return r ? toApi(r) : null; };
const list = (mid) => db.prepare("SELECT * FROM recurring_invoices WHERE merchant_id=? ORDER BY created_at DESC LIMIT 200").all(mid).map(toApi);

function setStatus(id, mid, status) {
  const r = db.prepare("SELECT * FROM recurring_invoices WHERE id=? AND merchant_id=?").get(id, mid);
  if (!r) throw bad("not_found", "Unknown recurring invoice", 404);
  if (r.status === "ended" || r.status === "cancelled") throw bad("not_changeable", `Schedule is ${r.status}`, 409);
  // Resuming never back-bills the paused weeks: skip forward to the next future date.
  let next = r.next_run;
  if (status === "active") { const anchor = new Date(next * 1000).getUTCDate(); while (next < now()) next = addInterval(next, r.frequency, r.every, anchor); }
  db.prepare("UPDATE recurring_invoices SET status=?,next_run=? WHERE id=?").run(status, next, id);
  return get(id, mid);
}

/** Issue every invoice that is due. Called on a timer; safe to call repeatedly. Catches up at most 24 runs per schedule per call. */
function run(currencies) {
  const due = db.prepare("SELECT * FROM recurring_invoices WHERE status='active' AND next_run<=?").all(now());
  for (const r of due) {
    let { next_run: next, runs } = r;
    const anchor = new Date(r.next_run * 1000).getUTCDate();
    for (let n = 0; n < 24 && next <= now(); n++) {
      if ((r.max_runs && runs >= r.max_runs) || (r.end_ts && next > r.end_ts)) { db.prepare("UPDATE recurring_invoices SET status='ended' WHERE id=?").run(r.id); break; }
      const key = `${r.id}:${runs + 1}`;
      try {
        const t = JSON.parse(r.template);
        const inv = invoices.create({ ...t, issueDate: next, dueDate: undefined, number: undefined }, currencies, r.merchant_id, { source: key });
        runs += 1;
        next = addInterval(next, r.frequency, r.every, anchor);
        db.prepare("UPDATE recurring_invoices SET runs=?,next_run=?,last_invoice_id=? WHERE id=?").run(runs, next, inv.id, r.id);
        wh.emit(`evt_rec_${key}`, "recurring_invoice.generated", { merchantId: r.merchant_id, scheduleId: r.id, run: runs, invoiceId: inv.id, number: inv.number });
      } catch (e) {
        // A failing template (e.g. a currency removed since) pauses the schedule and tells the merchant instead of retrying forever.
        db.prepare("UPDATE recurring_invoices SET status='paused' WHERE id=?").run(r.id);
        wh.emit(`evt_rec_${key}_failed`, "recurring_invoice.failed", { merchantId: r.merchant_id, scheduleId: r.id, run: runs + 1, error: e.message });
        break;
      }
    }
    const after = db.prepare("SELECT * FROM recurring_invoices WHERE id=?").get(r.id);
    if (after.status === "active" && ((after.max_runs && after.runs >= after.max_runs) || (after.end_ts && after.next_run > after.end_ts)))
      db.prepare("UPDATE recurring_invoices SET status='ended' WHERE id=?").run(r.id);
  }
}

module.exports = { create, list, get, setStatus, run, addInterval, FREQ };
