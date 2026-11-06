// Tests the CLI (webhook forwarding) and the MCP server (merchant tools + a full x402 purchase by an agent)
// on the Whitechain testnet (needs `npm run testnet` running).
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const crypto = require("crypto");
const T = require("../support/testnet");
const { ethers } = T;
const B = T.API, KEY = T.KEY;
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, WHITEPAY_API_KEY: KEY, WHITEPAY_BASE_URL: B };

(async () => {
  // ── CLI: payments + webhook forwarding with a verifiable signature ──
  const created = JSON.parse(spawnSync("node", ["cli/whitepay.js", "payments", "create", "--amount", "7", "--description", "cli test"], { env }).stdout.toString());
  assert(created.id?.startsWith("pay_") && created.amount === "7000000", "cli creates a payment");
  const secret = (await (await fetch(B + "/api/webhook-secret", { headers: { authorization: "Bearer " + KEY } })).json()).secret;
  const got = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    const parts = Object.fromEntries(String(req.headers["x-whitepay-signature"]).split(",").map((p) => p.split("=")));
    const ok = crypto.createHmac("sha256", secret).update(`${parts.t}.${b}`).digest("hex") === parts.v1;
    got.push({ ok, type: JSON.parse(b).type }); res.end("ok"); }); }).listen(4242);
  const l = spawn("node", ["cli/whitepay.js", "listen", "--forward-to", "http://localhost:4242/hook", "--interval", "300"], { env });
  await sleep(1500);
  spawnSync("node", ["cli/whitepay.js", "invoices", "create", "--client", "CLI Co", "--item", "Work:1:10"], { env });
  for (let i = 0; i < 20 && !got.length; i++) await sleep(300);
  l.kill(); srv.close();
  assert(got.some((g) => g.type === "invoice.created" && g.ok), "listen forwards events with a signature the receiver can verify");
  const st = spawnSync("node", ["cli/whitepay.js", "statement", "--format", "xlsx", "--out", "/tmp/cli-statement.xlsx"], { env });
  assert(/wrote/.test(st.stdout.toString()) && require("fs").readFileSync("/tmp/cli-statement.xlsx").slice(0, 2).toString() === "PK", "cli downloads an xlsx statement");

  // ── MCP over stdio ──
  const ext = await (await fetch(B + "/api/extensions")).json(), cfg = await (await fetch(B + "/api/config")).json();
  const [human, agentW] = await T.fresh(2), AGENT = agentW.pk, agentAddr = new ethers.Wallet(AGENT).address, humanAddr = await human.getAddress(); // the agent pays its own gas
  const ownerW = T.deployer;
  const tok = (w) => new ethers.Contract(cfg.token, ["function mint(address,uint256)", "function approve(address,uint256)"], w);
  await (await tok(ownerW).mint(humanAddr, 100_000_000n)).wait();
  await (await tok(human).approve(cfg.pay, 100_000_000n)).wait();
  const agentC = new ethers.Contract(ext.agent, require("../../artifacts/contracts/WhitePayAgent.sol/WhitePayAgent.json").abi, human);
  await (await agentC.setPolicy(agentAddr, 1_000_000n, 3_000_000n, Math.floor(Date.now() / 1000) + 10 * 86400, false)).wait(); // 1 USDT per payment, 3 per day

  const mcp = spawn("node", ["mcp/server.js"], { env: { ...env, AGENT_PRIVATE_KEY: AGENT, AGENT_OWNER: humanAddr, AGENT_MAX_USDT: "5" } });
  const pending = new Map(); let buf = "", n = 0;
  mcp.stdout.on("data", (d) => { buf += d; for (let i; (i = buf.indexOf("\n")) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending.get(m.id)?.(m); } });
  const ask = (method, params) => new Promise((res) => { const id = ++n; pending.set(id, res); mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const call = async (name, args) => { const r = await ask("tools/call", { name, arguments: args }); return { err: !!r.result?.isError || !!r.error, text: r.result?.content?.[0]?.text || r.error?.message }; };

  const init = await ask("initialize", { protocolVersion: "2024-11-05" });
  assert(init.result.serverInfo.name === "whitepay", "mcp initialize");
  const tools = (await ask("tools/list")).result.tools.map((t) => t.name);
  assert(["create_payment", "pay_payment", "fetch_paid_resource", "check_spending_policy"].every((t) => tools.includes(t)), "mcp lists merchant and agent tools");
  const cp = await call("create_payment", { amount: 3, description: "via mcp" });
  assert(!cp.err && JSON.parse(cp.text).id.startsWith("pay_"), "mcp create_payment works");
  const pol = await call("check_spending_policy", {});
  assert(JSON.parse(pol.text).perPayment === "1000000", "mcp reads the agent's policy");
  const over = await call("pay_payment", { paymentId: JSON.parse(cp.text).id });
  assert(over.err, "agent cannot pay 3 USDT: above the 1 USDT policy limit (" + over.text.slice(0, 60) + "…)");
  const bought = await call("fetch_paid_resource", { url: B + "/api/x402/demo", maxUsdt: 1 });
  if (bought.err) console.log("   ", bought.text);
  assert(!bought.err && JSON.parse(bought.text).paid === true && /Paid content/.test(bought.text), "agent buys an x402 resource end to end");
  const tooDear = await call("fetch_paid_resource", { url: B + "/api/x402/demo", maxUsdt: 0.01 });
  assert(tooDear.err && /above your limit/.test(tooDear.text), "agent refuses to pay above its own maxUsdt");
  mcp.kill();
  console.log("\nCLI and MCP checks passed.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
