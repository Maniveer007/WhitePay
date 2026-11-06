import type { Metadata } from "next";
import { requireArea } from "@/lib/session";
import { getJson } from "@/lib/data";
import { when } from "@/lib/format";
import { PageHeader, Card, Table, Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Activity log" };

// Plain-language descriptions of what the log records.
const NAMES: Record<string, string> = {
  login: "Signed in", "login.failed": "Wrong password entered", "account.created": "Account created", "password.changed": "Changed their password", "password.reset": "Reset their password via email",
  "2fa.enabled": "Turned on two-step sign-in", "2fa.disabled": "Turned off two-step sign-in", "sessions.revoked": "Signed out other devices",
  "team.invited": "Invited someone", "team.invite_cancelled": "Cancelled an invitation", "team.joined": "Joined the team", "team.role_changed": "Changed someone's role", "team.removed": "Removed someone from the team",
};
function describe(action: string, detail: Record<string, string> | null) {
  if (NAMES[action]) {
    const extra = detail?.email ? ` (${detail.email}${detail.role ? `, ${detail.role}` : ""})` : detail?.user ? ` (${detail.user}${detail.from ? `: ${detail.from} → ${detail.to}` : ""})` : "";
    return NAMES[action] + extra;
  }
  const [method, path] = action.split(" ");
  const what = (path ?? "").replace(/^\/api\//, "").replace(/\/[a-z]{2,}_[\w-]+/g, "").replace(/\//g, " › ");
  return `${method === "POST" ? "Changed" : method === "DELETE" ? "Deleted" : method} ${what}`;
}

export default async function ActivityPage() {
  await requireArea("audit");
  const { data, error } = await getJson<{ id: number; actor: string; action: string; detail: Record<string, string> | null; ip: string | null; ts: number }[]>("/api/audit-log");
  return (
    <>
      <PageHeader title="Activity log" subtitle="Who did what, and when. Sign-ins, team changes, and every change made to the business. Passwords and keys are never recorded." />
      {error ? <Notice kind="bad">{error}</Notice> : null}
      <Card>
        <Table head={["When", "Who", "What", "From"]} empty="Nothing yet.">
          {(data ?? []).map((l) => (
            <tr key={l.id}><td className="small nowrap">{when(l.ts)}</td><td>{l.actor}</td><td>{describe(l.action, l.detail)}</td><td className="mono">{l.ip ?? "—"}</td></tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
