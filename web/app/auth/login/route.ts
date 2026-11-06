import { NextResponse } from "next/server";
import { api } from "@/lib/api";
import { SESSION_COOKIE, cookieOptions } from "@/lib/session";
import { sameOrigin, forwardedFor } from "@/lib/origin";

// Email + password (+ authenticator code when the person has two-factor on). On success the session token goes into an httpOnly cookie.
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: { code: "forbidden", message: "Cross-site request refused" } }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const r = await api<{ token?: string; needs2fa?: boolean; user?: { name: string } }>("/api/account/login", { method: "POST", body, headers: forwardedFor(req) });
  if (!r.ok) return NextResponse.json({ error: { code: r.code, message: r.message } }, { status: r.status });
  if (r.data.needs2fa) return NextResponse.json({ needs2fa: true });
  const res = NextResponse.json({ ok: true, name: r.data.user?.name });
  res.cookies.set(SESSION_COOKIE, r.data.token!, cookieOptions(60 * 60 * 24 * 30));
  return res;
}
