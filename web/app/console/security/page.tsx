import type { Metadata } from "next";
import { requireAccount } from "@/lib/session";
import { getJson } from "@/lib/data";
import { PageHeader } from "@/components/ui";
import { SecurityPanels } from "./SecurityPanels";

export const metadata: Metadata = { title: "My security" };

export default async function SecurityPage() {
  const a = await requireAccount();
  const sessions = await getJson<{ id: string; createdAt: number; lastSeen: number; ip: string | null; device: string | null; current: boolean }[]>("/api/account/sessions");
  return (
    <>
      <PageHeader title="My security" subtitle={`${a.user.name} · ${a.user.email}`} />
      <SecurityPanels user={a.user} sessions={sessions.data ?? []} />
    </>
  );
}
