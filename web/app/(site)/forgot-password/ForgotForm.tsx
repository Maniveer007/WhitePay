"use client";
import { useState } from "react";
import { useAction } from "@/lib/client";
import { FlashNotice } from "@/components/Flash";

export function ForgotForm() {
  const { pending, flash, run } = useAction();
  const [sent, setSent] = useState("");
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "");
    const ok = await run(async () => {
      const r = await fetch("/auth/public/forgot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
      if (!r.ok) throw new Error((await r.json()).error?.message ?? "Something went wrong");
      return true;
    });
    if (ok) setSent(email);
  }
  if (sent) return <div className="notice ok">If there's an account for <b>{sent}</b>, a reset link is on its way. It works for one hour. Check your spam folder if you don't see it.</div>;
  return (
    <form className="card stack" onSubmit={submit}>
      <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" required autoComplete="email" /></div>
      <FlashNotice flash={flash} />
      <button className="btn lg" disabled={pending} style={{ width: "100%" }}>{pending ? "Sending…" : "Send reset link"}</button>
    </form>
  );
}
