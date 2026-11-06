"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { bff, useAction } from "@/lib/client";
import { FlashNotice } from "@/components/Flash";
import { PasswordField } from "@/components/PasswordField";
import { Card, Table, Badge, Notice } from "@/components/ui";
import { when } from "@/lib/format";

type User = { name: string; email: string; twoFactor: boolean; emailVerified: boolean };
type Sess = { id: string; createdAt: number; lastSeen: number; ip: string | null; device: string | null; current: boolean };

const deviceName = (ua: string | null) => (!ua ? "Unknown device" : /iPhone|iPad/.test(ua) ? "iPhone / iPad" : /Android/.test(ua) ? "Android" : /Mac OS/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows PC" : /Linux/.test(ua) ? "Linux" : /curl|node/i.test(ua) ? "Script" : "Browser");

export function SecurityPanels({ user, sessions }: { user: User; sessions: Sess[] }) {
  return (
    <>
      <ProfileCard user={user} />
      <PasswordCard />
      <TwoFactorCard enabled={user.twoFactor} />
      <SessionsCard sessions={sessions} />
    </>
  );
}

function ProfileCard({ user }: { user: User }) {
  const router = useRouter();
  const { pending, flash, run } = useAction();
  return (
    <Card title="Your details">
      <form className="row" onSubmit={async (e) => { e.preventDefault(); const name = String(new FormData(e.currentTarget).get("name")); if (await run(() => bff("account/profile", { body: { name } }), "Saved")) router.refresh(); }}>
        <div className="field"><label htmlFor="pname">Name</label><input id="pname" name="name" defaultValue={user.name} required minLength={2} /></div>
        <div className="field"><label>Email</label><input value={user.email} disabled /><div className="hint">{user.emailVerified ? "Confirmed" : "Not confirmed yet"}</div></div>
        <button className="btn" disabled={pending}>Save</button>
      </form>
      <FlashNotice flash={flash} />
    </Card>
  );
}

function PasswordCard() {
  const { pending, flash, run } = useAction();
  return (
    <Card title="Change password" subtitle="Changing it signs you out of every other device.">
      <form className="stack" style={{ maxWidth: 420 }} onSubmit={async (e) => {
        e.preventDefault(); const f = new FormData(e.currentTarget), form = e.currentTarget;
        if (await run(() => bff("account/password", { body: { current: f.get("current"), password: f.get("password") } }), "Password changed. Other devices were signed out.")) form.reset();
      }}>
        <div className="field"><label htmlFor="current">Current password</label><input id="current" name="current" type="password" required autoComplete="current-password" /></div>
        <PasswordField label="New password" />
        <FlashNotice flash={flash} />
        <div><button className="btn" disabled={pending}>Change password</button></div>
      </form>
    </Card>
  );
}

function TwoFactorCard({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const { pending, flash, run } = useAction();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  return (
    <Card title="Two-step sign-in" subtitle="Asks for a code from an authenticator app (Google Authenticator, 1Password, Authy…) as well as your password. Strongly recommended for anyone who can move money.">
      {enabled ? <p><Badge tone="ok">On</Badge></p> : <p><Badge tone="warn">Off</Badge></p>}
      {codes ? (
        <Notice kind="warn">
          <b>Save your recovery codes now.</b> Each works once if you lose your phone. They won't be shown again.
          <div className="mono" style={{ marginTop: 8, columns: 2 }}>{codes.map((c) => <div key={c}>{c}</div>)}</div>
        </Notice>
      ) : null}
      {!enabled && !setup ? (
        <button className="btn" disabled={pending} onClick={async () => {
          const r = await run(() => bff("account/2fa/setup", { body: {} }));
          if (r) setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauth, { margin: 1, width: 180 }) });
        }}>Set up two-step sign-in</button>
      ) : null}
      {!enabled && setup ? (
        <form className="stack" style={{ maxWidth: 420 }} onSubmit={async (e) => {
          e.preventDefault(); const code = String(new FormData(e.currentTarget).get("code"));
          const r = await run(() => bff("account/2fa/enable", { body: { code } }));
          if (r) { setCodes(r.recoveryCodes); setSetup(null); router.refresh(); }
        }}>
          <p className="small" style={{ margin: 0 }}>1. Scan this with your authenticator app, or type the key in.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} style={{ background: "#fff", borderRadius: 8 }} />
          <div className="copy-box mono">{setup.secret}</div>
          <div className="field"><label htmlFor="code">2. Enter the 6-digit code it shows</label><input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" required /></div>
          <div className="row" style={{ gap: 8 }}><button className="btn" disabled={pending}>Turn on</button><button type="button" className="btn ghost" onClick={() => setSetup(null)}>Cancel</button></div>
        </form>
      ) : null}
      {enabled ? (
        <form className="row" style={{ maxWidth: 520 }} onSubmit={async (e) => {
          e.preventDefault(); const password = String(new FormData(e.currentTarget).get("password"));
          if (confirm("Turn two-step sign-in off? Your account will be easier to break into.") && await run(() => bff("account/2fa/disable", { body: { password } }), "Turned off")) router.refresh();
        }}>
          <div className="field"><label htmlFor="dpw">Password (to turn it off)</label><input id="dpw" name="password" type="password" required autoComplete="current-password" /></div>
          <button className="btn secondary" disabled={pending}>Turn off</button>
        </form>
      ) : null}
      <FlashNotice flash={flash} />
    </Card>
  );
}

function SessionsCard({ sessions }: { sessions: Sess[] }) {
  const router = useRouter();
  const { flash, run } = useAction();
  return (
    <Card title="Where you're signed in" actions={sessions.length > 1 ? <button className="btn secondary sm" onClick={async () => { if (await run(() => bff("account/sessions/revoke", { body: { all: true } }), "Signed out everywhere else")) router.refresh(); }}>Sign out everywhere else</button> : undefined}>
      <Table head={["Device", "Network address", "Signed in", "Last active", ""]}>
        {sessions.map((s) => (
          <tr key={s.id}><td>{deviceName(s.device)} {s.current ? <Badge tone="ok">this device</Badge> : null}</td><td className="mono">{s.ip ?? "—"}</td><td className="small nowrap">{when(s.createdAt)}</td><td className="small nowrap">{when(s.lastSeen)}</td>
            <td>{!s.current ? <button className="btn ghost sm" onClick={async () => { if (await run(() => bff("account/sessions/revoke", { body: { id: s.id } }))) router.refresh(); }}>Sign out</button> : null}</td></tr>
        ))}
      </Table>
      <FlashNotice flash={flash} />
    </Card>
  );
}
