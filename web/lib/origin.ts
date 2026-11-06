/** CSRF defence for cookie-authenticated writes: same-site cookies plus an Origin check. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser clients (curl, tests) send no Origin; they can't ride a victim's cookie
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try { return new URL(origin).host === host; } catch { return false; }
}

/** Pass the visitor's address on to the API so its per-IP rate limits (signup, checkout) see the visitor, not this server. */
export function forwardedFor(req: Request): Record<string, string> {
  const xff = req.headers.get("x-forwarded-for");
  return xff ? { "x-forwarded-for": xff } : {};
}
