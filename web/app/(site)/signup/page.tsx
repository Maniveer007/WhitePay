import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAccount } from "@/lib/session";
import { api } from "@/lib/api";
import { SignupForm } from "./SignupForm";

export const metadata: Metadata = { title: "Create your account" };

export default async function Signup() {
  if (await currentAccount()) redirect("/console"); // only for a session the API still accepts; a stale cookie must not block signup
  const info = await api<{ signupOpen: boolean }>("/api/account/info");
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Create your account</h1>
        <p className="mut">Start accepting payments in USDT. You keep custody of your money, and you can invite your team.</p>
        {info.ok && !info.data.signupOpen ? (
          <div className="notice warn">Sign-up is closed on this server. <a href="/login">Sign in</a> if you already have an account.</div>
        ) : (
          <SignupForm />
        )}
        <p className="mut small" style={{ marginTop: 16 }}>Already have an account? <a href="/login">Sign in</a></p>
      </div>
    </div>
  );
}
