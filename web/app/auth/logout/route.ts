import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { api } from "@/lib/api";
import { SESSION_COOKIE, ADMIN_COOKIE } from "@/lib/session";

// Ends the session on the server too (so a copied token stops working), then clears the cookies.
export async function POST() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await api("/api/account/logout", { method: "POST", key: token, body: {} });
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  res.cookies.delete(ADMIN_COOKIE);
  return res;
}
