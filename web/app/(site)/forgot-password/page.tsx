import type { Metadata } from "next";
import { ForgotForm } from "./ForgotForm";

export const metadata: Metadata = { title: "Reset your password" };

export default function Page() {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Reset your password</h1>
        <p className="mut">Enter your email and we'll send you a link to choose a new password.</p>
        <ForgotForm />
        <p className="mut small" style={{ marginTop: 16 }}><a href="/login">Back to sign in</a></p>
      </div>
    </div>
  );
}
