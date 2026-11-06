import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { API_ORIGIN } from "@/lib/api";
import { SESSION_COOKIE } from "@/lib/session";
import { sameOrigin } from "@/lib/origin";

// Browser -> this route -> API. The route attaches the merchant's key from the httpOnly cookie, so client components can
// call the API without ever holding the key. Binary responses (Excel/PDF statements) are streamed through unchanged.
async function forward(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (path[0] === "platform") return NextResponse.json({ error: { code: "forbidden", message: "Not available here" } }, { status: 403 });
  if (!["GET", "HEAD"].includes(req.method) && !sameOrigin(req)) return NextResponse.json({ error: { code: "forbidden", message: "Cross-site request refused" } }, { status: 403 });
  const key = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!key) return NextResponse.json({ error: { code: "unauthorized", message: "Please sign in again" } }, { status: 401 });
  const search = new URL(req.url).search;
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await req.text();
  const up = await fetch(`${API_ORIGIN}/api/${path.join("/")}${search}`, {
    method: req.method, cache: "no-store", body,
    headers: { authorization: `Bearer ${key}`, "content-type": req.headers.get("content-type") ?? "application/json" },
  }).catch(() => null);
  if (!up) return NextResponse.json({ error: { code: "api_unreachable", message: "The WhitePay API is not reachable right now." } }, { status: 503 });
  const headers = new Headers();
  for (const h of ["content-type", "content-disposition"]) { const v = up.headers.get(h); if (v) headers.set(h, v); }
  return new Response(up.body, { status: up.status, headers });
}
export { forward as GET, forward as POST, forward as PUT, forward as DELETE };
