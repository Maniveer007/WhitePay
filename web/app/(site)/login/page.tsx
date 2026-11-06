import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAccount } from "@/lib/session";
import { api } from "@/lib/api";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; reset?: string }> }) {
  const sp = await searchParams;
  if (!sp.error && (await currentAccount())) redirect("/console");
  const info = await api<{ demo: { email: string; password: string } | null }>("/api/account/info");
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Sign in</h1>
        <p className="mut">Welcome back. Use the email and password for your account.</p>
        {sp.error ? <div className="notice warn">You were signed out. Please sign in again.</div> : null}
        {sp.reset ? <div className="notice ok">Your password was changed. Sign in with the new one.</div> : null}
        <LoginForm next={sp.next?.startsWith("/console") ? sp.next : "/console"} demo={info.ok ? info.data.demo : null} />
        <p className="mut small" style={{ marginTop: 16 }}>New to WhitePay? <a href="/signup">Create an account</a></p>
      </div>
    </div>
  );
}
