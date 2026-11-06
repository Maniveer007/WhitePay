"use client";
import { useState } from "react";

/** Rough strength guide shown while typing. The server is the real check (length, common passwords, no name or email in it). */
export function strength(pw: string): { score: number; label: string } {
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 14) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return { score, label: pw.length < 10 ? "Too short" : score <= 2 ? "Fair" : score === 3 ? "Good" : "Strong" };
}

export function PasswordField({ id = "password", name = "password", label = "Password", autoComplete = "new-password", showMeter = true, hint }: { id?: string; name?: string; label?: string; autoComplete?: string; showMeter?: boolean; hint?: string }) {
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const s = strength(pw);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div style={{ position: "relative" }}>
        <input id={id} name={name} type={show ? "text" : "password"} required minLength={10} autoComplete={autoComplete} value={pw} onChange={(e) => setPw(e.target.value)} style={{ paddingInlineEnd: 64 }} />
        <button type="button" className="btn ghost sm" onClick={() => setShow((v) => !v)} style={{ position: "absolute", insetInlineEnd: 4, top: 4 }} aria-label={show ? "Hide password" : "Show password"}>{show ? "Hide" : "Show"}</button>
      </div>
      {showMeter && pw ? (
        <>
          <div className={`meter ${s.score <= 1 ? "full" : ""}`} aria-hidden><i style={{ width: `${Math.max(10, s.score * 20)}%` }} /></div>
          <div className="hint">{s.label}. {hint ?? "Use at least 10 characters. A few random words is a good password."}</div>
        </>
      ) : <div className="hint">{hint ?? "At least 10 characters."}</div>}
    </div>
  );
}
