"use client";
import { useRouter } from "next/navigation";
import { useAction } from "@/lib/client";
import { FlashNotice } from "@/components/Flash";
import { PasswordField } from "@/components/PasswordField";

export function AcceptForm({ token, email, hasAccount }: { token: string; email: string; hasAccount: boolean }) {
  const router = useRouter();
  const { pending, flash, run } = useAction();
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await run(async () => {
      const r = await fetch("/auth/accept-invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, name: f.get("name") || undefined, password: f.get("password") }) });
      if (!r.ok) throw new Error((await r.json()).error?.message ?? "Could not join");
      return true;
    });
    if (ok) { router.push("/console"); router.refresh(); }
  }
  return (
    <form className="card stack" onSubmit={submit}>
      <div className="field"><label>Email</label><input value={email} disabled /></div>
      {hasAccount ? null : <div className="field"><label htmlFor="name">Your name</label><input id="name" name="name" required minLength={2} autoComplete="name" /></div>}
      {hasAccount
        ? <div className="field"><label htmlFor="password">Your password</label><input id="password" name="password" type="password" required autoComplete="current-password" /></div>
        : <PasswordField />}
      <FlashNotice flash={flash} />
      <button className="btn lg" disabled={pending} style={{ width: "100%" }}>{pending ? "Joining…" : "Join the team"}</button>
    </form>
  );
}
