"use client";
import { useState } from "react";
import { bff } from "@/lib/client";

export function VerifyBanner({ email }: { email: string }) {
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div className="notice warn" style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
      <span>Please confirm your email address (<b>{email}</b>). Until then you can't invite people or create API keys.</span>
      {sent ? <span>Sent. Check your inbox.</span> : (
        <button className="btn secondary sm" onClick={() => bff("account/resend-verification", { body: {} }).then(() => setSent(true)).catch((e) => setErr(e.message))}>Resend email</button>
      )}
      {err ? <span>{err}</span> : null}
    </div>
  );
}
