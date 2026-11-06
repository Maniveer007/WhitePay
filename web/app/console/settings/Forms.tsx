"use client";
import { useRouter } from "next/navigation";
import { bff, useAction } from "@/lib/client";
import { FlashNotice } from "@/components/Flash";

export function ProfileForm({ canWrite, initial }: { canWrite: boolean; initial: { name: string; color: string; taxId: string; address: string } }) {
  const router = useRouter();
  const { pending, flash, run } = useAction();
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    if (await run(() => bff("merchants/me", { body: { name: f.get("name"), color: f.get("color"), taxId: f.get("taxId"), address: f.get("address") } }), "Saved")) router.refresh();
  }
  return (
    <form onSubmit={submit} className="stack">
      <div className="row">
        <div className="field"><label htmlFor="name">Business name</label><input id="name" name="name" defaultValue={initial.name} required disabled={!canWrite} /></div>
        <div className="field" style={{ maxWidth: 160 }}><label htmlFor="color">Brand colour</label><input id="color" name="color" type="color" defaultValue={initial.color || "#3b4cf0"} disabled={!canWrite} style={{ padding: 4, height: 40 }} /></div>
      </div>
      <div className="row">
        <div className="field"><label htmlFor="taxId">Tax ID (GSTIN / VAT)</label><input id="taxId" name="taxId" defaultValue={initial.taxId} disabled={!canWrite} /><div className="hint">Printed on invoices.</div></div>
        <div className="field" style={{ flex: "2 1 300px" }}><label htmlFor="address">Business address</label><input id="address" name="address" defaultValue={initial.address} disabled={!canWrite} /></div>
      </div>
      <FlashNotice flash={flash} />
      {canWrite ? <div><button className="btn" disabled={pending}>{pending ? "Saving…" : "Save changes"}</button></div> : null}
    </form>
  );
}

export function NotifyForm({ canWrite, initial }: { canWrite: boolean; initial: { email?: string; whatsappTo?: string; slackWebhookUrl?: string; telegramChatId?: string } }) {
  const router = useRouter();
  const { pending, flash, run } = useAction();
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget), v = (k: string) => String(f.get(k) ?? "").trim() || undefined;
    if (await run(() => bff("merchants/me", { body: { notify: { email: v("email"), whatsappTo: v("whatsappTo"), slackWebhookUrl: v("slack"), telegramChatId: v("telegram") } } }), "Alert settings saved")) router.refresh();
  }
  return (
    <form onSubmit={submit} className="stack">
      <div className="row">
        <div className="field"><label htmlFor="email">Email address</label><input id="email" name="email" type="email" defaultValue={initial.email ?? ""} disabled={!canWrite} placeholder="payments@yourbusiness.com" /></div>
        <div className="field"><label htmlFor="whatsappTo">WhatsApp number</label><input id="whatsappTo" name="whatsappTo" defaultValue={initial.whatsappTo ?? ""} disabled={!canWrite} placeholder="+919812345678" /></div>
      </div>
      <div className="row">
        <div className="field"><label htmlFor="slack">Slack (incoming webhook URL)</label><input id="slack" name="slack" type="url" defaultValue={initial.slackWebhookUrl ?? ""} disabled={!canWrite} /></div>
        <div className="field"><label htmlFor="telegram">Telegram chat ID</label><input id="telegram" name="telegram" defaultValue={initial.telegramChatId ?? ""} disabled={!canWrite} /></div>
      </div>
      <p className="hint" style={{ margin: 0 }}>You'll hear about: payments ready to fulfil, refund requests, invoices paid, failed subscription renewals, payout wallet changes and unmatched money.</p>
      <FlashNotice flash={flash} />
      {canWrite ? <div><button className="btn" disabled={pending}>{pending ? "Saving…" : "Save alerts"}</button></div> : null}
    </form>
  );
}
