import type { Metadata } from "next";
import { requireAccount } from "@/lib/session";
import { api } from "@/lib/api";
import { Logo, Badge } from "@/components/ui";
import { SideNav, SignOut, BusinessSwitcher, type NavGroup } from "@/components/SideNav";
import { GoLive } from "@/components/GoLive";
import { VerifyBanner } from "@/components/VerifyBanner";
import { NetworkBadge } from "@/components/NetworkBadge";

export const metadata: Metadata = { title: { default: "Console", template: "%s · WhitePay" }, robots: { index: false } };

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const a = await requireAccount();
  const has = (area: keyof typeof a.access) => !!a.access[area];
  const live = a.merchant.status === "active";
  const usage = live ? await api<{ plan: { name: string } }>("/api/saas/usage", { key: a.token }) : null;
  // Each entry: the area a person needs access to, where it goes, and its label. People only see what their role allows.
  const section = (title: string | undefined, entries: [keyof typeof a.access, string, string][]): NavGroup => ({
    title, items: entries.filter(([area]) => has(area)).map(([, href, label]): [string, string] => [href, label]),
  });
  const home: NavGroup = { items: [["/console", "Home"]] };
  const groups: NavGroup[] = [
    home,
    section("Sell", [["payments", "/console/payments", "Payments"], ["invoices", "/console/invoices", "Invoices"], ["subscriptions", "/console/subscriptions", "Subscriptions"], ["refunds", "/console/refunds", "Refunds"], ["customers", "/console/customers", "Customers"]]),
    section("Money", [["finance", "/console/finance", "Reports & accounting"], ["ledger", "/console/ledger", "Ledger & checks"], ["marketplace", "/console/marketplace", "Marketplace payouts"]]),
    section("Business", [["settings", "/console/settings", "Business settings"], ["team", "/console/team", "Team"], ["settings", "/console/security", "My security"], ["audit", "/console/activity", "Activity log"], ["billing", "/console/plan", "Plan & billing"]]),
    section("Developers", [["developers", "/console/developers", "API keys & webhooks"]]),
  ].filter((g) => g.items.length);
  const canSetUp = a.access.settings === "w";
  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Console">
        <div style={{ padding: "2px 6px 10px" }}><Logo href="/console" /></div>
        {live ? <SideNav groups={groups} /> : <SideNav groups={[{ items: [["/console/security", "My security"]] }]} />}
        <div className="foot">
          <div style={{ fontWeight: 600 }}>{a.merchant.name}</div>
          <BusinessSwitcher current={a.merchant.uid} businesses={a.businesses} />
          <div className="row" style={{ gap: 6, margin: "6px 0 8px", alignItems: "center" }}>
            <Badge tone="brand">{a.roleLabel}</Badge>
            {usage?.ok ? <Badge>{usage.data.plan.name}</Badge> : null}
            <Badge tone={live ? "ok" : "warn"}>{live ? "Live" : "Setup"}</Badge>
            <NetworkBadge />
          </div>
          <div className="small" style={{ fontWeight: 500 }}>{a.user.name}</div>
          <div className="mut small" style={{ wordBreak: "break-all" }}>{a.user.email}</div>
          <SignOut />
        </div>
      </aside>
      <div className="main">
        {!a.user.emailVerified ? <VerifyBanner email={a.user.email} /> : null}
        {live ? children : canSetUp ? <GoLive me={a.merchant} /> : (
          <div style={{ maxWidth: 560 }}><h1>Almost ready</h1><p className="mut">{a.merchant.name} isn't live yet. The owner needs to connect the payout wallet first. You'll get access as soon as that's done.</p></div>
        )}
      </div>
    </div>
  );
}
