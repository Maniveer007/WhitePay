// Tests notification routing and the Slack / Telegram / WhatsApp / Resend adapters against a local mock.
// No real provider is contacted. Run: node tests/e2e/notify.js
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const got = [];
let failTelegramOnce = true;
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url.includes("/sendMessage") && failTelegramOnce) { failTelegramOnce = false; res.writeHead(500); return res.end("provider down"); }
    got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
  });
});

let bad = 0;
const assert = (c, m) => { console.log(c ? "ok  " : "FAIL", m); if (!c) bad++; };

mock.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${mock.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-notify-"));
  fs.writeFileSync(path.join(dir, "deployment.json"), JSON.stringify({ chainId: 1874, pay: "0x0000000000000000000000000000000000000001",
    token: "0x0000000000000000000000000000000000000002", merchantId: 1, signerKey: "0x" + "11".repeat(32), rpcUrl: "http://127.0.0.1:1", deployBlock: 0 }));
  Object.assign(process.env, {
    DATA_DIR: path.relative(path.join(__dirname, "..", ".."), dir), ENV_FILE: "/dev/null", MERCHANT_NAME: "Acme Studio", PUBLIC_URL: "https://pay.example.com",
    SLACK_WEBHOOK_URL: `${base}/slack`, TELEGRAM_BOT_TOKEN: "tgtoken", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: base,
    WHATSAPP_TOKEN: "watoken", WHATSAPP_PHONE_ID: "123", WHATSAPP_API_BASE: base, MERCHANT_WHATSAPP_TO: "919800000001",
    RESEND_API_KEY: "retoken", EMAIL_FROM: "billing@acme.test", RESEND_API_BASE: base, MERCHANT_EMAIL: "owner@acme.test",
  });
  const wh = require("../../server/services/webhooks");
  const notify = require("../../server/services/notify");
  const { db } = require("../../server/db");

  assert(notify.configured().sort().join() === "email,slack,telegram,whatsapp", "all four providers detected from env");

  const inv = { id: "inv_1", number: "INV-0007", currency: "INR", balance: 1234500, dueDate: 1796000000, language: "hi",
    client: { name: "Ravi", email: "ravi@client.test", phone: "919800000002" } };
  wh.emit("evt_inv_1_created", "invoice.created", inv);
  wh.emit("evt_inv_1_created", "invoice.created", inv); // duplicate delivery of the same event
  wh.emit("evt_payout_1", "merchant.payout_change_queued", { payout: "0xabc", eta: 1796000000 });
  const rows = notify.list(1);
  assert(rows.length === 6, `6 messages queued, duplicate event ignored (got ${rows.length})`);

  await notify.deliverDue();
  db.prepare("UPDATE notifications SET next_attempt=0 WHERE status='pending'").run(); // skip the backoff wait
  await notify.deliverDue();

  const email = got.filter((g) => g.url === "/emails"), wa = got.filter((g) => g.url === "/123/messages");
  const clientMail = email.find((g) => g.body.to[0] === "ravi@client.test");
  assert(clientMail && clientMail.auth === "Bearer retoken" && clientMail.body.from === "billing@acme.test", "Resend: auth header, from, to");
  assert(clientMail?.body.subject === "Acme Studio की ओर से इनवॉइस INV-0007", `invoice email in the invoice's language (hi): "${clientMail?.body.subject}"`);
  assert(clientMail?.body.text.includes("₹12,345.00") && clientMail.body.text.includes("https://pay.example.com/invoice.html?id=inv_1&lang=hi"), "amount in Indian format + localized pay link");
  const clientWa = wa.find((g) => g.body.to === "919800000002");
  assert(clientWa && clientWa.auth === "Bearer watoken" && clientWa.body.messaging_product === "whatsapp" && clientWa.body.type === "text", "WhatsApp Cloud API: auth, product, recipient");
  const slack = got.find((g) => g.url === "/slack");
  assert(slack && slack.body.text.includes("Payout wallet change queued"), "Slack: security alert for payout change");
  const tg = got.find((g) => g.url === "/bottgtoken/sendMessage");
  assert(tg && tg.body.chat_id === "42", "Telegram: retried after a 500 and delivered");
  assert(wa.some((g) => g.body.to === "919800000001") && email.some((g) => g.body.to[0] === "owner@acme.test"), "merchant alert also sent to merchant WhatsApp + email");
  assert(notify.list(1).every((n) => n.status === "sent"), "every message ends in status 'sent'");

  mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
});
