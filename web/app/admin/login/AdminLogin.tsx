"use client";
import { useRouter } from "next/navigation";
import { useAction } from "@/lib/client";
import { FlashNotice } from "@/components/Flash";

export function AdminLogin() {
  const router = useRouter();
  const { pending, flash, run } = useAction();
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const key = String(new FormData(e.currentTarget).get("key") ?? "");
    const ok = await run(async () => {
      const r = await fetch("/auth/admin-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message ?? "Could not sign in");
      return true;
    });
    if (ok) { router.push("/admin"); router.refresh(); }
  }
  return (
    <form className="card stack" onSubmit={submit}>
      <div className="field"><label htmlFor="key">Platform key</label><input id="key" name="key" type="password" required autoComplete="current-password" spellCheck={false} /></div>
      <FlashNotice flash={flash} />
      <button className="btn lg" disabled={pending} style={{ width: "100%" }}>{pending ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
