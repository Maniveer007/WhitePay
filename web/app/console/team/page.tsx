import type { Metadata } from "next";
import { requireArea } from "@/lib/session";
import { getJson } from "@/lib/data";
import { PageHeader, Notice } from "@/components/ui";
import { TeamManager, type TeamData } from "./TeamManager";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage() {
  const a = await requireArea("team");
  const { data, error } = await getJson<TeamData>("/api/team");
  return (
    <>
      <PageHeader title="Team" subtitle="Invite the people who run your business and decide what each can do." />
      {error ? <Notice kind="bad">{error}</Notice> : null}
      {data ? <TeamManager data={data} me={a.user.id} myRole={a.role} /> : null}
    </>
  );
}
