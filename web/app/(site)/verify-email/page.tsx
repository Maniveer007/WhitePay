import type { Metadata } from "next";
import { api } from "@/lib/api";

export const metadata: Metadata = { title: "Confirm your email" };

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const r = token ? await api("/api/account/verify-email", { method: "POST", body: { token } }) : null;
  return (
    <div className="auth-page">
      <div className="auth-card" style={{ textAlign: "center" }}>
        {r?.ok ? (
          <>
            <h1>Email confirmed</h1>
            <p className="mut">Thanks. Your email address is verified, so you can invite your team and manage keys.</p>
            <a className="btn" href="/console">Go to the console</a>
          </>
        ) : (
          <>
            <h1>That link didn't work</h1>
            <p className="mut">{r && !r.ok ? r.message : "The link is incomplete."} Sign in and we'll send you a fresh one.</p>
            <a className="btn" href="/login">Sign in</a>
          </>
        )}
      </div>
    </div>
  );
}
