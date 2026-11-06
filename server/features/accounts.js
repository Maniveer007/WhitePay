// People and access: user accounts, sessions, email verification, password reset, two-factor sign-in, teams with roles,
// invitations and an audit log.
//
// API keys are for developers and servers. People sign in with email and password, belong to one or more businesses
// ("merchants") with a role, and the role decides what they can see and do. Sessions are opaque tokens (stored hashed).
const crypto = require("crypto");
const { db } = require("../db");
const cfg = require("../config");
const merchants = require("../services/merchants");
const notify = require("../services/notify");

const realNow = () => Math.floor(Date.now() / 1000); // security timing uses the real clock, never the test clock
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const rand = (n = 32) => crypto.randomBytes(n).toString("base64url");
const bad = (status, code, message) => Object.assign(new Error(message), { status, code });
const WEB = () => (process.env.WEB_ORIGIN || process.env.PUBLIC_URL || "http://localhost:3001").replace(/\/$/, "");

const SESSION_TTL = 30 * 86400, SESSION_IDLE = 14 * 86400, VERIFY_TTL = 3 * 86400, RESET_TTL = 3600, INVITE_TTL = 7 * 86400;
const MAX_FAILS = 5, LOCK_SECONDS = 15 * 60;

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, password_hash TEXT, email_verified INTEGER DEFAULT 0, created_at INTEGER,
  last_login INTEGER, failed_logins INTEGER DEFAULT 0, locked_until INTEGER DEFAULT 0, totp_secret TEXT, totp_enabled INTEGER DEFAULT 0,
  recovery TEXT, last_merchant TEXT
);
CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT, merchant_uid TEXT, role TEXT, created_at INTEGER, PRIMARY KEY (user_id, merchant_uid)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT, merchant_uid TEXT, created_at INTEGER, expires_at INTEGER, last_seen INTEGER, ip TEXT, ua TEXT, label TEXT
);
CREATE TABLE IF NOT EXISTS account_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT UNIQUE, kind TEXT, user_id TEXT, merchant_uid TEXT, email TEXT, role TEXT,
  invited_by TEXT, created_at INTEGER, expires_at INTEGER, used_at INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, merchant_uid TEXT, user_id TEXT, actor TEXT, action TEXT, detail TEXT, ip TEXT, ts INTEGER
);
CREATE INDEX IF NOT EXISTS audit_by_merchant ON audit_log(merchant_uid, id);
`);

// ───────── Roles ─────────
// Levels per area: "w" can change things, "r" can look, "" cannot see it.
const ROLES = ["owner", "admin", "finance", "support", "developer", "viewer"];
const AREAS = ["payments", "invoices", "subscriptions", "refunds", "finance", "ledger", "marketplace", "customers", "developers", "settings", "team", "billing", "audit"];
const ACCESS = {
  owner:     { payments: "w", invoices: "w", subscriptions: "w", refunds: "w", finance: "w", ledger: "w", marketplace: "w", customers: "r", developers: "w", settings: "w", team: "w", billing: "w", audit: "r" },
  admin:     { payments: "w", invoices: "w", subscriptions: "w", refunds: "w", finance: "w", ledger: "w", marketplace: "w", customers: "r", developers: "w", settings: "w", team: "w", billing: "r", audit: "r" },
  finance:   { payments: "r", invoices: "w", subscriptions: "r", refunds: "w", finance: "w", ledger: "w", marketplace: "r", customers: "r", developers: "",  settings: "r", team: "",  billing: "",  audit: "" },
  support:   { payments: "w", invoices: "r", subscriptions: "r", refunds: "w", finance: "",  ledger: "",  marketplace: "",  customers: "r", developers: "",  settings: "r", team: "",  billing: "",  audit: "" },
  developer: { payments: "w", invoices: "w", subscriptions: "r", refunds: "r", finance: "",  ledger: "r", marketplace: "",  customers: "r", developers: "w", settings: "r", team: "",  billing: "",  audit: "" },
  viewer:    { payments: "r", invoices: "r", subscriptions: "r", refunds: "r", finance: "r", ledger: "r", marketplace: "r", customers: "r", developers: "",  settings: "r", team: "",  billing: "",  audit: "" },
  // Server-to-server API keys: everything about the business's data, but not people, the audit log or other staff's access.
  api:       { payments: "w", invoices: "w", subscriptions: "w", refunds: "w", finance: "w", ledger: "w", marketplace: "w", customers: "r", developers: "w", settings: "w", team: "",  billing: "w", audit: "" },
};
const ROLE_LABEL = { owner: "Owner", admin: "Admin", finance: "Finance", support: "Support", developer: "Developer", viewer: "Viewer / auditor" };
const ROLE_HELP = {
  owner: "Everything, including team, billing and ownership.",
  admin: "Everything except billing and ownership changes.",
  finance: "Invoices, refunds, statements, period close and the ledger. No API keys.",
  support: "Look up payments, create payment links, handle refund requests, send invoice reminders.",
  developer: "API keys, webhooks and testing tools, plus payments and invoices.",
  viewer: "Read-only access to everything except keys and team. Good for an accountant or auditor.",
};

// Which area a request belongs to. First match wins.
const ROUTES = [
  [/^\/api\/(payments|intents)(\/|$)/, "payments"],
  [/^\/api\/(invoices|credit-notes|recurring-invoices)(\/|$)/, "invoices"],
  [/^\/api\/(subscriptions|plans)(\/|$)/, "subscriptions"],
  [/^\/api\/(refund-requests|refund-operators)(\/|$)/, "refunds"],
  [/^\/api\/(statements|periods|auditor-key)(\/|$)/, "finance"],
  [/^\/api\/(ledger|reconcile|exceptions)(\/|$|\.)/, "ledger"],
  [/^\/api\/(webhooks|webhook-secret|events|test-clock|meters|agents|x402)(\/|$)/, "developers"],
  [/^\/api\/merchants\/me\/rotate-key$/, "developers"],
  [/^\/api\/notifications(\/|$)/, "settings"],
  [/^\/api\/merchants\/me$/, "settings"],
  [/^\/api\/saas\/upgrade$/, "billing"],
  [/^\/api\/team(\/|$)/, "team"],
  [/^\/api\/audit-log$/, "audit"],
];
const areaOf = (path) => { for (const [re, a] of ROUTES) if (re.test(path)) return a; return null; };
// Actions that need a verified email even for people who may otherwise do them.
// Email confirmation is OFF by default (accounts work immediately: easy to try and demo). Set REQUIRE_EMAIL_VERIFICATION=1 to require it
// before inviting people, creating API keys or paying for a plan.
const REQUIRE_VERIFIED = process.env.REQUIRE_EMAIL_VERIFICATION === "1";
const NEEDS_VERIFIED = [/^\/api\/team\/invite$/, /^\/api\/merchants\/me\/rotate-key$/, /^\/api\/saas\/upgrade$/];

/** May this role do `method path`? Returns null if allowed, or a reason string. */
function authorize(role, method, path, { emailVerified = true } = {}) {
  const acc = ACCESS[role];
  if (!acc) return "Unknown role";
  if (REQUIRE_VERIFIED && !emailVerified && method !== "GET" && NEEDS_VERIFIED.some((re) => re.test(path))) return "Verify your email address first";
  const area = areaOf(path);
  if (!area) return method === "GET" || method === "HEAD" ? null : (["owner", "admin", "api"].includes(role) ? null : `${ROLE_LABEL[role] || role} can't do this`);
  const need = method === "GET" || method === "HEAD" ? "r" : "w";
  const have = acc[area];
  // Small, deliberate exceptions to "write means the area's write level".
  if (need === "w" && have === "r") {
    if (area === "invoices" && /^\/api\/invoices\/[^/]+\/remind$/.test(path) && role === "support") return null; // support may remind clients
    if (area === "developers" && path === "/api/merchants/me/rotate-key") return `${ROLE_LABEL[role] || role} can't do this`;
  }
  if (area === "settings" && path === "/api/merchants/me" && need === "w" && acc.developers === "w" && have !== "w") return null; // developers set the webhook URL (handler strips other fields)
  if (have === "w" || (have === "r" && need === "r")) return null;
  return `${ROLE_LABEL[role] || role} can't ${need === "w" ? "change" : "view"} this`;
}
const accessOf = (role) => ({ ...(ACCESS[role] || {}) });

// ───────── Passwords ─────────
const COMMON = new Set(["password", "password1", "password123", "1234567890", "qwertyuiop", "letmein123", "iloveyou12", "welcome123", "admin12345", "whitepay123"]);
function checkPassword(pw, { email = "", name = "" } = {}) {
  pw = String(pw ?? "");
  if (pw.length < 10) throw bad(400, "weak_password", "Use at least 10 characters");
  if (pw.length > 200) throw bad(400, "weak_password", "That password is too long");
  const l = pw.toLowerCase();
  if (COMMON.has(l) || /^(.)\1+$/.test(pw)) throw bad(400, "weak_password", "That password is too easy to guess");
  if (email && l.includes(email.split("@")[0].toLowerCase()) && email.split("@")[0].length > 3) throw bad(400, "weak_password", "Don't use your email address in your password");
  const parts = String(name || "").toLowerCase().split(/\s+/).filter((x) => x.length >= 4);
  if ((name && l.includes(String(name).toLowerCase().replace(/\s+/g, ""))) || parts.some((x) => l.includes(x))) throw bad(400, "weak_password", "Don't use your name in your password");
}
const hashPassword = (pw) => { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString("base64")}$${crypto.scryptSync(pw, salt, 64).toString("base64")}`; };
function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || "").split("$");
  if (alg !== "scrypt") return false;
  const a = crypto.scryptSync(String(pw), Buffer.from(salt, "base64"), 64), b = Buffer.from(hash, "base64");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const DUMMY_HASH = hashPassword("dummy-password-for-timing"); // verified when the email is unknown so timing doesn't reveal accounts

// ───────── Two-factor (TOTP, RFC 6238) ─────────
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const b32encode = (buf) => { let bits = 0, v = 0, out = ""; for (const x of buf) { v = (v << 8) | x; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(v << (5 - bits)) & 31]; return out; };
const b32decode = (s) => { let bits = 0, v = 0; const out = []; for (const c of s.replace(/=+$/, "").toUpperCase()) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
function totp(secret, t = realNow()) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(t / 30)));
  const h = crypto.createHmac("sha1", b32decode(secret)).update(counter).digest(), o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, "0");
}
const totpOk = (secret, code) => { const c = String(code || "").replace(/\s/g, ""); return /^\d{6}$/.test(c) && [-1, 0, 1].some((d) => crypto.timingSafeEqual(Buffer.from(totp(secret, realNow() + d * 30)), Buffer.from(c))); };
const seal = (s) => merchants.seal(s), unseal = (s) => merchants.unseal(s);

// ───────── Audit ─────────
function audit(merchantUid, who, action, detail, ip) {
  try {
    db.prepare("INSERT INTO audit_log(merchant_uid,user_id,actor,action,detail,ip,ts) VALUES(?,?,?,?,?,?,?)")
      .run(merchantUid, who?.id ?? null, who?.label ?? who?.email ?? "API key", action, detail ? JSON.stringify(detail).slice(0, 500) : null, ip || null, realNow());
  } catch {}
}

// ───────── Email ─────────
function sendMail(to, subject, body, key) { notify.enqueue(null, `acct:${key}:${rand(6)}`, "email", to, subject, body); }
const mailBody = (lines) => lines.join("\n\n") + "\n\n-- WhitePay";

// ───────── Users, tokens, sessions ─────────
const userBy = (email) => db.prepare("SELECT * FROM users WHERE email=?").get(String(email || "").trim().toLowerCase());
const userById = (id) => db.prepare("SELECT * FROM users WHERE id=?").get(id);
const normEmail = (e) => {
  const email = String(e || "").trim().toLowerCase();
  if (!/^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$/.test(email)) throw bad(400, "invalid_email", "Enter a valid email address");
  return email;
};
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, emailVerified: !!u.email_verified, twoFactor: !!u.totp_enabled, createdAt: u.created_at });

function issueToken(kind, { userId = null, merchantUid = null, email = null, role = null, invitedBy = null, ttl }) {
  const token = rand(32);
  db.prepare("INSERT INTO account_tokens(token_hash,kind,user_id,merchant_uid,email,role,invited_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(sha(token), kind, userId, merchantUid, email, role, invitedBy, realNow(), realNow() + ttl);
  return token;
}
function takeToken(token, kind) {
  const row = db.prepare("SELECT * FROM account_tokens WHERE token_hash=? AND kind=?").get(sha(token || ""), kind);
  if (!row || row.used_at || row.expires_at < realNow()) throw bad(400, "invalid_token", "This link is invalid or has expired");
  return row;
}
const markUsed = (row) => db.prepare("UPDATE account_tokens SET used_at=? WHERE id=?").run(realNow(), row.id);

function createSession(user, merchantUid, req) {
  const token = "wps_" + rand(32), t = realNow();
  db.prepare("INSERT INTO sessions(id,user_id,merchant_uid,created_at,expires_at,last_seen,ip,ua) VALUES(?,?,?,?,?,?,?,?)")
    .run(sha(token), user.id, merchantUid, t, t + SESSION_TTL, t, req?.ip || null, String(req?.headers?.["user-agent"] || "").slice(0, 160));
  db.prepare("UPDATE users SET last_login=?, last_merchant=? WHERE id=?").run(t, merchantUid, user.id);
  return token;
}
/** Resolve a session token to { user, merchantUid, role, sessionId }, or null. Touches last_seen. */
function resolveSession(token) {
  if (!token || !String(token).startsWith("wps_")) return null;
  const id = sha(token), s = db.prepare("SELECT * FROM sessions WHERE id=?").get(id), t = realNow();
  if (!s || s.expires_at < t || s.last_seen + SESSION_IDLE < t) return null;
  const user = userById(s.user_id), mem = db.prepare("SELECT role FROM memberships WHERE user_id=? AND merchant_uid=?").get(s.user_id, s.merchant_uid);
  if (!user || !mem) return null;
  if (t - s.last_seen > 60) db.prepare("UPDATE sessions SET last_seen=? WHERE id=?").run(t, id);
  return { user, merchantUid: s.merchant_uid, role: mem.role, sessionId: id };
}
const roleIn = (userId, uid) => db.prepare("SELECT role FROM memberships WHERE user_id=? AND merchant_uid=?").get(userId, uid)?.role;
const membershipsOf = (userId) => db.prepare("SELECT m.merchant_uid uid, m.role, x.name FROM memberships m JOIN merchants x ON x.uid=m.merchant_uid WHERE m.user_id=? ORDER BY m.created_at").all(userId);

function newUser({ email, name, password }) {
  const id = "usr_" + rand(9);
  db.prepare("INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)").run(id, email, String(name || "").trim().slice(0, 80), hashPassword(password), realNow());
  return userById(id);
}
const addMember = (userId, uid, role) => db.prepare("INSERT OR REPLACE INTO memberships(user_id,merchant_uid,role,created_at) VALUES(?,?,?,?)").run(userId, uid, role, realNow());

function sendVerification(user) {
  const token = issueToken("verify", { userId: user.id, ttl: VERIFY_TTL });
  sendMail(user.email, "Confirm your email for WhitePay", mailBody([`Hi ${user.name || "there"},`, `Confirm your email address to finish setting up your account:\n${WEB()}/verify-email?token=${token}`, "This link works for 3 days. If you didn't sign up, you can ignore this email."]), "verify");
}

/** The first person who can sign in to the deployment's own business (the platform's merchant): set BOOTSTRAP_OWNER_EMAIL and
 *  BOOTSTRAP_OWNER_PASSWORD, and that account is created (email pre-confirmed) as its owner. Everyone else is invited from the console. */
function seedBootstrapOwner() {
  const email = process.env.BOOTSTRAP_OWNER_EMAIL, password = process.env.BOOTSTRAP_OWNER_PASSWORD;
  if (!email || !password) return;
  let u = userBy(email);
  if (!u) { u = newUser({ email: email.toLowerCase(), name: process.env.BOOTSTRAP_OWNER_NAME || "Owner", password }); db.prepare("UPDATE users SET email_verified=1 WHERE id=?").run(u.id); }
  addMember(u.id, "mer_default", "owner");
}

// ───────── Routes ─────────
function mount(app) {
  const { err, send, rateLimit } = require("../http/helpers");
  const { platform } = require("../http/auth");
  const open = process.env.SIGNUP_OPEN === "1";
  const devMailbox = process.env.DEV_MAILBOX === "1" && process.env.NODE_ENV !== "production";
  seedBootstrapOwner();

  const sessionAuth = (req, res, next) => {
    const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const s = resolveSession(tok);
    if (!s) return err(res, 401, "unauthorized", "Please sign in again");
    req.user = s.user; req.userLabel = s.user.name || s.user.email; req.sessionId = s.sessionId; req.role = s.role; req.merchantUid = s.merchantUid; req.session = s;
    next();
  };
  const need = (...roles) => (req, res, next) => (roles.includes(req.role) ? next() : err(res, 403, "forbidden", `${ROLE_LABEL[req.role] || req.role} can't do this`));
  const who = (req) => ({ id: req.user.id, label: req.user.name || req.user.email });
  const meView = (req) => {
    const m = merchants.byUid(req.merchantUid), v = merchants.publicView(m);
    if (m.status !== "active") v.nextStep = { contract: cfg.dep.pay, call: "registerMerchant(address payout, address quoteSigner)", args: ["<your payout wallet>", m.signer_address] };
    return { user: publicUser(req.user), role: req.role, roleLabel: ROLE_LABEL[req.role], access: accessOf(req.role), merchant: v, businesses: membershipsOf(req.user.id).map((x) => ({ uid: x.uid, name: x.name, role: x.role })) };
  };

  // Public: what the sign-up and sign-in pages need to know.
  app.get("/api/account/info", (_req, res) => res.json({ signupOpen: open, roles: ROLES.map((r) => ({ id: r, label: ROLE_LABEL[r], help: ROLE_HELP[r] })) }));

  // ── Sign up: a person and their business ──
  app.post("/api/account/signup", rateLimit(Number(process.env.SIGNUP_RATE_LIMIT || 5)), (req, res) => send(res, () => {
    if (!open) throw bad(403, "signup_closed", "Sign-up is not open on this server");
    const b = req.body || {}, email = normEmail(b.email), business = String(b.businessName || "").trim(), name = String(b.name || "").trim();
    if (business.length < 2) throw bad(400, "invalid_name", "Enter your business name");
    if (name.length < 2) throw bad(400, "invalid_name", "Enter your name");
    checkPassword(b.password, { email, name });
    if (userBy(email)) throw bad(409, "email_taken", "An account with this email already exists. Try signing in.");
    const created = merchants.create({ name: business }); // the first API key is not shown: developers create their own in the console
    db.prepare("UPDATE merchants SET email=?, plan='free' WHERE uid=?").run(email, created.uid);
    const user = newUser({ email, name, password: b.password });
    addMember(user.id, created.uid, "owner");
    if (REQUIRE_VERIFIED) sendVerification(user);
    else db.prepare("UPDATE users SET email_verified=1 WHERE id=?").run(user.id); // no confirmation step unless asked for
    audit(created.uid, { id: user.id, label: name }, "account.created", { business }, req.ip);
    res.status(201);
    return { token: createSession(user, created.uid, req), user: publicUser(user) };
  }));

  // ── Sign in ──
  app.post("/api/account/login", rateLimit(15), (req, res) => send(res, () => {
    const b = req.body || {}, user = userBy(b.email), generic = bad(401, "invalid_credentials", "Email or password is not right");
    if (!user) { verifyPassword(b.password, DUMMY_HASH); throw generic; }
    if (user.locked_until > realNow()) throw bad(429, "locked", "Too many wrong attempts. Try again in a few minutes, or reset your password.");
    if (!verifyPassword(b.password, user.password_hash)) {
      const fails = user.failed_logins + 1;
      db.prepare("UPDATE users SET failed_logins=?, locked_until=? WHERE id=?").run(fails >= MAX_FAILS ? 0 : fails, fails >= MAX_FAILS ? realNow() + LOCK_SECONDS : 0, user.id);
      for (const m of membershipsOf(user.id)) audit(m.uid, { id: user.id, label: user.name }, "login.failed", null, req.ip);
      throw generic;
    }
    if (user.totp_enabled) {
      const code = String(b.totp || "").trim();
      if (!code) return { needs2fa: true };
      const rec = JSON.parse(user.recovery || "[]"), ri = rec.indexOf(sha(code.replace(/[\s-]/g, "").toLowerCase()));
      if (!totpOk(unseal(user.totp_secret), code) && ri < 0) throw bad(401, "invalid_code", "That code is not right");
      if (ri >= 0) { rec.splice(ri, 1); db.prepare("UPDATE users SET recovery=? WHERE id=?").run(JSON.stringify(rec), user.id); }
    }
    db.prepare("UPDATE users SET failed_logins=0, locked_until=0 WHERE id=?").run(user.id);
    const mems = membershipsOf(user.id);
    if (!mems.length) throw bad(403, "no_business", "This account isn't part of any business yet");
    const uid = mems.find((m) => m.uid === user.last_merchant)?.uid ?? mems[0].uid;
    audit(uid, { id: user.id, label: user.name }, "login", null, req.ip);
    return { token: createSession(user, uid, req), user: publicUser(user) };
  }));

  app.post("/api/account/logout", sessionAuth, (req, res) => { db.prepare("DELETE FROM sessions WHERE id=?").run(req.sessionId); res.json({ ok: true }); });
  app.get("/api/account/me", sessionAuth, (req, res) => res.json(meView(req)));

  // ── Email verification ──
  app.post("/api/account/verify-email", rateLimit(20), (req, res) => send(res, () => {
    const row = takeToken(req.body?.token, "verify");
    db.prepare("UPDATE users SET email_verified=1 WHERE id=?").run(row.user_id); markUsed(row);
    return { ok: true };
  }));
  app.post("/api/account/resend-verification", sessionAuth, rateLimit(3), (req, res) => send(res, () => {
    if (req.user.email_verified) return { ok: true, alreadyVerified: true };
    sendVerification(req.user); return { ok: true };
  }));

  // ── Forgot and reset password (never reveals whether the email has an account) ──
  app.post("/api/account/forgot", rateLimit(5), (req, res) => send(res, () => {
    const user = userBy(req.body?.email);
    if (user) {
      const token = issueToken("reset", { userId: user.id, ttl: RESET_TTL });
      sendMail(user.email, "Reset your WhitePay password", mailBody([`Hi ${user.name || "there"},`, `Choose a new password here (the link works for 1 hour):\n${WEB()}/reset-password?token=${token}`, "If you didn't ask for this, ignore this email: your password hasn't changed."]), "reset");
    }
    return { ok: true };
  }));
  app.post("/api/account/reset", rateLimit(10), (req, res) => send(res, () => {
    const row = takeToken(req.body?.token, "reset"), user = userById(row.user_id);
    checkPassword(req.body?.password, { email: user.email, name: user.name });
    db.prepare("UPDATE users SET password_hash=?, failed_logins=0, locked_until=0, email_verified=1 WHERE id=?").run(hashPassword(req.body.password), user.id);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id); // everywhere signs out
    markUsed(row);
    for (const m of membershipsOf(user.id)) audit(m.uid, { id: user.id, label: user.name }, "password.reset", null, req.ip);
    sendMail(user.email, "Your WhitePay password was changed", mailBody([`Hi ${user.name || "there"},`, "Your password was just changed and every device was signed out. If this wasn't you, reset it again now and contact your team owner."]), "pwchanged");
    return { ok: true };
  }));

  // ── Profile, password, sessions ──
  app.post("/api/account/profile", sessionAuth, (req, res) => send(res, () => {
    const name = String(req.body?.name || "").trim();
    if (name.length < 2) throw bad(400, "invalid_name", "Enter your name");
    db.prepare("UPDATE users SET name=? WHERE id=?").run(name.slice(0, 80), req.user.id);
    return publicUser(userById(req.user.id));
  }));
  app.post("/api/account/password", sessionAuth, rateLimit(10), (req, res) => send(res, () => {
    const { current, password } = req.body || {};
    if (!verifyPassword(current, req.user.password_hash)) throw bad(403, "invalid_credentials", "Your current password is not right");
    checkPassword(password, { email: req.user.email, name: req.user.name });
    db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hashPassword(password), req.user.id);
    db.prepare("DELETE FROM sessions WHERE user_id=? AND id<>?").run(req.user.id, req.sessionId); // other devices sign out
    audit(req.merchantUid, who(req), "password.changed", null, req.ip);
    return { ok: true };
  }));
  app.get("/api/account/sessions", sessionAuth, (req, res) => res.json(db.prepare("SELECT id,created_at,last_seen,ip,ua FROM sessions WHERE user_id=? AND expires_at>? ORDER BY last_seen DESC").all(req.user.id, realNow())
    .map((s) => ({ id: s.id.slice(0, 16), createdAt: s.created_at, lastSeen: s.last_seen, ip: s.ip, device: s.ua, current: s.id === req.sessionId }))));
  app.post("/api/account/sessions/revoke", sessionAuth, (req, res) => send(res, () => {
    if (req.body?.all) db.prepare("DELETE FROM sessions WHERE user_id=? AND id<>?").run(req.user.id, req.sessionId);
    else db.prepare("DELETE FROM sessions WHERE user_id=? AND id LIKE ? AND id<>?").run(req.user.id, String(req.body?.id || "x").slice(0, 16) + "%", req.sessionId);
    audit(req.merchantUid, who(req), "sessions.revoked", null, req.ip);
    return { ok: true };
  }));
  app.post("/api/account/switch", sessionAuth, (req, res) => send(res, () => {
    const uid = String(req.body?.merchantUid || "");
    if (!roleIn(req.user.id, uid)) throw bad(403, "forbidden", "You're not part of that business");
    db.prepare("UPDATE sessions SET merchant_uid=? WHERE id=?").run(uid, req.sessionId);
    db.prepare("UPDATE users SET last_merchant=? WHERE id=?").run(uid, req.user.id);
    return { ok: true };
  }));

  // ── Two-factor ──
  app.post("/api/account/2fa/setup", sessionAuth, (req, res) => send(res, () => {
    if (req.user.totp_enabled) throw bad(409, "already_enabled", "Two-factor sign-in is already on");
    const secret = b32encode(crypto.randomBytes(20));
    db.prepare("UPDATE users SET totp_secret=? WHERE id=?").run(seal(secret), req.user.id);
    return { secret, otpauth: `otpauth://totp/WhitePay:${encodeURIComponent(req.user.email)}?secret=${secret}&issuer=WhitePay&period=30&digits=6` };
  }));
  app.post("/api/account/2fa/enable", sessionAuth, (req, res) => send(res, () => {
    const u = userById(req.user.id);
    if (!u.totp_secret || u.totp_enabled) throw bad(400, "not_ready", "Start setup first");
    if (!totpOk(unseal(u.totp_secret), req.body?.code)) throw bad(400, "invalid_code", "That code is not right. Check the time on your phone and try again.");
    const codes = Array.from({ length: 8 }, () => rand(5).toLowerCase().replace(/[^a-z0-9]/g, "x").slice(0, 8));
    db.prepare("UPDATE users SET totp_enabled=1, recovery=? WHERE id=?").run(JSON.stringify(codes.map(sha)), u.id);
    audit(req.merchantUid, who(req), "2fa.enabled", null, req.ip);
    return { ok: true, recoveryCodes: codes };
  }));
  app.post("/api/account/2fa/disable", sessionAuth, rateLimit(10), (req, res) => send(res, () => {
    if (!verifyPassword(req.body?.password, req.user.password_hash)) throw bad(403, "invalid_credentials", "Your password is not right");
    db.prepare("UPDATE users SET totp_enabled=0, totp_secret=NULL, recovery=NULL WHERE id=?").run(req.user.id);
    audit(req.merchantUid, who(req), "2fa.disabled", null, req.ip);
    return { ok: true };
  }));

  // ── Team ──
  const memberView = (r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, emailVerified: !!r.email_verified, twoFactor: !!r.totp_enabled, lastLogin: r.last_login, joinedAt: r.created_at });
  app.get("/api/team", sessionAuth, need("owner", "admin"), (req, res) => {
    const members = db.prepare("SELECT u.id,u.name,u.email,u.email_verified,u.totp_enabled,u.last_login,m.role,m.created_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.merchant_uid=? ORDER BY m.created_at").all(req.merchantUid).map(memberView);
    const invites = db.prepare("SELECT id,email,role,created_at,expires_at FROM account_tokens WHERE merchant_uid=? AND kind='invite' AND used_at IS NULL AND expires_at>? ORDER BY id DESC").all(req.merchantUid, realNow());
    res.json({ members, invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, sentAt: i.created_at, expiresAt: i.expires_at })), roles: ROLES.map((r) => ({ id: r, label: ROLE_LABEL[r], help: ROLE_HELP[r] })) });
  });
  const assignable = (req, role) => {
    if (!ROLES.includes(role)) throw bad(400, "invalid_role", "Unknown role");
    if (role === "owner" && req.role !== "owner") throw bad(403, "forbidden", "Only an owner can make someone an owner");
  };
  app.post("/api/team/invite", sessionAuth, need("owner", "admin"), rateLimit(20), (req, res) => send(res, () => {
    if (REQUIRE_VERIFIED && !req.user.email_verified) throw bad(403, "email_unverified", "Verify your email address first");
    const email = normEmail(req.body?.email), role = String(req.body?.role || "");
    assignable(req, role);
    const existing = userBy(email);
    if (existing && roleIn(existing.id, req.merchantUid)) throw bad(409, "already_member", "That person is already on your team");
    db.prepare("UPDATE account_tokens SET used_at=? WHERE kind='invite' AND merchant_uid=? AND email=? AND used_at IS NULL").run(realNow(), req.merchantUid, email);
    const token = issueToken("invite", { merchantUid: req.merchantUid, email, role, invitedBy: req.user.id, ttl: INVITE_TTL });
    const biz = merchants.byUid(req.merchantUid).name;
    sendMail(email, `${req.user.name || "A colleague"} invited you to ${biz} on WhitePay`, mailBody([`${req.user.name || "A colleague"} invited you to join ${biz} on WhitePay as ${ROLE_LABEL[role]}.`, `Accept the invitation:\n${WEB()}/invite/${token}`, "The link works for 7 days."]), "invite");
    audit(req.merchantUid, who(req), "team.invited", { email, role }, req.ip);
    res.status(201);
    // The link is returned so the inviter can share it directly (chat, WhatsApp): no mail server needed to add a teammate.
    return { ok: true, email, role, link: `${WEB()}/invite/${token}` };
  }));
  app.post("/api/team/invites/cancel", sessionAuth, need("owner", "admin"), (req, res) => send(res, () => {
    db.prepare("UPDATE account_tokens SET used_at=? WHERE id=? AND merchant_uid=? AND kind='invite'").run(realNow(), Number(req.body?.id), req.merchantUid);
    audit(req.merchantUid, who(req), "team.invite_cancelled", { id: req.body?.id }, req.ip);
    return { ok: true };
  }));
  const owners = (uid) => db.prepare("SELECT COUNT(*) n FROM memberships WHERE merchant_uid=? AND role='owner'").get(uid).n;
  app.post("/api/team/role", sessionAuth, need("owner", "admin"), (req, res) => send(res, () => {
    const id = String(req.body?.userId || ""), role = String(req.body?.role || ""), cur = roleIn(id, req.merchantUid);
    if (!cur) throw bad(404, "not_found", "That person isn't on your team");
    assignable(req, role);
    if (cur === "owner" && req.role !== "owner") throw bad(403, "forbidden", "Only an owner can change an owner's role");
    if (cur === "owner" && role !== "owner" && owners(req.merchantUid) <= 1) throw bad(409, "last_owner", "A business needs at least one owner");
    addMember(id, req.merchantUid, role);
    db.prepare("DELETE FROM sessions WHERE user_id=? AND merchant_uid=?").run(id, req.merchantUid); // re-evaluate access at next sign-in
    audit(req.merchantUid, who(req), "team.role_changed", { user: userById(id)?.email, from: cur, to: role }, req.ip);
    return { ok: true };
  }));
  app.post("/api/team/remove", sessionAuth, need("owner", "admin"), (req, res) => send(res, () => {
    const id = String(req.body?.userId || ""), cur = roleIn(id, req.merchantUid);
    if (!cur) throw bad(404, "not_found", "That person isn't on your team");
    if (cur === "owner" && req.role !== "owner") throw bad(403, "forbidden", "Only an owner can remove an owner");
    if (cur === "owner" && owners(req.merchantUid) <= 1) throw bad(409, "last_owner", "A business needs at least one owner");
    db.prepare("DELETE FROM memberships WHERE user_id=? AND merchant_uid=?").run(id, req.merchantUid);
    db.prepare("DELETE FROM sessions WHERE user_id=? AND merchant_uid=?").run(id, req.merchantUid);
    audit(req.merchantUid, who(req), "team.removed", { user: userById(id)?.email }, req.ip);
    return { ok: true };
  }));

  // ── Accept an invitation: new people set a password, existing accounts just join ──
  app.get("/api/account/invite/:token", rateLimit(30), (req, res) => send(res, () => {
    const row = takeToken(req.params.token, "invite");
    return { email: row.email, role: row.role, roleLabel: ROLE_LABEL[row.role], business: merchants.byUid(row.merchant_uid)?.name, hasAccount: !!userBy(row.email) };
  }));
  app.post("/api/account/invite/accept", rateLimit(10), (req, res) => send(res, () => {
    const row = takeToken(req.body?.token, "invite");
    let user = userBy(row.email);
    if (user) { if (!verifyPassword(req.body?.password, user.password_hash)) throw bad(401, "invalid_credentials", "Enter the password for your existing WhitePay account"); }
    else {
      const name = String(req.body?.name || "").trim();
      if (name.length < 2) throw bad(400, "invalid_name", "Enter your name");
      checkPassword(req.body?.password, { email: row.email, name });
      user = newUser({ email: row.email, name, password: req.body.password });
      db.prepare("UPDATE users SET email_verified=1 WHERE id=?").run(user.id); // the invitation went to this address
    }
    addMember(user.id, row.merchant_uid, row.role); markUsed(row);
    audit(row.merchant_uid, { id: user.id, label: user.name }, "team.joined", { role: row.role }, req.ip);
    res.status(201);
    return { token: createSession(user, row.merchant_uid, req), user: publicUser(user) };
  }));

  // ── Activity log ──
  app.get("/api/audit-log", sessionAuth, need("owner", "admin"), (req, res) =>
    res.json(db.prepare("SELECT id,actor,action,detail,ip,ts FROM audit_log WHERE merchant_uid=? ORDER BY id DESC LIMIT 200").all(req.merchantUid).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }))));

  // ── Operator: invite the first owner of a tenant created through the platform API ──
  if (platform) app.post("/api/platform/tenants/:uid/invite-owner", platform, (req, res) => send(res, () => {
    const m = merchants.byUid(req.params.uid);
    if (!m || m.uid === "mer_default") throw bad(404, "not_found", "Unknown tenant");
    const email = normEmail(req.body?.email);
    const token = issueToken("invite", { merchantUid: m.uid, email, role: "owner", invitedBy: null, ttl: INVITE_TTL });
    sendMail(email, `You're invited to run ${m.name} on WhitePay`, mailBody([`You've been invited to manage ${m.name} on WhitePay as Owner.`, `Accept the invitation:\n${WEB()}/invite/${token}`]), "invite");
    return { ok: true, link: `${WEB()}/invite/${token}` };
  }));

  // ── Local development only: read the emails the server would have sent ──
  if (devMailbox) app.get("/api/dev/mailbox", (req, res) => {
    const to = String(req.query.to || "").toLowerCase();
    res.json(db.prepare("SELECT recipient,subject,body,status,created_at FROM notifications WHERE channel='email' AND merchant_id IS NULL AND (?='' OR lower(recipient)=?) ORDER BY id DESC LIMIT 20").all(to, to));
  });
}

module.exports = { mount, resolveSession, authorize, accessOf, audit, ROLES, ROLE_LABEL, ACCESS, areaOf, publicUser, totp, b32encode };
