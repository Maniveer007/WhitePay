import { AdminLogin } from "./AdminLogin";

export default function Page() {
  return (
    <div className="auth-page" style={{ minHeight: "60vh" }}>
      <div className="auth-card">
        <h1>Operator sign in</h1>
        <p className="mut">For the people who run this WhitePay deployment. Use the platform key (<code>PLATFORM_KEY</code>). Sessions last 8 hours.</p>
        <AdminLogin />
      </div>
    </div>
  );
}
