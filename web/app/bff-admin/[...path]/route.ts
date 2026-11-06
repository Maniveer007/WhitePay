import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { API_ORIGIN } from "@/lib/api";
import { ADMIN_COOKIE } from "@/lib/session";
import { sameOrigin } from "@/lib/origin";

// Same idea for the operator console, limited to /api/platform/*.
async function forward(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (!["GET", "HEAD"].includes(req.method) && !sameOrigin(req)) return NextResponse.json({ error: { code: "forbidden", message: "Cross-site request refused" } }, { status: 403 });
  const key = (await cookies()).get(ADMIN_COOKIE)?.value;
  if (!key) return NextResponse.json({ error: { code: "unauthorized", message: "Please sign in again" } }, { status: 401 });
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await req.text();
  const up = await fetch(`${API_ORIGIN}/api/platform/${path.join("/")}${new URL(req.url).search}`, {
    method: req.method, cache: "no-store", body, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  }).catch(() => null);
  if (!up) return NextResponse.json({ error: { code: "api_unreachable", message: "The WhitePay API is not reachable right now." } }, { status: 503 });
  return new Response(up.body, { status: up.status, headers: { "content-type": up.headers.get("content-type") ?? "application/json" } });
}
export { forward as GET, forward as POST };
