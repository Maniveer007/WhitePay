package io.whitepay;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

/** Dependency-free test runner: java -cp out io.whitepay.WhitePayTest. Set WHITEPAY_BASE_URL for the live API test. */
public class WhitePayTest {
  static int passed = 0, failed = 0;

  static void check(String name, boolean ok) {
    if (ok) passed++; else failed++;
    System.out.println((ok ? "ok   " : "FAIL ") + name);
  }

  static WhitePayException expectError(Runnable r) {
    try { r.run(); } catch (WhitePayException e) { return e; }
    return null;
  }

  public static void main(String[] args) throws Exception {
    Map<String, Object> v = Json.obj(Json.parse(Files.readString(Path.of("../testdata/webhook-vectors.json"))));
    long tol = (Long) v.get("tolerance");
    for (Object o : Json.arr(v.get("cases"))) {
      Map<String, Object> c = Json.obj(o);
      String name = "webhook vector: " + c.get("name");
      Runnable run = () -> Webhook.verify((String) c.get("body"), (String) c.get("header"), (String) c.get("secret"), tol, (Long) c.get("now"));
      if ((Boolean) c.get("valid")) {
        check(name, "payment.fulfillable".equals(Webhook.verify((String) c.get("body"), (String) c.get("header"), (String) c.get("secret"), tol, (Long) c.get("now")).get("type")));
      } else {
        WhitePayException e = expectError(run);
        check(name, e != null && "invalid_signature".equals(e.code));
      }
    }

    String base = System.getenv("WHITEPAY_BASE_URL");
    if (base == null) {
      System.out.println("skip live API (set WHITEPAY_BASE_URL)");
    } else {
      String key = Optional.ofNullable(System.getenv("WHITEPAY_API_KEY")).orElse("wp_test_demo");
      WhitePay wp = new WhitePay(key, base, 2, java.time.Duration.ofSeconds(15));
      WhitePayException e = expectError(() -> new WhitePay("wrong", base, 0, java.time.Duration.ofSeconds(5)).listPayments(1, null));
      check("bad key → 401 unauthorized", e != null && e.status == 401 && "unauthorized".equals(e.code));

      String idem = "java-" + System.nanoTime();
      Map<String, Object> p = Map.of("amount", 12.5, "currency", "USD", "description", "SDK test");
      Map<String, Object> a = wp.createPayment(p, idem), b = wp.createPayment(p, idem);
      check("Idempotency-Key returns the same payment", a.get("id").equals(b.get("id")) && "12500000".equals(a.get("amount")));
      check("get payment", "12500000".equals(wp.getPayment((String) a.get("id")).get("amount")));

      wp.createPayment(Map.of("amount", 1), null);
      WhitePay.Page p1 = wp.listPayments(1, null);
      check("pagination first page", p1.data.size() == 1 && p1.hasMore && p1.nextCursor != null);
      check("cursor advances", !wp.listPayments(1, p1.nextCursor).data.get(0).get("id").equals(p1.data.get(0).get("id")));

      Map<String, Object> inv = wp.createInvoice(Map.of("clientName", "SDK client",
          "items", List.of(Map.of("description", "Work", "qty", 1, "unitPrice", 100, "taxPercent", 18))), null);
      check("invoice total 118.00", ((Number) inv.get("total")).longValue() == 11800);
      check("invoice open", "open".equals(wp.getInvoice((String) inv.get("id")).get("status")));
      check("pay invoice → checkout", String.valueOf(wp.payInvoice((String) inv.get("id"), null).get("checkoutUrl")).contains("pay_"));
      e = expectError(() -> wp.getPayment("pay_does_not_exist"));
      check("unknown payment → 404 not_found", e != null && e.status == 404 && "not_found".equals(e.code));

      Map<String, Object> ci = wp.createInvoice(Map.of("clientName", "Credit client", "items", List.of(Map.of("description", "Work", "qty", 1, "unitPrice", 100))), null);
      Map<String, Object> cn = wp.createCreditNote((String) ci.get("id"), 30, "pricing_error", null);
      check("credit note leaves 70.00", ((Number) ((Map<?, ?>) cn.get("invoice")).get("balance")).longValue() == 7000);
      e = expectError(() -> wp.createCreditNote((String) ci.get("id"), 500, null, null));
      check("oversized credit note → invalid_amount", e != null && "invalid_amount".equals(e.code));
      Map<String, Object> rec = wp.createRecurringInvoice(Map.of("frequency", "monthly",
          "template", Map.of("clientName", "Retainer", "items", List.of(Map.of("description", "Retainer", "unitPrice", 50)))));
      check("recurring issues its first invoice", ((Number) rec.get("runs")).intValue() == 1);
      check("pause recurring", "paused".equals(wp.pauseRecurringInvoice((String) rec.get("id")).get("status")));
      check("cancel recurring", "cancelled".equals(wp.cancelRecurringInvoice((String) rec.get("id")).get("status")));
      check("statement has a summary", wp.statement(null, null).containsKey("summary"));
      check("periods is a list", wp.periods() != null);
      check("agent policy inactive", Boolean.FALSE.equals(wp.agentPolicy("0x" + "1".repeat(40), "0x" + "2".repeat(40)).get("active")));
      check("test clock reports enabled flag", wp.testClock().get("enabled") instanceof Boolean);
    }
    System.out.println(passed + " passed, " + failed + " failed");
    System.exit(failed == 0 ? 0 : 1);
  }
}
