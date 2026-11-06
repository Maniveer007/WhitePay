// Tests people and access against the running testnet stack (`npm run testnet`): accounts, verification, passwords, two-factor, sessions,
// teams, roles (server-enforced), invitations, and the audit log.
const crypto = require("crypto");
const T = require("./../support/testnet");
const API = T.API, DEMO_OWNER = T.OWNER, DEMO_KEY = T.KEY, PLATFORM_KEY = T.PLATFORM; // the first owner of the platform's own business, set up by `npm run testnet`
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok  ", m); };
let ipN = 10;
const call = async (path, { method = "GET", body, token, key, ip } = {}) => {
  const r = await fetch(API + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip || `198.51.100.${ipN++}`,
    ...(token ? { authorization: "Bearer " + token } : key ? { authorization: "Bearer " + key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const mail = async (to, pattern) => {
  for (let i = 0; i < 20; i++) {
    const rows = (await call("/api/dev/mailbox?to=" + encodeURIComponent(to))).body;
    const hit = Array.isArray(rows) && rows.find((r) => pattern.test(r.body));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};
const tokenIn = (m, re) => m.body.match(re)[1];

// RFC 6238 TOTP, written independently of the server's implementation
const b32 = (s) => { let bits = 0, v = 0; const out = []; for (const c of s) { v = (v << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
const totp = (secret, t = Date.now() / 1000) => { const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(t / 30))); const h = crypto.createHmac("sha1", b32(secret)).update(c).digest(), o = h[h.length - 1] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0"); };

(async () => {
  const stamp = Date.now();
  const info = (await call("/api/account/info")).body;
  assert(info.signupOpen && info.roles.length === 6 && info.roles[0].id === "owner", "the sign-up page can learn the roles and whether signup is open");

  // ── Sign up ──
  const email = `amara${stamp}@shop.test`, pw = "Correct-horse-battery-9";
  assert((await call("/api/account/signup", { method: "POST", body: { businessName: "Amara Textiles", name: "Amara Obi", email: "nope", password: pw } })).body.error?.code === "invalid_email", "signup rejects a bad email");
  assert((await call("/api/account/signup", { method: "POST", body: { businessName: "Amara Textiles", name: "Amara Obi", email, password: "short" } })).body.error?.code === "weak_password", "signup rejects a short password");
  assert((await call("/api/account/signup", { method: "POST", body: { businessName: "Amara Textiles", name: "Amara Obi", email, password: "password123" } })).body.error?.code === "weak_password", "signup rejects a common password");
  assert((await call("/api/account/signup", { method: "POST", body: { businessName: "Amara Textiles", name: "Amara Obi", email, password: "amaraobi-2026-x" } })).body.error?.code === "weak_password", "a password containing the person's name is refused");
  const su = await call("/api/account/signup", { method: "POST", body: { businessName: "Amara Textiles", name: "Amara Obi", email, password: pw } });
  assert(su.status === 201 && su.body.token?.startsWith("wps_") && !JSON.stringify(su.body).includes("wp_test_"), "signup creates a person and a business and signs them in, without showing any API key");
  assert((await call("/api/account/signup", { method: "POST", body: { businessName: "X Co", name: "Other Person", email: email.toUpperCase(), password: pw } })).status === 409, "the same email can't register twice");
  let tok = su.body.token;
  let me = (await call("/api/account/me", { token: tok })).body;
  assert(me.role === "owner" && me.merchant.name === "Amara Textiles" && me.merchant.status === "pending" && me.access.team === "w" && me.user.emailVerified, "the new person is the owner of a pending business and can use the account straight away (no email confirmation)");

  // ── No confirmation step: a brand-new owner can invite people immediately ──
  const quick = await call("/api/team/invite", { method: "POST", token: tok, body: { email: `quick${stamp}@shop.test`, role: "viewer" } });
  assert(quick.status === 201 && quick.body.link?.includes("/invite/"), "a new owner can invite someone straight away and gets a shareable link");

  // ── Sign in, lockout, no account enumeration ──
  const wrong = await call("/api/account/login", { method: "POST", body: { email, password: "Wrong-password-1" }, ip: "203.0.113.1" });
  const unknown = await call("/api/account/login", { method: "POST", body: { email: `ghost${stamp}@shop.test`, password: "Wrong-password-1" }, ip: "203.0.113.2" });
  assert(wrong.status === 401 && unknown.status === 401 && wrong.body.error.message === unknown.body.error.message, "a wrong password and an unknown email give the same answer");
  let last;
  for (let i = 0; i < 5; i++) last = await call("/api/account/login", { method: "POST", body: { email, password: "Wrong-password-" + i }, ip: "203.0.113.3" });
  assert((await call("/api/account/login", { method: "POST", body: { email, password: pw }, ip: "203.0.113.4" })).status === 429, "after five wrong passwords the account locks for a while, even for the right password");
  const lockEmail = `lock${stamp}@shop.test`;
  await call("/api/account/signup", { method: "POST", body: { businessName: "Lock Co", name: "Lena Lock", email: lockEmail, password: pw } });
  const okLogin = await call("/api/account/login", { method: "POST", body: { email: lockEmail, password: pw }, ip: "203.0.113.5" });
  assert(okLogin.status === 200 && okLogin.body.token, "a normal sign-in works for another person");

  // ── Forgot and reset password ──
  const resetEmail = `reset${stamp}@shop.test`;
  const rs = await call("/api/account/signup", { method: "POST", body: { businessName: "Reset Co", name: "Rita Reset", email: resetEmail, password: pw } });
  const oldTok = rs.body.token;
  assert((await call("/api/account/forgot", { method: "POST", body: { email: `ghost${stamp}@shop.test` } })).status === 200, "forgot-password answers the same for an unknown email");
  assert((await call("/api/dev/mailbox?to=" + encodeURIComponent(`ghost${stamp}@shop.test`))).body.length === 0, "…and sends nothing to it");
  await call("/api/account/forgot", { method: "POST", body: { email: resetEmail } });
  const rm = await mail(resetEmail, /reset-password\?token=/);
  const rt = tokenIn(rm, /reset-password\?token=([\w-]+)/);
  assert((await call("/api/account/reset", { method: "POST", body: { token: rt, password: "short" } })).body.error?.code === "weak_password", "a weak new password is refused");
  assert((await call("/api/account/reset", { method: "POST", body: { token: rt, password: "A-fresh-passphrase-77" } })).status === 200, "the reset link sets a new password");
  assert((await call("/api/account/me", { token: oldTok })).status === 401, "resetting signs out every existing session");
  assert((await call("/api/account/reset", { method: "POST", body: { token: rt, password: "Another-passphrase-88" } })).body.error?.code === "invalid_token", "a reset link can't be reused");
  assert((await call("/api/account/login", { method: "POST", body: { email: resetEmail, password: "A-fresh-passphrase-77" }, ip: "203.0.113.6" })).status === 200, "the new password signs in");
  assert(await mail(resetEmail, /password was just changed/), "the person is told their password changed");

  // ── Change password keeps this device, signs out the others ──
  const dev1 = (await call("/api/account/login", { method: "POST", body: { email: resetEmail, password: "A-fresh-passphrase-77" }, ip: "203.0.113.7" })).body.token;
  const dev2 = (await call("/api/account/login", { method: "POST", body: { email: resetEmail, password: "A-fresh-passphrase-77" }, ip: "203.0.113.8" })).body.token;
  assert((await call("/api/account/password", { method: "POST", token: dev1, body: { current: "wrong", password: "Third-passphrase-99" } })).status === 403, "changing a password needs the current one");
  assert((await call("/api/account/password", { method: "POST", token: dev1, body: { current: "A-fresh-passphrase-77", password: "Third-passphrase-99" } })).status === 200, "the password can be changed");
  assert((await call("/api/account/me", { token: dev1 })).status === 200 && (await call("/api/account/me", { token: dev2 })).status === 401, "this device stays signed in and the others are signed out");
  const sess = (await call("/api/account/sessions", { token: dev1 })).body;
  assert(sess.length >= 1 && sess.some((s) => s.current), "the person can see where they're signed in");
  assert((await call("/api/account/logout", { method: "POST", token: dev1 })).status === 200 && (await call("/api/account/me", { token: dev1 })).status === 401, "signing out ends the session");

  // ── Two-factor ──
  const t2 = (await call("/api/account/login", { method: "POST", body: { email: lockEmail, password: pw }, ip: "203.0.113.9" })).body.token;
  const setup = (await call("/api/account/2fa/setup", { method: "POST", token: t2 })).body;
  assert(setup.secret?.length >= 16 && setup.otpauth.startsWith("otpauth://totp/"), "two-factor setup gives a secret for an authenticator app");
  assert((await call("/api/account/2fa/enable", { method: "POST", token: t2, body: { code: "000000" } })).status === 400, "a wrong code doesn't enable two-factor");
  const en = (await call("/api/account/2fa/enable", { method: "POST", token: t2, body: { code: totp(setup.secret) } })).body;
  assert(en.ok && en.recoveryCodes.length === 8, "the right code enables it and shows recovery codes once");
  const noCode = (await call("/api/account/login", { method: "POST", body: { email: lockEmail, password: pw }, ip: "203.0.113.10" })).body;
  assert(noCode.needs2fa === true && !noCode.token, "sign-in now asks for a code");
  assert((await call("/api/account/login", { method: "POST", body: { email: lockEmail, password: pw, totp: "123456" }, ip: "203.0.113.11" })).status === 401, "a wrong code is refused");
  assert((await call("/api/account/login", { method: "POST", body: { email: lockEmail, password: pw, totp: totp(setup.secret) }, ip: "203.0.113.12" })).body.token, "the right code signs in");
  const rec = en.recoveryCodes[0];
  assert((await call("/api/account/login", { method: "POST", body: { email: lockEmail, password: pw, totp: rec }, ip: "203.0.113.13" })).body.token, "a recovery code signs in when the phone is lost…");
  assert((await call("/api/account/login", { method: "POST", body: { email: lockEmail, password: pw, totp: rec }, ip: "203.0.113.14" })).status === 401, "…but only once");
  assert((await call("/api/account/2fa/disable", { method: "POST", token: t2, body: { password: "wrong" } })).status === 403, "turning two-factor off needs the password");
  assert((await call("/api/account/2fa/disable", { method: "POST", token: t2, body: { password: pw } })).status === 200, "two-factor can be turned off");

  // ── Teams and roles, on the platform's own business (which is live) ──
  const owner = (await call("/api/account/login", { method: "POST", body: DEMO_OWNER, ip: "203.0.113.20" })).body.token;
  assert(owner, "the business owner can sign in with email and password");
  const ownerMe = (await call("/api/account/me", { token: owner })).body;
  assert(ownerMe.merchant.uid === "mer_default" && ownerMe.merchant.status === "active", "…and lands in the live business");
  const roles = ["admin", "finance", "support", "developer", "viewer"], sessions = {};
  for (const role of roles) {
    const em = `${role}${stamp}@shop.test`;
    const invRes = await call("/api/team/invite", { method: "POST", token: owner, body: { email: em, role } });
    assert(invRes.status === 201, `the owner invites a ${role}`);
    const itok = invRes.body.link.split("/invite/")[1]; // the link comes back in the response: no mail needed
    const prev = (await call("/api/account/invite/" + itok)).body;
    assert(prev.role === role && prev.business && prev.hasAccount === false, `the invitation page shows the business and role (${role})`);
    const acc = await call("/api/account/invite/accept", { method: "POST", body: { token: itok, name: `Sam ${role}`, password: "Invited-person-2026" } });
    assert(acc.status === 201 && acc.body.token, `the ${role} accepts and is signed in`);
    sessions[role] = acc.body.token;
    if (role === "viewer") assert((await call("/api/account/invite/accept", { method: "POST", body: { token: itok, name: "Again Person", password: "Invited-person-2026" } })).body.error?.code === "invalid_token", "an invitation can only be used once");
  }
  const team = (await call("/api/team", { token: owner })).body;
  assert(team.members.length >= 6 && team.members.some((m) => m.role === "finance"), "the owner sees the whole team");

  // What each role can and can't do: enforced by the server, not just hidden in the UI.
  const intent = (token) => call("/api/intents", { method: "POST", token, body: { amount: 5, currency: "USD", orderRef: `r_${stamp}_${Math.random()}` } });
  const inv = await call("/api/invoices", { method: "POST", token: owner, body: { clientName: "Role Test", currency: "USD", items: [{ description: "x", unitPrice: 10 }] } });
  const check = async (role, label, p, want) => { const r = await p; assert(want ? r.status < 300 || r.status === 400 : r.status === 403, `${role}: ${label} is ${want ? "allowed" : "refused"} (${r.status})`); return r; };
  const S = sessions;
  await check("finance", "read statements", call("/api/statements", { token: S.finance }), true);
  await check("finance", "create an invoice", call("/api/invoices", { method: "POST", token: S.finance, body: { clientName: "F", currency: "USD", items: [{ description: "x", unitPrice: 1 }] } }), true);
  await check("finance", "create a payment link", intent(S.finance), false);
  await check("finance", "see the webhook secret", call("/api/webhook-secret", { token: S.finance }), false);
  await check("finance", "see the team", call("/api/team", { token: S.finance }), false);
  await check("support", "create a payment link", intent(S.support), true);
  await check("support", "send an invoice reminder", call(`/api/invoices/${inv.body.id}/remind`, { method: "POST", token: S.support, body: {} }), true);
  await check("support", "create an invoice", call("/api/invoices", { method: "POST", token: S.support, body: { clientName: "S", currency: "USD", items: [{ description: "x", unitPrice: 1 }] } }), false);
  await check("support", "read statements", call("/api/statements", { token: S.support }), false);
  await check("support", "read the ledger", call("/api/ledger", { token: S.support }), false);
  await check("developer", "see the webhook secret", call("/api/webhook-secret", { token: S.developer }), true);
  await check("developer", "rotate the API key", call("/api/merchants/me/rotate-key", { method: "POST", token: S.developer, body: {} }), true); // 400 = allowed but this business's key is set in the server's environment
  await check("developer", "read statements", call("/api/statements", { token: S.developer }), false);
  const before = (await call("/api/merchants/me", { token: owner })).body.name;
  await call("/api/merchants/me", { method: "POST", token: S.developer, body: { name: "Hacked Name", webhookUrl: "https://example.test/hook" } });
  assert((await call("/api/merchants/me", { token: owner })).body.name === before, "developer: can set the webhook URL but can't rename the business");
  await call("/api/merchants/me", { method: "POST", token: owner, body: { webhookUrl: "" } });
  await check("viewer", "read payments", call("/api/payments", { token: S.viewer }), true);
  await check("viewer", "create a payment link", intent(S.viewer), false);
  await check("viewer", "see the webhook secret", call("/api/webhook-secret", { token: S.viewer }), false);
  await check("admin", "see the team", call("/api/team", { token: S.admin }), true);
  await check("admin", "change the plan (billing)", call("/api/saas/upgrade", { method: "POST", token: S.admin, body: { plan: "starter" } }), false);
  const up = await call("/api/saas/upgrade", { method: "POST", token: owner, body: { plan: "starter" } });
  assert(up.status === 400 || up.status === 201, `owner: billing is allowed (${up.status}: ${up.body.error?.code ?? "ok"})`);
  assert([401, 403].includes((await call("/api/team", { key: DEMO_KEY })).status), "an API key can't read people or the team");
  assert((await call("/api/payments", { key: DEMO_KEY })).status === 200, "an API key still works for the data");

  // ── Role changes and removal take effect at once ──
  assert((await call("/api/team/role", { method: "POST", token: S.admin, body: { userId: ownerMe.user.id, role: "viewer" } })).body.error?.code === "forbidden", "an admin can't demote an owner");
  assert((await call("/api/team/role", { method: "POST", token: S.admin, body: { userId: (await call("/api/account/me", { token: S.support })).body.user.id, role: "owner" } })).body.error?.code === "forbidden", "an admin can't make someone an owner");
  assert((await call("/api/team/role", { method: "POST", token: owner, body: { userId: ownerMe.user.id, role: "viewer" } })).body.error?.code === "last_owner", "the last owner can't be demoted");
  assert((await call("/api/team/remove", { method: "POST", token: owner, body: { userId: ownerMe.user.id } })).body.error?.code === "last_owner", "the last owner can't be removed");
  const supId = (await call("/api/account/me", { token: S.support })).body.user.id;
  assert((await call("/api/team/role", { method: "POST", token: owner, body: { userId: supId, role: "viewer" } })).status === 200, "the owner changes a role");
  assert((await call("/api/account/me", { token: S.support })).status === 401, "the person is signed out so the new role applies at once");
  const finId = (await call("/api/account/me", { token: S.finance })).body.user.id;
  assert((await call("/api/team/remove", { method: "POST", token: owner, body: { userId: finId } })).status === 200 && (await call("/api/payments", { token: S.finance })).status === 401, "a removed person loses access immediately");

  // ── One person, several businesses (an accountant) ──
  const acct = (await call("/api/account/login", { method: "POST", body: { email: resetEmail, password: "Third-passphrase-99" }, ip: "203.0.113.30" })).body.token;
  const ai = await call("/api/team/invite", { method: "POST", token: owner, body: { email: resetEmail, role: "viewer" } });
  const atok = ai.body.link.split("/invite/")[1];
  assert((await call("/api/account/invite/" + atok)).body.hasAccount === true, "an invitation to an existing account says so");
  assert((await call("/api/account/invite/accept", { method: "POST", body: { token: atok, password: "wrong-password" } })).status === 401, "joining with an existing account needs its password");
  const joined = await call("/api/account/invite/accept", { method: "POST", body: { token: atok, password: "Third-passphrase-99" } });
  assert(joined.status === 201, "an existing person joins another business");
  const multi = (await call("/api/account/me", { token: joined.body.token })).body;
  assert(multi.businesses.length === 2, "they now belong to two businesses");
  const other = multi.businesses.find((b) => b.uid !== multi.merchant.uid);
  assert((await call("/api/account/switch", { method: "POST", token: joined.body.token, body: { merchantUid: other.uid } })).status === 200 && (await call("/api/account/me", { token: joined.body.token })).body.merchant.uid === other.uid, "they can switch between them");
  assert((await call("/api/account/switch", { method: "POST", token: joined.body.token, body: { merchantUid: "mer_does_not_exist" } })).status === 403, "they can't switch into a business they're not part of");

  // ── Audit log ──
  const log = (await call("/api/audit-log", { token: owner })).body;
  const actions = log.map((l) => l.action);
  assert(actions.includes("team.invited") && actions.includes("team.role_changed") && actions.includes("team.removed") && actions.includes("login"), "the activity log records invitations, role changes, removals and sign-ins");
  assert(log.some((l) => l.actor === ownerMe.user.name && /^POST \/api\/invoices/.test(l.action)), "…and business changes, with who made them");
  assert(!JSON.stringify(log).includes("Invited-person-2026") && !JSON.stringify(log).includes(pw), "…and never passwords");
  assert((await call("/api/audit-log", { token: S.viewer })).status === 403, "only owners and admins can read it");

  // ── Operator can hand a platform-created tenant to its first owner ──
  const op = await call("/api/platform/merchants", { method: "POST", token: PLATFORM_KEY, body: { name: `Platform Made ${stamp}` } });
  const oe = `first${stamp}@shop.test`;
  const io = await call(`/api/platform/tenants/${op.body.uid}/invite-owner`, { method: "POST", token: PLATFORM_KEY, body: { email: oe } });
  assert(io.status === 200 && io.body.link, "an operator can invite the first owner of a platform-created business");
  const oacc = await call("/api/account/invite/accept", { method: "POST", body: { token: io.body.link.split("/invite/")[1], name: "First Owner", password: "Invited-person-2026" } });
  assert((await call("/api/account/me", { token: oacc.body.token })).body.role === "owner", "…who becomes its owner");

  console.log("\nAccount checks passed.");
})().catch((e) => { console.error(e); process.exit(1); });
