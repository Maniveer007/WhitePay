package io.whitepay;

/** Every API error. {@code code} is stable and machine-readable (see openapi.json). */
public class WhitePayException extends RuntimeException {
  private static final long serialVersionUID = 1L;
  public final int status;
  public final String code;

  public WhitePayException(int status, String code, String message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
