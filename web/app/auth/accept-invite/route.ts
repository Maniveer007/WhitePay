import { NextResponse } from "next/server";
import { api } from "@/lib/api";
import { SESSION_COOKIE, cookieOptions } from "@/lib/session";
import { sameOrigin, forwardedFor } from "@/lib/origin";

// Join a business from an invitation link (new people set a password; existing accounts confirm theirs) and sign in.
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: { code: "forbidden", message: "Cross-site request refused" } }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const r = await api<{ token: string }>("/api/account/invite/accept", { method: "POST", body, headers: forwardedFor(req) });
  if (!r.ok) return NextResponse.json({ error: { code: r.code, message: r.message } }, { status: r.status });
  const res = NextResponse.json({ ok: true }, { status: 201 });
  res.cookies.set(SESSION_COOKIE, r.data.token, cookieOptions(60 * 60 * 24 * 30));
  return res;
}
