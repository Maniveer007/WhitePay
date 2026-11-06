#!/usr/bin/env node
// WhitePay MCP server (stdio). Lets an AI assistant or agent work with WhitePay through tools.
//
// Merchant tools need WHITEPAY_API_KEY. Agent tools (pay on someone's behalf) additionally need AGENT_PRIVATE_KEY and
// AGENT_OWNER: the agent key only ever spends from the owner's wallet inside the on-chain policy the owner granted
// (per-payment limit, daily limit, expiry, merchant allowlist), and the owner can revoke it at any time.
// Zero setup beyond `npm install` in this repo (uses ethers, already a dependency).
const { ethers } = require("ethers");

const BASE = (process.env.WHITEPAY_BASE_URL || "http://localhost:3000").replace(/\/+$/, "").replace(/\/api\/v1$/, "");
const KEY = process.env.WHITEPAY_API_KEY || "";
const AGENT_KEY = process.env.AGENT_PRIVATE_KEY || "", OWNER = process.env.AGENT_OWNER || "";
const MAX_AUTO = Number(process.env.AGENT_MAX_USDT || 25); // extra client-side ceiling per payment, on top of the on-chain policy
const AGENT_ABI = require("../artifacts/contracts/WhitePayAgent.sol/WhitePayAgent.json").abi;

const api = async (path, { method = "GET", body, auth = true } = {}) => {
  const r = await fetch(BASE + "/api/v1" + path, { method, headers: { "content-type": "application/json", ...(auth && KEY ? { authorization: "Bearer " + KEY } : {}) }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 402) throw new Error(`${r.status} ${j.error?.code || ""}: ${j.error?.message || r.statusText}`);
  return { status: r.status, body: j, headers: r.headers };
};
const fail = (m) => { throw new Error(m); };
const usdt = (u) => Number(u) / 1e6;

let agentCtx;
async function agent() {
  if (!AGENT_KEY || !OWNER) fail("Agent payments need AGENT_PRIVATE_KEY and AGENT_OWNER in the MCP server environment");
  if (agentCtx) return agentCtx;
  const cfg = (await api("/../config", { auth: false })).body, ext = (await api("/../extensions", { auth: false })).body;
  if (!ext.agent) fail("This WhitePay deployment has no agent module");
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl), wallet = new ethers.NonceManager(new ethers.Wallet(AGENT_KEY, provider));
  return (agentCtx = { cfg, ext, contract: new ethers.Contract(ext.agent, AGENT_ABI, wallet), address: new ethers.Wallet(AGENT_KEY).address });
}

const REASONS = { OverPaymentLimit: "This payment is above the owner's per-payment limit", OverDailyLimit: "This would exceed the owner's daily limit",
  PolicyExpired: "The owner's spending policy has expired", NoPolicy: "The owner has not granted this agent a spending policy (or revoked it)",
  MerchantNotAllowed: "The owner has not allowed this merchant for this agent", Expired: "The quote has expired", AlreadyPaid: "This payment was already paid" };

/** Pay a WhitePay payment from the owner's wallet under the owner's policy. */
async function payQuote(paymentId) {
  const a = await agent();
  const p = (await api(`/payments/${paymentId}`, { auth: false })).body;
  if (!p.quote) fail("Unknown payment");
  if (usdt(p.quote.amount) > MAX_AUTO) fail(`Refusing to pay ${usdt(p.quote.amount)} USDT: above this server's AGENT_MAX_USDT (${MAX_AUTO})`);
  const q = p.quote;
  const args = [OWNER, [q.merchantId, q.intentId, q.token, q.amount, q.expiry], p.signature];
  // Simulate first: a policy refusal comes back as a readable reason, and no gas is spent on a payment that would revert.
  try { await a.contract.agentPay.staticCall(...args); }
  catch (e) { throw new Error(REASONS[e.revert?.name] || e.revert?.name || e.shortMessage || e.message); }
  const tx = await a.contract.agentPay(...args);
  const rc = await tx.wait();
  return { paymentId, amountUsdt: usdt(q.amount), txHash: rc.hash, payer: OWNER, paidBy: a.address };
}

/** Full x402 flow: request → 402 → pay → wait for settlement → retry with proof. */
async function fetchPaid(url, maxUsdt) {
  const first = await fetch(url);
  if (first.status !== 402) return { status: first.status, body: await first.text(), paid: false };
  const ch = await first.json(), req = ch.accepts?.find((x) => x.scheme === "whitepay-quote") || fail("Server did not offer a whitepay-quote payment");
  const price = usdt(req.maxAmountRequired);
  if (price > (maxUsdt ?? MAX_AUTO)) fail(`Price ${price} USDT is above your limit of ${maxUsdt ?? MAX_AUTO} USDT; not paying`);
  const paid = await payQuote(req.paymentId);
  const header = Buffer.from(JSON.stringify({ paymentId: req.paymentId })).toString("base64");
  for (let i = 0; i < 30; i++) {
    const r = await fetch(url, { headers: { "x-payment": header } });
    if (r.status !== 402) return { status: r.status, body: await r.text(), paid: true, ...paid };
    await new Promise((s) => setTimeout(s, 1000));
  }
  fail("Paid, but the payment did not settle in time; retry with the same payment id: " + req.paymentId);
}

const S = (props, required = []) => ({ type: "object", properties: props, required });
const TOOLS = [
  { name: "create_payment", description: "Create a WhitePay payment (checkout link) for an amount.", merchant: true,
    inputSchema: S({ amount: { type: "number" }, currency: { type: "string", enum: ["USD", "EUR", "INR", "GBP", "USDT"] }, description: { type: "string" }, orderRef: { type: "string" } }, ["amount"]),
    run: async (a) => (await api("/payments", { method: "POST", body: { currency: "USD", ...a } })).body },
  { name: "get_payment", description: "Get a payment's status, finality and refunds.", merchant: true, inputSchema: S({ id: { type: "string" } }, ["id"]), run: async (a) => (await api(`/payments/${a.id}`)).body },
  { name: "list_payments", description: "List recent payments.", merchant: true, inputSchema: S({ limit: { type: "integer" } }), run: async (a) => (await api(`/payments?limit=${a.limit || 20}`)).body },
  { name: "create_invoice", description: "Create an invoice. Items: [{description, qty, unitPrice, taxPercent}].", merchant: true,
    inputSchema: S({ clientName: { type: "string" }, clientEmail: { type: "string" }, currency: { type: "string" }, terms: { type: "string" }, items: { type: "array", items: { type: "object" } } }, ["clientName", "items"]),
    run: async (a) => (await api("/invoices", { method: "POST", body: a })).body },
  { name: "create_credit_note", description: "Issue a credit note against an invoice (amount in major units).", merchant: true,
    inputSchema: S({ invoiceId: { type: "string" }, amount: { type: "number" }, reason: { type: "string" }, note: { type: "string" } }, ["invoiceId", "amount"]),
    run: async (a) => (await api(`/invoices/${a.invoiceId}/credit-notes`, { method: "POST", body: { amount: a.amount, reason: a.reason, note: a.note } })).body },
  { name: "statement_summary", description: "Revenue, refunds and net revenue (USDT base units) between two unix timestamps.", merchant: true,
    inputSchema: S({ from: { type: "integer" }, to: { type: "integer" } }),
    run: async (a) => { const s = (await api(`/statements?format=json${a.from ? "&from=" + a.from : ""}${a.to ? "&to=" + a.to : ""}`)).body; return { summary: s.summary, aging: s.aging, invoices: s.invoices.length }; } },
  { name: "pay_payment", description: "Pay a WhitePay payment id from the owner's wallet, inside the owner's on-chain spending policy.", agent: true,
    inputSchema: S({ paymentId: { type: "string" } }, ["paymentId"]), run: async (a) => payQuote(a.paymentId) },
  { name: "fetch_paid_resource", description: "GET a URL that may answer HTTP 402 (x402). If it does, pay the quote under the spending policy and return the content.", agent: true,
    inputSchema: S({ url: { type: "string" }, maxUsdt: { type: "number", description: "Do not pay more than this" } }, ["url"]), run: async (a) => fetchPaid(a.url, a.maxUsdt) },
  { name: "check_spending_policy", description: "Show this agent's remaining budget under the owner's policy.", agent: true, inputSchema: S({}),
    run: async () => { const a = await agent(); return (await api(`/agents/policy?owner=${OWNER}&agent=${a.address}`, { auth: false })).body; } },
];
const available = () => TOOLS.filter((t) => (t.merchant ? !!KEY : true) && (t.agent ? !!(AGENT_KEY && OWNER) : true));

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") return send({ id, result: { protocolVersion: params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "whitepay", version: "1.0.0" } } });
  if (method === "ping") return send({ id, result: {} });
  if (method === "tools/list") return send({ id, result: { tools: available().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  if (method === "tools/call") {
    const t = available().find((x) => x.name === params?.name);
    if (!t) return send({ id, error: { code: -32602, message: `Unknown or unavailable tool: ${params?.name}` } });
    try { return send({ id, result: { content: [{ type: "text", text: JSON.stringify(await t.run(params.arguments || {}), null, 2) }] } }); }
    catch (e) { return send({ id, result: { isError: true, content: [{ type: "text", text: String(e.shortMessage || e.message) }] } }); }
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } }); // notifications need no reply
}

let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\n")) >= 0;) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (line) { let m; try { m = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: "Parse error" } }); continue; } handle(m).catch((e) => m.id !== undefined && send({ id: m.id, error: { code: -32603, message: e.message } })); }
  }
});
module.exports = { TOOLS, fetchPaid, payQuote };
