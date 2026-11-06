"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { bff } from "@/lib/client";
import { when } from "@/lib/format";
import { Card, Table, Badge, Notice } from "@/components/ui";

export type TeamData = {
  members: { id: string; name: string; email: string; role: string; emailVerified: boolean; twoFactor: boolean; lastLogin: number | null }[];
  invites: { id: number; email: string; role: string; sentAt: number; expiresAt: number }[];
  roles: { id: string; label: string; help: string }[];
};

export function TeamManager({ data, me, myRole }: { data: TeamData; me: string; myRole: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState("finance");
  const [link, setLink] = useState<string | null>(null);
  const label = (id: string) => data.roles.find((r) => r.id === id)?.label ?? id;
  const assignable = data.roles.filter((r) => r.id !== "owner" || myRole === "owner");

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: "ok", text: ok }); router.refresh(); } catch (e: any) { setMsg({ kind: "bad", text: e.message }); } finally { setBusy(false); }
  }
  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget), email = String(f.get("email"));
    setLink(null);
    await act(async () => { const r = await bff<{ link: string }>("team/invite", { body: { email, role } }); setLink(r.link); }, `Invitation created for ${email}. Share the link below (it works for 7 days); we also try to email it.`);
    (e.target as HTMLFormElement).reset();
  }
  return (
    <>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      {link ? <Notice kind="ok">Invitation link: <span className="mono">{link}</span> <button className="btn secondary sm" onClick={() => navigator.clipboard.writeText(link)}>Copy</button></Notice> : null}
      <Card title="People">
        <Table head={["Person", "Role", "Security", "Last sign-in", ""]}>
          {data.members.map((m) => (
            <tr key={m.id}>
              <td><b>{m.name}</b>{m.id === me ? " (you)" : ""}<div className="mut small">{m.email}</div></td>
              <td>
                <select aria-label={`Role for ${m.name}`} value={m.role} disabled={busy || m.id === me} style={{ width: 170 }}
                  onChange={(e) => act(() => bff("team/role", { body: { userId: m.id, role: e.target.value } }), `${m.name} is now ${label(e.target.value)}. They were signed out so the change applies at once.`)}>
                  {data.roles.map((r) => <option key={r.id} value={r.id} disabled={r.id === "owner" && myRole !== "owner"}>{r.label}</option>)}
                </select>
              </td>
              <td className="small">{m.twoFactor ? <Badge tone="ok">2-step on</Badge> : <Badge>2-step off</Badge>} {!m.emailVerified ? <Badge tone="warn">email not confirmed</Badge> : null}</td>
              <td className="small nowrap">{m.lastLogin ? when(m.lastLogin) : "Never"}</td>
              <td>{m.id !== me ? <button className="btn ghost sm" disabled={busy} onClick={() => confirm(`Remove ${m.name}? They lose access immediately.`) && act(() => bff("team/remove", { body: { userId: m.id } }), `${m.name} was removed.`)}>Remove</button> : null}</td>
            </tr>
          ))}
        </Table>
      </Card>
      {data.invites.length ? (
        <Card title="Waiting to join">
          <Table head={["Email", "Role", "Sent", "Expires", ""]}>
            {data.invites.map((i) => (
              <tr key={i.id}><td>{i.email}</td><td>{label(i.role)}</td><td className="small">{when(i.sentAt)}</td><td className="small">{when(i.expiresAt)}</td>
                <td><button className="btn ghost sm" disabled={busy} onClick={() => act(() => bff("team/invites/cancel", { body: { id: i.id } }), "Invitation cancelled.")}>Cancel</button></td></tr>
            ))}
          </Table>
        </Card>
      ) : null}
      <Card title="Invite someone" subtitle="They'll get an email. New people choose a password; people who already use WhitePay just join.">
        <form onSubmit={invite}>
          <div className="row">
            <div className="field" style={{ flex: "2 1 260px" }}><label htmlFor="email">Email</label><input id="email" name="email" type="email" required placeholder="colleague@yourbusiness.com" /></div>
            <div className="field"><label htmlFor="role">Role</label><select id="role" value={role} onChange={(e) => setRole(e.target.value)}>{assignable.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></div>
            <button className="btn" disabled={busy}>Send invitation</button>
          </div>
          <p className="hint">{data.roles.find((r) => r.id === role)?.help}</p>
        </form>
      </Card>
      <Card title="What each role can do">
        <Table head={["Role", "Can do"]}>
          {data.roles.map((r) => <tr key={r.id}><td><b>{r.label}</b></td><td>{r.help}</td></tr>)}
        </Table>
      </Card>
    </>
  );
}
