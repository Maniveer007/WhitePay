// Test clock: lets a developer move the OFF-CHAIN clock forward (invoices, reminders, recurring invoices, quote times) to watch a
// billing cycle play out in seconds instead of weeks. Enable with TEST_CLOCK=1. It is refused on Whitechain mainnet.
//
// The blockchain's own time can't be moved, so anything the contract itself times (subscription periods, payout timelocks, refund windows)
// is NOT affected, and the subscription keeper deliberately ignores this clock. Use short on-chain periods (seconds) to test those.
const { kv } = require("../db");
const cfg = require("../config");

const MAINNET = 1875;
const enabled = process.env.TEST_CLOCK === "1" && cfg.dep.chainId !== MAINNET;

const offset = () => (enabled ? Number(kv.get("clock:offset", 0)) : 0);
const now = () => Math.floor(Date.now() / 1000) + offset();

/** Move the off-chain clock forward. */
async function advance(seconds) {
  if (!enabled) throw Object.assign(new Error("The test clock needs TEST_CLOCK=1 and is never available on mainnet"), { status: 403, code: "test_clock_disabled" });
  seconds = Math.floor(Number(seconds));
  if (!(seconds > 0) || seconds > 3 * 365 * 86400) throw Object.assign(new Error("seconds must be between 1 and 3 years"), { status: 400, code: "invalid_seconds" });
  kv.set("clock:offset", offset() + seconds);
  return state();
}
function reset() { if (enabled) kv.set("clock:offset", 0); return state(); }
const state = () => ({ enabled, offsetSeconds: offset(), now: now(), iso: new Date(now() * 1000).toISOString() });

module.exports = { now, advance, reset, state, enabled };
