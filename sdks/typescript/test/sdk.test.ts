import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WhitePay, WhitePayError, verifyWebhook } from "../src/index.ts";

const vectors = JSON.parse(readFileSync(new URL("../../testdata/webhook-vectors.json", import.meta.url), "utf8"));

for (const c of vectors.cases) {
  test(`webhook vector: ${c.name}`, () => {
    const run = () => verifyWebhook(c.body, c.header, c.secret, { toleranceSec: vectors.tolerance, now: c.now });
    if (c.valid) assert.equal(run().type, "payment.fulfillable");
    else assert.throws(run, (e: unknown) => e instanceof WhitePayError && e.code === "invalid_signature");
  });
}

const base = process.env.WHITEPAY_BASE_URL, key = process.env.WHITEPAY_API_KEY ?? "wp_test_demo";
test("live API", { skip: !base && "set WHITEPAY_BASE_URL to run" }, async () => {
  const wp = new WhitePay(key, { baseUrl: base });
  await assert.rejects(new WhitePay("wrong", { baseUrl: base, maxRetries: 0 }).payments.list(), (e: unknown) => e instanceof WhitePayError && e.status === 401 && e.code === "unauthorized");

  const idem = "ts-" + Date.now();
  const a = await wp.payments.create({ amount: 12.5, currency: "USD", description: "SDK test" }, { idempotencyKey: idem });
  const b = await wp.payments.create({ amount: 12.5, currency: "USD", description: "SDK test" }, { idempotencyKey: idem });
  assert.equal(a.id, b.id, "same Idempotency-Key returns the same payment");
  assert.equal(a.amount, "12500000");
  assert.equal((await wp.payments.get(a.id)).amount, "12500000");

  await wp.payments.create({ amount: 1 });
  const p1 = await wp.payments.list({ limit: 1 });
  assert.equal(p1.data.length, 1); assert.equal(p1.hasMore, true); assert.ok(p1.nextCursor);
  const p2 = await wp.payments.list({ limit: 1, startingAfter: p1.nextCursor! });
  assert.notEqual(p2.data[0].id, p1.data[0].id, "cursor advances");

  const inv = await wp.invoices.create({ clientName: "SDK client", items: [{ description: "Work", qty: 1, unitPrice: 100, taxPercent: 18 }] });
  assert.equal(inv.total, 11800);
  assert.equal((await wp.invoices.get(inv.id)).status, "open");
  assert.ok((await wp.invoices.pay(inv.id)).checkoutUrl.includes("pay_"));
  await assert.rejects(wp.payments.get("pay_does_not_exist"), (e: unknown) => e instanceof WhitePayError && e.status === 404 && e.code === "not_found");
  assert.equal(typeof (await wp.invoices.aging()), "object");

  // credit notes, recurring invoices, statements, periods, agent policy
  const ci = await wp.invoices.create({ clientName: "Credit client", items: [{ description: "Work", qty: 1, unitPrice: 100 }] });
  const cn = await wp.creditNotes.create(ci.id, { amount: 30, reason: "pricing_error" });
  assert.equal((cn.invoice as { balance: number }).balance, 7000);
  await assert.rejects(wp.creditNotes.create(ci.id, { amount: 500 }), (e: unknown) => e instanceof WhitePayError && e.code === "invalid_amount");
  assert.ok((await wp.creditNotes.list()).some((n) => n.id === cn.id));
  const rec = await wp.recurringInvoices.create({ frequency: "monthly", template: { clientName: "Retainer", items: [{ description: "Retainer", unitPrice: 50 }] } });
  assert.equal(rec.runs, 1);
  assert.equal((await wp.recurringInvoices.pause(rec.id as string)).status, "paused");
  assert.equal((await wp.recurringInvoices.cancel(rec.id as string)).status, "cancelled");
  assert.ok((await wp.recurringInvoices.list()).some((r) => r.id === rec.id));
  assert.ok((await wp.statements.get()).summary);
  assert.ok(Array.isArray(await wp.periods.list()));
  const pol = await wp.agents.policy("0x" + "1".repeat(40), "0x" + "2".repeat(40));
  assert.equal(pol.active, false);
  assert.equal(typeof (await wp.testClock.get()).enabled, "boolean");
});
