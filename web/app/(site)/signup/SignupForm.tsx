"use client";
import { useRouter } from "next/navigation";
import { useAction } from "@/lib/client";
import { FlashNotice } from "@/components/Flash";
import { PasswordField } from "@/components/PasswordField";

export function SignupForm() {
  const router = useRouter();
  const { pending, flash, run } = useAction();
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await run(async () => {
      const r = await fetch("/auth/signup", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessName: f.get("businessName"), name: f.get("name"), email: f.get("email"), password: f.get("password") }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message ?? "Could not create the account");
      return true;
    });
    if (ok) { router.push("/console"); router.refresh(); }
  }
  return (
    <form className="card stack" onSubmit={submit}>
      <div className="field"><label htmlFor="businessName">Business name</label><input id="businessName" name="businessName" required minLength={2} maxLength={100} autoComplete="organization" /></div>
      <div className="field"><label htmlFor="name">Your name</label><input id="name" name="name" required minLength={2} maxLength={80} autoComplete="name" /></div>
      <div className="field"><label htmlFor="email">Work email</label><input id="email" name="email" type="email" required autoComplete="email" /></div>
      <PasswordField />
      <FlashNotice flash={flash} />
      <button className="btn lg" disabled={pending} style={{ width: "100%" }}>{pending ? "Creating your account…" : "Create account"}</button>
      <p className="hint" style={{ margin: 0 }}>You'll be the owner of the business and can invite your team afterwards. No technical setup needed to start.</p>
    </form>
  );
}
