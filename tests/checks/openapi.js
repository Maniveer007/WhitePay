// Contract check: every $ref resolves, and every documented path+method is routed by the running server.
// Usage: node tests/checks/openapi.js [baseUrl] (default http://localhost:3000/api/v1)
const spec = require("../../docs/openapi.json");
const base = process.argv[2] || "http://localhost:3000/api/v1";
require("dotenv").config({ path: require("path").join(__dirname, "../../.env.testnet"), quiet: true });
const key = process.env.WHITEPAY_API_KEY || process.env.API_KEY;
let bad = 0;
const fail = (m) => { bad++; console.log("FAIL", m); };

(function walk(o, at) {
  if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) {
    if (k === "$ref") { const target = v.replace(/^#\//, "").split("/").reduce((x, p) => x?.[p], spec); if (!target) fail(`unresolved $ref ${v} at ${at}`); }
    else walk(v, `${at}/${k}`);
  }
})(spec, "#");

(async () => {
  for (const [p, ops] of Object.entries(spec.paths)) for (const m of Object.keys(ops)) {
    const url = base + p.replace(/\{[^}]+\}/g, "does_not_exist");
    const useKey = ops[m].security?.[0]?.platform ? (process.env.WHITEPAY_PLATFORM_KEY || process.env.PLATFORM_KEY) : key;
    const safe = ["/merchants/me/rotate-key", "/auditor-key", "/auditor-key/revoke"].includes(p) ? "GET" : m.toUpperCase(); // don't actually rotate the key during a check
    const r = await fetch(url, { method: safe, headers: { authorization: "Bearer " + useKey, "content-type": "application/json" }, body: safe === "GET" ? undefined : "{}" });
    const body = await r.json().catch(() => ({}));
    if (safe !== m.toUpperCase()) { console.log("skip ", m.toUpperCase().padEnd(5), p, "(not called: would change state)"); continue; }
    if (body?.error?.code === "not_found" && body.error.message === "No such endpoint") fail(`${m.toUpperCase()} ${p} is documented but not routed`);
    else console.log("ok  ", m.toUpperCase().padEnd(5), p, "→", r.status);
  }
  process.exit(bad ? 1 : 0);
})();
