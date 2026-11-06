// Notifications: turns events into messages and delivers them through an outbox (retries, never duplicates).
//
// Merchant alerts → Slack / Telegram / WhatsApp / email (whichever are configured).
// Customer messages (invoices: sent, reminders, paid) → email and WhatsApp, in the invoice's language.
// With no provider configured, messages are stored as "logged" so you can see exactly what would be sent.
const { db } = require("../db");
const cfg = require("../config");
const wh = require("./webhooks");
const merchants = require("./merchants");

const now = () => Math.floor(Date.now() / 1000);
const E = process.env;
const BACKOFF = [10, 60, 300, 1800, 7200];
const PUBLIC_URL = (E.PUBLIC_URL || `http://localhost:${cfg.port}`).replace(/\/$/, "");

db.exec(`CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, merchant_id INTEGER, channel TEXT, recipient TEXT, subject TEXT, body TEXT,
  status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, next_attempt INTEGER, last_error TEXT, created_at INTEGER,
  UNIQUE(event_id, channel, recipient))`);
try { db.exec("ALTER TABLE notifications ADD COLUMN merchant_id INTEGER"); } catch {}

// Email wording in each language (server/i18n/mail.json).
const DICT = require("../i18n/mail.json");
const LOCALE = { en: "en-IN", hi: "hi-IN", ta: "ta-IN", te: "te-IN", mr: "mr-IN", bn: "bn-IN", ar: "ar" };
const t = (lang, key, vars = {}) => (DICT[lang]?.[key] ?? DICT.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
const money = (minor, ccy, lang) => {
  const loc = (LOCALE[lang] || "en-IN") + "-u-nu-latn";
  try { return (minor / 100).toLocaleString(loc, { style: "currency", currency: ccy }); }
  catch { return (minor / 100).toLocaleString(loc, { minimumFractionDigits: 2 }) + " " + ccy; }
};
const date = (ts, lang) => new Date(ts * 1000).toLocaleDateString(LOCALE[lang] || "en-IN", { year: "numeric", month: "short", day: "numeric" });
const usdt = (u) => (Number(u) / 1e6).toFixed(2) + " USDT";

// ── Providers (HTTP APIs; base URLs are overridable so tests can point them at a local mock) ──
const providers = {
  // Slack: the recipient is the merchant's own incoming-webhook URL (the default merchant uses SLACK_WEBHOOK_URL).
  slack: { ok: () => true,
    req: (m) => [m.recipient || E.SLACK_WEBHOOK_URL, { text: `*${m.subject}*\n${m.body}` }] },
  telegram: { ok: () => !!(E.TELEGRAM_BOT_TOKEN && E.TELEGRAM_CHAT_ID),
    req: (m) => [`${E.TELEGRAM_API_BASE || "https://api.telegram.org"}/bot${E.TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: m.recipient || E.TELEGRAM_CHAT_ID, text: `${m.subject}\n\n${m.body}` }] },
  // WhatsApp Cloud API. Business-initiated messages outside a 24h customer window need an approved template;
  // set WHATSAPP_TEMPLATE to use one (body text is sent as its single parameter), otherwise a text message is sent.
  whatsapp: { ok: () => !!(E.WHATSAPP_TOKEN && E.WHATSAPP_PHONE_ID),
    headers: () => ({ authorization: `Bearer ${E.WHATSAPP_TOKEN}` }),
    req: (m) => [`${E.WHATSAPP_API_BASE || "https://graph.facebook.com/v21.0"}/${E.WHATSAPP_PHONE_ID}/messages`,
      E.WHATSAPP_TEMPLATE
        ? { messaging_product: "whatsapp", to: m.recipient, type: "template", template: { name: E.WHATSAPP_TEMPLATE, language: { code: m.lang || "en" },
            components: [{ type: "body", parameters: [{ type: "text", text: `${m.subject}\n${m.body}`.slice(0, 1000) }] }] } }
        : { messaging_product: "whatsapp", to: m.recipient, type: "text", text: { body: `${m.subject}\n\n${m.body}` } }] },
  // Email through Resend's HTTP API (any provider with a JSON send endpoint can be swapped in here).
  email: { ok: () => !!(E.RESEND_API_KEY && E.EMAIL_FROM),
    headers: () => ({ authorization: `Bearer ${E.RESEND_API_KEY}` }),
    req: (m) => [`${E.RESEND_API_BASE || "https://api.resend.com"}/emails`, { from: E.EMAIL_FROM, to: [m.recipient], subject: m.subject, text: m.body }] },
};
const configured = () => Object.keys(providers).filter((k) => (k === "slack" ? !!E.SLACK_WEBHOOK_URL : providers[k].ok()));

function enqueue(mid, eventId, channel, recipient, subject, body) {
  // Unconfigured channel → keep a "logged" copy so the merchant can see what would have gone out.
  const status = channel === "log" || !providers[channel]?.ok() || (channel === "slack" && !recipient && !E.SLACK_WEBHOOK_URL) ? "logged" : "pending";
  db.prepare(`INSERT OR IGNORE INTO notifications(merchant_id,event_id,channel,recipient,subject,body,status,next_attempt,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(mid, eventId, channel, recipient || "", subject, body, status, now(), now());
}

// ── Routing ──
const MERCHANT_ALERTS = {
  "payment.fulfillable": (d) => [`Paid: ${usdt(d.amount)} — ${d.description || d.id}`, `Payment ${d.id} reached "${d.finality}" (your policy: ${d.policy}). Safe to fulfil.\n${PUBLIC_URL}/receipt.html?i=${d.id}`],
  "payment.reorged": (d) => [`⚠️ Payment reorged: ${d.id}`, `A chain reorganisation removed payment ${d.id}. Hold fulfilment until it's paid again.`],
  "refund_request.created": (d) => [`Refund request: ${usdt(d.amount)} on ${d.payment}`, `Reason: ${d.reason}. Review it in the dashboard → Refund requests.`],
  "exception.unattributed_transfer": (d) => [`Unmatched USDT received: ${usdt(d.amount)}`, `From ${d.sender}, tx ${d.tx}. Match it to an order in Dashboard → Exceptions.`],
  "exception.wrong_token": (d) => [`Wrong token received`, `Token ${d.token} from ${d.sender}, tx ${d.tx}. See Dashboard → Exceptions.`],
  "invoice.paid": (d) => [`Invoice ${d.number} paid`, `${d.client?.name} paid ${money(d.paid, d.currency, "en")}.`],
  "subscription.past_due": (d) => [`Subscription #${d.id} past due`, `Renewal failed (${d.reason}). Retrying automatically.`],
  "subscription.unpaid": (d) => [`Subscription #${d.id} unpaid`, `Grace period ended (${d.reason}). Consider pausing access.`],
  "merchant.payout_change_queued": (d) => [`🔐 Payout wallet change queued`, `New payout ${d.payout} takes effect at ${new Date(d.eta * 1000).toISOString()}. If this wasn't you, cancel it with the owner wallet now.`],
  "merchant.refund_operator_changed": (d) => [`🔐 Refund operator changed`, `${d.operator}: max ${usdt(d.perRefund)} per refund, ${usdt(d.perDay)} per day.`],
};
/** Where a merchant's alerts go. Provider credentials are platform-wide; destinations are per merchant. */
function merchantTargets(m) {
  const n = m && m.uid !== "mer_default" ? JSON.parse(m.notify || "{}")
    : { slackWebhookUrl: E.SLACK_WEBHOOK_URL, telegramChatId: E.TELEGRAM_CHAT_ID, whatsappTo: E.MERCHANT_WHATSAPP_TO, email: E.MERCHANT_EMAIL };
  return [["slack", n.slackWebhookUrl], ["telegram", n.telegramChatId], ["whatsapp", n.whatsappTo], ["email", n.email]]
    .filter(([ch, to]) => to && providers[ch].ok());
}

function customerInvoice(ev) {
  const d = ev.data, lang = d.language || "en", m = d.merchant?.name || cfg.merchant.name;
  const vars = { client: d.client?.name, merchant: m, number: d.number, amount: money(d.balance, d.currency, lang),
    balance: money(d.balance, d.currency, lang), date: date(d.dueDate, lang), url: `${PUBLIC_URL}/invoice.html?id=${d.id}&lang=${lang}` };
  let subject, body;
  if (ev.type === "invoice.created") [subject, body] = [t(lang, "mail.invoice.subject", vars), t(lang, "mail.invoice.body", vars)];
  else if (ev.type === "invoice.reminder") [subject, body] = [t(lang, d.reminder === "due_soon" ? "mail.reminder.due_soon.subject" : "mail.reminder.overdue.subject", vars), t(lang, "mail.reminder.body", vars)];
  else if (ev.type === "invoice.paid") [subject, body] = [t(lang, "mail.paid.subject", vars), t(lang, "mail.paid.body", vars)];
  else return;
  if (d.client?.email) enqueue(ev.merchantId, ev.id, "email", d.client.email, subject, body);
  if (d.client?.phone) enqueue(ev.merchantId, ev.id, "whatsapp", d.client.phone, subject, body);
}

wh.on((ev) => {
  if (ev.type.startsWith("invoice.")) customerInvoice(ev);
  const alert = MERCHANT_ALERTS[ev.type];
  if (!alert) return;
  const [subject, body] = alert(ev.data || {});
  const targets = merchantTargets(merchants.byOnchainId(ev.merchantId));
  if (!targets.length) return enqueue(ev.merchantId, ev.id, "log", "merchant", subject, body);
  for (const [ch, to] of targets) enqueue(ev.merchantId, ev.id, ch, to, subject, body);
});

async function deliverDue() {
  for (const n of db.prepare("SELECT * FROM notifications WHERE status='pending' AND next_attempt<=? LIMIT 20").all(now())) {
    const p = providers[n.channel];
    try {
      const [url, payload] = p.req(n);
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(p.headers?.() || {}) },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      db.prepare("UPDATE notifications SET status='sent',attempts=attempts+1 WHERE id=?").run(n.id);
    } catch (e) {
      const a = n.attempts + 1, done = a >= BACKOFF.length;
      db.prepare("UPDATE notifications SET attempts=?,status=?,next_attempt=?,last_error=? WHERE id=?")
        .run(a, done ? "failed" : "pending", now() + BACKOFF[a - 1], String(e.message).slice(0, 300), n.id);
    }
  }
}

function start() { setInterval(() => deliverDue().catch((e) => console.error("[notify]", e.message)), 3000); }
function list(mid) { return db.prepare("SELECT * FROM notifications WHERE merchant_id=? ORDER BY id DESC LIMIT 200").all(mid); }
function retry(id, mid) { return db.prepare("UPDATE notifications SET status='pending',attempts=0,next_attempt=? WHERE id=? AND merchant_id=? AND status IN ('failed','pending')").run(now(), id, mid).changes; }

module.exports = { start, list, retry, configured, deliverDue, providers, enqueue };
