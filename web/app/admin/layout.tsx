import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Logo, Badge } from "@/components/ui";
import { SignOut } from "@/components/SideNav";

export const metadata: Metadata = { title: { default: "Operator console", template: "%s · WhitePay operator" }, robots: { index: false } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const signedIn = !!(await cookies()).get("wp_admin");
  return (
    <>
      <header className="site-header">
        <div className="container" style={{ maxWidth: 1240 }}>
          <div className="row" style={{ alignItems: "center", gap: 12 }}><Logo href="/admin" /><Badge tone="warn">Operator</Badge></div>
          {signedIn ? <SignOut to="/admin/login" /> : null}
        </div>
      </header>
      <main className="container" style={{ maxWidth: 1240, padding: "28px 20px 60px" }}>{children}</main>
    </>
  );
}
