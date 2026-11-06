import { NextResponse } from "next/server";
import { api } from "@/lib/api";
import { sameOrigin, forwardedFor } from "@/lib/origin";

// The few account actions that work without being signed in: forgot/reset password, confirm email, look up an invitation.
const POST_OK = new Set(["forgot", "reset", "verify-email"]);
const GET_OK = /^(info|invite\/[\w-]+)$/;

export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join("/");
  if (!POST_OK.has(path)) return NextResponse.json({ error: { code: "not_found", message: "Unknown action" } }, { status: 404 });
  if (!sameOrigin(req)) return NextResponse.json({ error: { code: "forbidden", message: "Cross-site request refused" } }, { status: 403 });
  const r = await api(`/api/account/${path}`, { method: "POST", body: await req.json().catch(() => ({})), headers: forwardedFor(req) });
  return r.ok ? NextResponse.json(r.data) : NextResponse.json({ error: { code: r.code, message: r.message } }, { status: r.status });
}
export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join("/");
  if (!GET_OK.test(path)) return NextResponse.json({ error: { code: "not_found", message: "Unknown action" } }, { status: 404 });
  const r = await api(`/api/account/${path}`);
  return r.ok ? NextResponse.json(r.data) : NextResponse.json({ error: { code: r.code, message: r.message } }, { status: r.status });
}
