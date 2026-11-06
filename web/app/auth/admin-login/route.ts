import { NextResponse } from "next/server";
import { api } from "@/lib/api";
import { ADMIN_COOKIE, cookieOptions } from "@/lib/session";
import { sameOrigin } from "@/lib/origin";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: { code: "forbidden", message: "Cross-site request refused" } }, { status: 403 });
  const { key } = (await req.json().catch(() => ({}))) as { key?: string };
  if (!key) return NextResponse.json({ error: { code: "invalid_key", message: "Enter the platform key" } }, { status: 400 });
  const r = await api("/api/platform/overview", { key: key.trim() });
  if (!r.ok) return NextResponse.json({ error: { code: r.code, message: r.status === 401 ? "That platform key is not valid" : r.message } }, { status: r.status });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, key.trim(), cookieOptions(60 * 60 * 8)); // operator sessions are short
  return res;
}
