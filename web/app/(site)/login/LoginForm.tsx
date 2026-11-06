"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAction } from "@/lib/client";
import { FlashNotice } from "@/components/Flash";

export function LoginForm({ next, demo }: { next: string; demo: { email: string; password: string } | null }) {
  const router = useRouter();
  const { pending, flash, run } = useAction();
  const [needs2fa, setNeeds2fa] = useState(false);
  const [email, setEmail] = useState(demo?.email ?? "");
  const [password, setPassword] = useState(demo?.password ?? "");
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("totp") ?? "");
    const res = await run(async () => {
      const r = await fetch("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, totp: code || undefined }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message ?? "Could not sign in");
      return j as { needs2fa?: boolean };
    });
    if (!res) return;
    if (res.needs2fa) { setNeeds2fa(true); return; }
    router.push(next); router.refresh();
  }
  return (
    <form className="card stack" onSubmit={submit}>
      {demo ? <div className="notice">Local demo account: <b>{demo.email}</b> (already filled in below).</div> : null}
      <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} disabled={needs2fa} /></div>
      <div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={needs2fa} /></div>
      {needs2fa ? (
        <div className="field"><label htmlFor="totp">Code from your authenticator app</label><input id="totp" name="totp" inputMode="numeric" autoComplete="one-time-code" autoFocus required placeholder="6-digit code, or a recovery code" />
          <div className="hint">Lost your phone? Enter one of your recovery codes instead.</div></div>
      ) : null}
      <FlashNotice flash={flash} />
      <button className="btn lg" disabled={pending} style={{ width: "100%" }}>{pending ? "Signing in…" : needs2fa ? "Verify and sign in" : "Sign in"}</button>
      <p className="hint" style={{ margin: 0 }}><a href="/forgot-password">Forgot your password?</a></p>
    </form>
  );
}
