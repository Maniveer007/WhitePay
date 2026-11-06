package io.whitepay;

import java.util.*;

/** Minimal JSON (RFC 8259) reader/writer so the SDK has no dependencies. Objects → LinkedHashMap, arrays → ArrayList, numbers → Long or Double. */
public final class Json {
  private final String s;
  private int i;

  private Json(String s) { this.s = s; }

  public static Object parse(String text) {
    Json p = new Json(text);
    p.ws();
    Object v = p.value();
    p.ws();
    if (p.i != p.s.length()) throw new IllegalArgumentException("Trailing data at " + p.i);
    return v;
  }

  @SuppressWarnings("unchecked")
  public static Map<String, Object> obj(Object o) { return (Map<String, Object>) o; }

  @SuppressWarnings("unchecked")
  public static List<Object> arr(Object o) { return (List<Object>) o; }

  private void ws() { while (i < s.length() && " \t\r\n".indexOf(s.charAt(i)) >= 0) i++; }

  private Object value() {
    if (i >= s.length()) throw new IllegalArgumentException("Unexpected end");
    char c = s.charAt(i);
    switch (c) {
      case '{': return object();
      case '[': return array();
      case '"': return string();
      case 't': return lit("true", Boolean.TRUE);
      case 'f': return lit("false", Boolean.FALSE);
      case 'n': return lit("null", null);
      default: return number();
    }
  }

  private Object lit(String w, Object v) {
    if (!s.startsWith(w, i)) throw new IllegalArgumentException("Bad literal at " + i);
    i += w.length();
    return v;
  }

  private Map<String, Object> object() {
    Map<String, Object> m = new LinkedHashMap<>();
    i++; ws();
    if (s.charAt(i) == '}') { i++; return m; }
    while (true) {
      ws(); String k = string(); ws();
      if (s.charAt(i++) != ':') throw new IllegalArgumentException("Expected ':' at " + (i - 1));
      ws(); m.put(k, value()); ws();
      char c = s.charAt(i++);
      if (c == '}') return m;
      if (c != ',') throw new IllegalArgumentException("Expected ',' at " + (i - 1));
    }
  }

  private List<Object> array() {
    List<Object> a = new ArrayList<>();
    i++; ws();
    if (s.charAt(i) == ']') { i++; return a; }
    while (true) {
      ws(); a.add(value()); ws();
      char c = s.charAt(i++);
      if (c == ']') return a;
      if (c != ',') throw new IllegalArgumentException("Expected ',' at " + (i - 1));
    }
  }

  private String string() {
    if (s.charAt(i) != '"') throw new IllegalArgumentException("Expected string at " + i);
    StringBuilder b = new StringBuilder();
    i++;
    while (true) {
      char c = s.charAt(i++);
      if (c == '"') return b.toString();
      if (c != '\\') { b.append(c); continue; }
      char e = s.charAt(i++);
      switch (e) {
        case 'n': b.append('\n'); break;
        case 't': b.append('\t'); break;
        case 'r': b.append('\r'); break;
        case 'b': b.append('\b'); break;
        case 'f': b.append('\f'); break;
        case 'u': b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
        default: b.append(e);
      }
    }
  }

  private Object number() {
    int st = i;
    while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
    String n = s.substring(st, i);
    if (n.isEmpty()) throw new IllegalArgumentException("Unexpected character at " + st);
    return n.matches("-?\\d+") ? (Object) Long.parseLong(n) : (Object) Double.parseDouble(n);
  }

  public static String write(Object v) {
    StringBuilder b = new StringBuilder();
    write(b, v);
    return b.toString();
  }

  private static void write(StringBuilder b, Object v) {
    if (v == null) b.append("null");
    else if (v instanceof String) {
      b.append('"');
      for (char c : ((String) v).toCharArray()) {
        if (c == '"' || c == '\\') b.append('\\').append(c);
        else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
        else b.append(c);
      }
      b.append('"');
    } else if (v instanceof Number || v instanceof Boolean) b.append(v);
    else if (v instanceof Map) {
      b.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
        if (!first) b.append(',');
        first = false;
        write(b, String.valueOf(e.getKey()));
        b.append(':');
        write(b, e.getValue());
      }
      b.append('}');
    } else if (v instanceof Collection) {
      b.append('[');
      boolean first = true;
      for (Object o : (Collection<?>) v) { if (!first) b.append(','); first = false; write(b, o); }
      b.append(']');
    } else throw new IllegalArgumentException("Can't serialize " + v.getClass());
  }
}
