import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { api } from "@/lib/api";
import { SESSION_COOKIE } from "@/lib/session";
import { sameOrigin } from "@/lib/origin";

// Move this session to another business the person belongs to (an accountant with several clients, a consultant).
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: { code: "forbidden", message: "Cross-site request refused" } }, { status: 403 });
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: { code: "unauthorized", message: "Please sign in again" } }, { status: 401 });
  const r = await api("/api/account/switch", { method: "POST", key: token, body: await req.json().catch(() => ({})) });
  return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: { code: r.code, message: r.message } }, { status: r.status });
}
