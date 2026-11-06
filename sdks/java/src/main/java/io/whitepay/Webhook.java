package io.whitepay;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Verifies X-WhitePay-Signature headers. Always pass the RAW request body, never re-serialized JSON. */
public final class Webhook {
  private Webhook() {}

  public static Map<String, Object> verify(String rawBody, String header, String secret) {
    return verify(rawBody, header, secret, 300, System.currentTimeMillis() / 1000);
  }

  /** Returns the parsed event, or throws WhitePayException(code = "invalid_signature"). Any matching v1 is accepted (secret rotation). */
  public static Map<String, Object> verify(String rawBody, String header, String secret, long toleranceSec, long now) {
    Long ts = null;
    java.util.List<String> sigs = new java.util.ArrayList<>();
    for (String part : (header == null ? "" : header).split(",")) {
      String[] kv = part.trim().split("=", 2);
      if (kv.length != 2) continue;
      if (kv[0].equals("t") && kv[1].matches("\\d+")) ts = Long.parseLong(kv[1]);
      if (kv[0].equals("v1")) sigs.add(kv[1]);
    }
    if (ts == null) throw bad("Missing timestamp");
    if (Math.abs(now - ts) > toleranceSec) throw bad("Timestamp outside tolerance");
    byte[] expected;
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
      expected = mac.doFinal((ts + "." + rawBody).getBytes(StandardCharsets.UTF_8));
    } catch (java.security.GeneralSecurityException e) {
      throw new IllegalStateException(e);
    }
    for (String s : sigs) {
      if (!s.matches("[0-9a-f]{64}")) continue;
      if (MessageDigest.isEqual(HexFormat.of().parseHex(s), expected)) return Json.obj(Json.parse(rawBody)); // constant-time
    }
    throw bad("No matching signature");
  }

  private static WhitePayException bad(String m) { return new WhitePayException(400, "invalid_signature", m); }
}
