import type { Metadata } from "next";
import { ResetForm } from "./ResetForm";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Choose a new password</h1>
        {token ? <ResetForm token={token} /> : <div className="notice warn">This link is incomplete. <a href="/forgot-password">Ask for a new one</a>.</div>}
      </div>
    </div>
  );
}
