import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { api } from "./api";

export const SESSION_COOKIE = "wp_session"; // holds a sign-in session token (wps_…), never an API key
export const ADMIN_COOKIE = "wp_admin";

export const cookieOptions = (maxAge: number) => ({
  httpOnly: true, sameSite: "strict" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge,
});

export async function getToken() { return (await cookies()).get(SESSION_COOKIE)?.value ?? null; }
export async function getAdminKey() { return (await cookies()).get(ADMIN_COOKIE)?.value ?? null; }

export type Area = "payments" | "invoices" | "subscriptions" | "refunds" | "finance" | "ledger" | "marketplace" | "customers" | "developers" | "settings" | "team" | "billing" | "audit";
export type Level = "w" | "r" | "";
export type Role = "owner" | "admin" | "finance" | "support" | "developer" | "viewer";

export type Me = {
  uid: string; merchantId: number | null; name: string; status: "pending" | "active"; apiKeyHint: string | null; signerAddress: string;
  owner: string | null; payout: string | null; webhookUrl: string | null; branding: { name: string; color: string | null; taxId: string; address: string };
  nextStep?: { contract: string; call: string; args: string[] };
};
export type Account = {
  user: { id: string; email: string; name: string; emailVerified: boolean; twoFactor: boolean };
  role: Role; roleLabel: string; access: Record<Area, Level>; merchant: Me; businesses: { uid: string; name: string; role: Role }[];
};

/** The signed-in person with their business, or null (never redirects: for pages that also work signed out). */
export async function currentAccount(): Promise<(Account & { token: string }) | null> {
  const token = await getToken();
  if (!token) return null;
  const r = await api<Account>("/api/account/me", { key: token });
  return r.ok ? { ...r.data, token } : null;
}

/** The signed-in person, or a redirect. A session the API rejects (signed out elsewhere, role changed, password reset) clears the cookie via
 *  /auth/expired instead of looping; an API outage shows the error page instead of signing everyone out. */
export async function requireAccount() {
  const token = await getToken();
  if (!token) redirect("/login");
  const r = await api<Account>("/api/account/me", { key: token });
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) redirect("/auth/expired");
    throw new Error(r.message);
  }
  return { ...r.data, token };
}

/** Like requireAccount, but also checks the person's role may open this part of the console. */
export async function requireArea(area: Area) {
  const a = await requireAccount();
  if (!a.access[area]) redirect(`/console?denied=${area}`);
  return { ...a, canWrite: a.access[area] === "w" };
}

export async function requireAdmin() {
  const key = await getAdminKey();
  if (!key) redirect("/admin/login");
  return key;
}
