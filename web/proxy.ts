import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { LANG_COOKIE, isLang } from "@/lib/i18n";

export const LANG_HEADER = "x-wp-lang";

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Cheap gate: no session, no console. The pages and the API still verify the session themselves.
  if (pathname.startsWith("/console") && !req.cookies.get("wp_session")) {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  if (pathname.startsWith("/admin") && !pathname.startsWith("/admin/login") && !req.cookies.get("wp_admin")) {
    return NextResponse.redirect(new URL("/admin/login", req.url));
  }

  // Customer pages: a layout can't read the query string, so ?lang= is passed on as a header (and remembered in a cookie).
  const q = req.nextUrl.searchParams.get("lang")?.toLowerCase().split("-")[0];
  if (q && isLang(q)) {
    const headers = new Headers(req.headers);
    headers.set(LANG_HEADER, q);
    const res = NextResponse.next({ request: { headers } });
    res.cookies.set(LANG_COOKIE, q, { path: "/", maxAge: 31536000, sameSite: "lax" });
    return res;
  }
  return NextResponse.next();
}

export const config = { matcher: ["/console/:path*", "/admin/:path*", "/(pay|invoice|receipt|portal|subscribe|store|widget-demo)(\\.html)?"] };
