import type { Metadata } from "next";
import { requireArea } from "@/lib/session";
import { getJson } from "@/lib/data";
import { short } from "@/lib/format";
import { PageHeader, Card, Notice } from "@/components/ui";
import { ProfileForm, NotifyForm } from "./Forms";

export const metadata: Metadata = { title: "Business settings" };

export default async function SettingsPage() {
  const { merchant: m, canWrite, access } = await requireArea("settings");
  const full = await getJson<{ notify?: { email?: string; whatsappTo?: string; slackWebhookUrl?: string; telegramChatId?: string } }>("/api/merchants/me");
  return (
    <>
      <PageHeader title="Business settings" subtitle="How your business appears on invoices and checkout, and who gets alerts." />
      {canWrite ? null : <Notice>Your role ({access.settings === "r" ? "view only" : ""}) can look at these settings. An owner or admin can change them.</Notice>}
      <Card title="Business profile" subtitle="Shown on your invoices, receipts and the checkout page your customers see.">
        <ProfileForm canWrite={canWrite} initial={{ name: m.name, color: m.branding.color ?? "", taxId: m.branding.taxId ?? "", address: m.branding.address ?? "" }} />
      </Card>
      <Card title="Alerts" subtitle="Where we tell you about payments, refund requests and unusual activity. Leave a channel empty to turn it off.">
        <NotifyForm canWrite={canWrite} initial={full.data?.notify ?? {}} />
      </Card>
      <Card title="Your payout wallet" subtitle="Customers' payments go straight to this wallet. WhitePay never holds your money.">
        <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 18px", margin: 0 }}>
          <dt className="mut">Payout wallet</dt><dd className="mono" style={{ margin: 0 }}>{m.payout ?? "—"}</dd>
          <dt className="mut">Owner wallet</dt><dd className="mono" style={{ margin: 0 }}>{m.owner ?? "—"}</dd>
        </dl>
        <p className="hint">Changing the payout wallet waits for a safety delay, so a stolen login can't redirect your money ({short(m.payout)} stays in force meanwhile). Use the Marketplace page to split payouts between several wallets.</p>
      </Card>
    </>
  );
}
