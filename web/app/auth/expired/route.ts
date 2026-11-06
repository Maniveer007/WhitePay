import { NextResponse } from "next/server";
import { SESSION_COOKIE, ADMIN_COOKIE } from "@/lib/session";

// A page found the saved key is no longer accepted. Clear it here (pages can't set cookies) and send the visitor to sign in.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const admin = url.searchParams.get("to") === "admin";
  const res = NextResponse.redirect(new URL(admin ? "/admin/login?error=session" : "/login?error=session", req.url));
  res.cookies.delete(admin ? ADMIN_COOKIE : SESSION_COOKIE);
  return res;
}
