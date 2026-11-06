#!/usr/bin/env node
// WhitePay CLI. Zero dependencies. Configure with WHITEPAY_API_KEY and (optionally) WHITEPAY_BASE_URL.
//   whitepay payments create --amount 25 --currency USD --description "Test"
//   whitepay listen --forward-to http://localhost:4242/webhook      # webhook forwarding for local development
//   whitepay clock advance --days 30                                # test clock (local chain only)
const crypto = require("crypto");
const fs = require("fs");

const BASE = (process.env.WHITEPAY_BASE_URL || "http://localhost:3000").replace(/\/+$/, "").replace(/\/api\/v1$/, "");
const KEY = process.env.WHITEPAY_API_KEY || "";

function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) opt[k] = v; else if (argv[i + 1] && !argv[i + 1].startsWith("--")) opt[k] = argv[++i]; else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

async function call(path, { method = "GET", body, raw } = {}) {
  if (!KEY) die("Set WHITEPAY_API_KEY (e.g. export WHITEPAY_API_KEY=wp_test_demo)");
  const r = await fetch(BASE + "/api/v1" + path, { method, headers: { authorization: "Bearer " + KEY, "content-type": "application/json" }, body: body && JSON.stringify(body) });
  if (raw) return r;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) die(`${r.status} ${j.error?.code || ""}: ${j.error?.message || r.statusText}`);
  return j;
}
function die(m) { console.error("error: " + m); process.exit(1); }
const out = (v) => console.log(JSON.stringify(v, null, 2));
const need = (o, k) => o[k] === undefined || o[k] === true ? die(`--${k} is required`) : o[k];

/** Same scheme every SDK verifies: t=<unix>,v1=HMAC_SHA256(secret, `${t}.${body}`). */
const sign = (body, secret) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`; };

async function listen(o) {
  const target = o["forward-to"], only = o.events ? String(o.events).split(",") : null;
  const secret = o.secret || (await call("/webhook-secret")).secret;
  let after = Number(o.from ?? (await call("/events/latest")).id);
  console.log(`Listening for events${only ? ` (${only.join(", ")})` : ""}${target ? `, forwarding to ${target}` : ""}. Press Ctrl+C to stop.`);
  for (;;) {
    for (const e of await call(`/events?after_id=${after}`)) {
      after = e.id;
      if (only && !only.some((p) => e.type === p || (p.endsWith("*") && e.type.startsWith(p.slice(0, -1))))) continue;
      let line = `${new Date(e.createdAt * 1000).toISOString()}  ${e.type.padEnd(30)} ${e.eventId}`;
      if (target) {
        try {
          const r = await fetch(target, { method: "POST", headers: { "content-type": "application/json", "x-whitepay-signature": sign(e.payload, secret) }, body: e.payload, signal: AbortSignal.timeout(5000) });
          line += `  → ${r.status}`;
        } catch (err) { line += `  → failed (${err.cause?.code || err.message})`; }
      }
      console.log(line);
      if (o.verbose) console.log(e.payload);
    }
    await new Promise((r) => setTimeout(r, Number(o.interval || 1000)));
  }
}

const HELP = `whitepay <command>

  payments create --amount <n> [--currency USD] [--description s] [--order-ref s] [--policy seen|safe|finalized|auto]
  payments get <id>        payments list [--limit n]
  invoices create --client <name> --item "description:qty:price[:tax%]" [--item ...] [--currency USD] [--terms net_30]
  invoices list            invoices credit <invoiceId> --amount <n> [--reason adjustment]
  recurring create --client <name> --item "desc:qty:price" --frequency monthly [--every 1] [--max-runs n]
  recurring list           recurring pause|resume|cancel <id>
  statement --from <unix|YYYY-MM-DD> --to <...> --format json|xlsx|pdf|csv|xero|quickbooks [--out file]
  periods list             periods close --from <> --to <> [--label s]
  listen [--forward-to url] [--events payment.*,invoice.paid] [--secret whsec_…] [--verbose]
  clock get                clock advance --days <n> | --seconds <n>      (local chain only)

Environment: WHITEPAY_API_KEY, WHITEPAY_BASE_URL (default http://localhost:3000)`;

const ts = (v) => (/^\d+$/.test(String(v)) ? Number(v) : Math.floor(Date.parse(v + (String(v).length <= 10 ? "T00:00:00Z" : "")) / 1000));
const items = (o) => [].concat(o.item ?? []).map((s) => { const [description, qty = "1", unitPrice, taxPercent = "0"] = String(s).split(":"); if (!description || !unitPrice) die(`Bad --item "${s}" (want description:qty:price[:tax%])`); return { description, qty: Number(qty), unitPrice: Number(unitPrice), taxPercent: Number(taxPercent) }; });

(async () => {
  const { pos, opt: o } = parse(process.argv.slice(2));
  const [cmd, sub, arg] = pos;
  if (!cmd || cmd === "help" || o.help) return console.log(HELP);
  if (cmd === "payments" && sub === "create") return out(await call("/payments", { method: "POST", body: { amount: Number(need(o, "amount")), currency: o.currency || "USD", description: o.description, orderRef: o["order-ref"], policy: o.policy } }));
  if (cmd === "payments" && sub === "get") return out(await call(`/payments/${arg || die("payment id required")}`));
  if (cmd === "payments" && sub === "list") return out(await call(`/payments?limit=${o.limit || 20}`));
  if (cmd === "invoices" && sub === "create") return out(await call("/invoices", { method: "POST", body: { clientName: need(o, "client"), clientEmail: o.email, currency: o.currency || "USD", terms: o.terms || "net_30", items: items(o) } }));
  if (cmd === "invoices" && sub === "list") return out(await call("/invoices?limit=" + (o.limit || 20)));
  if (cmd === "invoices" && sub === "credit") return out(await call(`/invoices/${arg || die("invoice id required")}/credit-notes`, { method: "POST", body: { amount: Number(need(o, "amount")), reason: o.reason || "adjustment", note: o.note } }));
  if (cmd === "recurring" && sub === "create") return out(await call("/recurring-invoices", { method: "POST", body: { frequency: need(o, "frequency"), every: Number(o.every || 1), maxRuns: o["max-runs"] && Number(o["max-runs"]),
    template: { clientName: need(o, "client"), clientEmail: o.email, currency: o.currency || "USD", terms: o.terms || "net_30", items: items(o) } } }));
  if (cmd === "recurring" && sub === "list") return out(await call("/recurring-invoices"));
  if (cmd === "recurring" && ["pause", "resume", "cancel"].includes(sub)) return out(await call(`/recurring-invoices/${arg || die("schedule id required")}/${sub}`, { method: "POST" }));
  if (cmd === "statement") {
    const f = o.format || "json", r = await call(`/statements?from=${ts(o.from || 0)}&to=${ts(o.to || Math.floor(Date.now() / 1000) + 1)}&format=${f}`, { raw: true });
    if (!r.ok) die((await r.json()).error?.message);
    if (f === "json") return out(await r.json());
    const file = o.out || `statement.${f === "xero" || f === "quickbooks" ? f + ".csv" : f}`;
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())); return console.log("wrote " + file);
  }
  if (cmd === "periods" && sub === "list") return out(await call("/periods"));
  if (cmd === "periods" && sub === "close") return out(await call("/periods/close", { method: "POST", body: { from: ts(need(o, "from")), to: ts(need(o, "to")), label: o.label } }));
  if (cmd === "listen") return listen(o);
  if (cmd === "clock" && sub === "get") return out(await call("/test-clock"));
  if (cmd === "clock" && sub === "advance") return out(await call("/test-clock/advance", { method: "POST", body: o.days ? { days: Number(o.days) } : { seconds: Number(need(o, "seconds")) } }));
  console.log(HELP); process.exit(1);
})().catch((e) => die(e.cause?.code === "ECONNREFUSED" ? `cannot reach ${BASE} (is the server running?)` : e.message));
