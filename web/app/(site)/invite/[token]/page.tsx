import type { Metadata } from "next";
import { api } from "@/lib/api";
import { AcceptForm } from "./AcceptForm";

export const metadata: Metadata = { title: "Join your team" };

type Invite = { email: string; role: string; roleLabel: string; business: string; hasAccount: boolean };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await api<Invite>(`/api/account/invite/${token}`);
  if (!r.ok) {
    return (
      <div className="auth-page"><div className="auth-card" style={{ textAlign: "center" }}>
        <h1>This invitation has expired</h1>
        <p className="mut">Ask the person who invited you to send a new one.</p>
        <a className="btn" href="/login">Sign in</a>
      </div></div>
    );
  }
  const i = r.data;
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Join {i.business}</h1>
        <p className="mut">You've been invited as <b>{i.roleLabel}</b>. {i.hasAccount ? "You already have a WhitePay account with this email: enter its password to join." : "Choose how you'll sign in."}</p>
        <AcceptForm token={token} email={i.email} hasAccount={i.hasAccount} />
      </div>
    </div>
  );
}
