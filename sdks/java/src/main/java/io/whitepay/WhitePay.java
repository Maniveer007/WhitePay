package io.whitepay;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;

/**
 * WhitePay Java SDK (Java 17+, no dependencies). Mirrors public/openapi.json.
 * Results are JSON maps: {@code Map<String,Object>} with field names from the API (e.g. "id", "amount").
 */
public class WhitePay {
  private final String apiKey;
  private final String baseUrl;
  private final int maxRetries;
  private final Duration timeout;
  private final HttpClient http;

  public WhitePay(String apiKey) { this(apiKey, "http://localhost:3000/api/v1", 2, Duration.ofSeconds(15)); }

  public WhitePay(String apiKey, String baseUrl, int maxRetries, Duration timeout) {
    if (apiKey == null || apiKey.isEmpty()) throw new IllegalArgumentException("apiKey is required");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replaceAll("/$", "");
    this.maxRetries = maxRetries;
    this.timeout = timeout;
    this.http = HttpClient.newBuilder().connectTimeout(timeout).build();
  }

  /** One page of results plus its cursor. */
  public static final class Page {
    public final List<Map<String, Object>> data;
    public final boolean hasMore;
    public final String nextCursor;
    Page(List<Map<String, Object>> data, boolean hasMore, String nextCursor) { this.data = data; this.hasMore = hasMore; this.nextCursor = nextCursor; }
  }

  /** Raw response: decoded JSON plus headers. */
  public static final class Response {
    public final Object body;
    public final java.net.http.HttpHeaders headers;
    Response(Object body, java.net.http.HttpHeaders headers) { this.body = body; this.headers = headers; }
  }

  // ── Payments ──
  public Map<String, Object> createPayment(Map<String, Object> params, String idempotencyKey) { return obj(request("POST", "/payments", params, idempotencyKey)); }
  public Map<String, Object> getPayment(String id) { return obj(request("GET", "/payments/" + esc(id), null, null)); }
  public Page listPayments(Integer limit, String startingAfter) { return page("/payments", limit, startingAfter); }
  public Map<String, Object> requotePayment(String id) { return obj(request("POST", "/payments/" + esc(id) + "/requote", Map.of(), null)); }

  // ── Invoices ── (params use the API's camelCase names: clientName, items[{description, qty, unitPrice, taxPercent}], …)
  public Map<String, Object> createInvoice(Map<String, Object> params, String idempotencyKey) { return obj(request("POST", "/invoices", params, idempotencyKey)); }
  public Map<String, Object> getInvoice(String id) { return obj(request("GET", "/invoices/" + esc(id), null, null)); }
  public Page listInvoices(Integer limit, String startingAfter) { return page("/invoices", limit, startingAfter); }
  /** amount == null pays the full balance. */
  public Map<String, Object> payInvoice(String id, Double amount) {
    return obj(request("POST", "/invoices/" + esc(id) + "/pay", amount == null ? Map.of("full", true) : Map.of("amount", amount), null));
  }
  public Map<String, Object> voidInvoice(String id) { return obj(request("POST", "/invoices/" + esc(id) + "/void", Map.of(), null)); }
  public Map<String, Object> remindInvoice(String id) { return obj(request("POST", "/invoices/" + esc(id) + "/remind", Map.of(), null)); }
  public Map<String, Object> invoiceAging() { return obj(request("GET", "/invoices/aging", null, null)); }

  // ── Operations ──
  public List<Object> refundRequests() { return Json.arr(request("GET", "/refund-requests", null, null).body); }
  public Map<String, Object> rejectRefundRequest(long id, String note) { return obj(request("POST", "/refund-requests/" + id + "/reject", Map.of("note", note == null ? "" : note), null)); }
  public List<Object> subscriptions() { return Json.arr(request("GET", "/subscriptions", null, null).body); }
  public List<Object> exceptions() { return Json.arr(request("GET", "/exceptions", null, null).body); }
  public Map<String, Object> replayWebhook(long id) { return obj(request("POST", "/webhooks/" + id + "/replay", Map.of(), null)); }
  // ── Credit notes, recurring invoices, finance, meters, agents, test clock ──
  /** amount in major units; reason may be null (defaults to "adjustment"). */
  public Map<String, Object> createCreditNote(String invoiceId, double amount, String reason, String note) {
    Map<String, Object> b = new java.util.HashMap<>();
    b.put("amount", amount);
    if (reason != null) b.put("reason", reason);
    if (note != null) b.put("note", note);
    return obj(request("POST", "/invoices/" + esc(invoiceId) + "/credit-notes", b, null));
  }
  public List<Object> creditNotes() { return Json.arr(request("GET", "/credit-notes", null, null).body); }
  /** params: frequency (weekly|monthly|quarterly|yearly), template (same fields as createInvoice), every, startDate, endDate, maxRuns. */
  public Map<String, Object> createRecurringInvoice(Map<String, Object> params) { return obj(request("POST", "/recurring-invoices", params, null)); }
  public List<Object> recurringInvoices() { return Json.arr(request("GET", "/recurring-invoices", null, null).body); }
  public Map<String, Object> pauseRecurringInvoice(String id) { return obj(request("POST", "/recurring-invoices/" + esc(id) + "/pause", Map.of(), null)); }
  public Map<String, Object> resumeRecurringInvoice(String id) { return obj(request("POST", "/recurring-invoices/" + esc(id) + "/resume", Map.of(), null)); }
  public Map<String, Object> cancelRecurringInvoice(String id) { return obj(request("POST", "/recurring-invoices/" + esc(id) + "/cancel", Map.of(), null)); }
  /** JSON statement for [from, to) in unix seconds (null = unbounded). Excel/PDF/CSV/Xero/QuickBooks files use the same endpoint with ?format=. */
  public Map<String, Object> statement(Long from, Long to) {
    return obj(request("GET", "/statements?format=json" + (from != null ? "&from=" + from : "") + (to != null ? "&to=" + to : ""), null, null));
  }
  public List<Object> periods() { return Json.arr(request("GET", "/periods", null, null).body); }
  public Map<String, Object> closePeriod(long from, long to, String label) {
    Map<String, Object> b = new java.util.HashMap<>();
    b.put("from", from);
    b.put("to", to);
    if (label != null) b.put("label", label);
    return obj(request("POST", "/periods/close", b, null));
  }
  public Map<String, Object> reopenPeriod(long id, String reason) { return obj(request("POST", "/periods/" + id + "/reopen", Map.of("reason", reason), null)); }
  /** Read-only key for an auditor; the new key is shown once. */
  public Map<String, Object> createAuditorKey() { return obj(request("POST", "/auditor-key", Map.of(), null)); }
  public Map<String, Object> revokeAuditorKey() { return obj(request("POST", "/auditor-key/revoke", Map.of(), null)); }
  public Map<String, Object> meter(long id) { return obj(request("GET", "/meters/" + id, null, null)); }
  /** reportId is your idempotency key: the same id is billed once. */
  public Map<String, Object> reportUsage(long meterId, long units, String reportId) {
    return obj(request("POST", "/meters/" + meterId + "/usage", Map.of("units", units, "reportId", reportId), null));
  }
  public Map<String, Object> agentPolicy(String owner, String agent) { return obj(request("GET", "/agents/policy?owner=" + esc(owner) + "&agent=" + esc(agent), null, null)); }
  /** Test clock: local development chain only. */
  public Map<String, Object> testClock() { return obj(request("GET", "/test-clock", null, null)); }
  public Map<String, Object> advanceTestClock(long seconds) { return obj(request("POST", "/test-clock/advance", Map.of("seconds", seconds), null)); }
  public Map<String, Object> reconcile() { return obj(request("GET", "/reconcile", null, null)); }
  public Map<String, Object> status() { return obj(request("GET", "/status", null, null)); }

  /** Low-level request with retries. POSTs always carry an Idempotency-Key so retries can't double-charge. */
  public Response request(String method, String path, Object body, String idempotencyKey) {
    String key = "POST".equals(method) ? (idempotencyKey != null ? idempotencyKey : UUID.randomUUID().toString()) : null;
    for (int attempt = 0; ; attempt++) {
      HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(baseUrl + path)).timeout(timeout)
          .header("Authorization", "Bearer " + apiKey).header("Content-Type", "application/json").header("User-Agent", "whitepay-java/0.1.0")
          .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(Json.write(body)));
      if (key != null) b.header("Idempotency-Key", key);
      HttpResponse<String> res;
      try {
        res = http.send(b.build(), HttpResponse.BodyHandlers.ofString());
      } catch (java.io.IOException e) {
        if (attempt < maxRetries) { backoff(attempt); continue; }
        throw new WhitePayException(0, "network_error", e.getMessage());
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new WhitePayException(0, "interrupted", e.getMessage());
      }
      int code = res.statusCode();
      if ((code == 429 || code >= 500) && attempt < maxRetries) { backoff(attempt); continue; }
      Object parsed = res.body().isEmpty() ? null : Json.parse(res.body());
      if (code >= 300) {
        Map<String, Object> err = parsed instanceof Map && Json.obj(parsed).get("error") instanceof Map ? Json.obj(Json.obj(parsed).get("error")) : Map.of();
        throw new WhitePayException(code, String.valueOf(err.getOrDefault("code", "http_error")), String.valueOf(err.getOrDefault("message", "HTTP " + code)));
      }
      return new Response(parsed, res.headers());
    }
  }

  private Page page(String path, Integer limit, String startingAfter) {
    StringJoiner q = new StringJoiner("&");
    if (limit != null) q.add("limit=" + limit);
    if (startingAfter != null) q.add("starting_after=" + esc(startingAfter));
    Response r = request("GET", q.length() > 0 ? path + "?" + q : path, null, null);
    List<Map<String, Object>> items = new ArrayList<>();
    for (Object o : Json.arr(r.body)) items.add(Json.obj(o));
    return new Page(items, "true".equals(r.headers.firstValue("WhitePay-Has-More").orElse("")), r.headers.firstValue("WhitePay-Next-Cursor").orElse(null));
  }

  private static Map<String, Object> obj(Response r) { return Json.obj(r.body); }
  private static String esc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20"); }
  private static void backoff(int attempt) {
    try { Thread.sleep(250L << attempt); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
  }
}
