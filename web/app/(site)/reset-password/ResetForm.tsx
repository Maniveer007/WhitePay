"use client";
import { useRouter } from "next/navigation";
import { useAction } from "@/lib/client";
import { FlashNotice } from "@/components/Flash";
import { PasswordField } from "@/components/PasswordField";

export function ResetForm({ token }: { token: string }) {
  const router = useRouter();
  const { pending, flash, run } = useAction();
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password") ?? "");
    const ok = await run(async () => {
      const r = await fetch("/auth/public/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password }) });
      if (!r.ok) throw new Error((await r.json()).error?.message ?? "Could not reset the password");
      return true;
    });
    if (ok) router.push("/login?reset=1");
  }
  return (
    <form className="card stack" onSubmit={submit}>
      <p className="mut small" style={{ margin: 0 }}>You'll be signed out everywhere else once this is saved.</p>
      <PasswordField label="New password" />
      <FlashNotice flash={flash} />
      <button className="btn lg" disabled={pending} style={{ width: "100%" }}>{pending ? "Saving…" : "Save new password"}</button>
    </form>
  );
}
