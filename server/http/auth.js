// Who is calling: a signed-in person (session) or a server (API key) for merchants, and the platform key for operators.
const crypto = require("crypto");
const merchants = require("../services/merchants");
const accounts = require("../features/accounts");

/** Who is calling? A signed-in person (session token) or a server (API key). Either way we end up with a merchant and a role,
 *  and the role decides what the request may do. Keys are stored only as SHA-256 hashes and looked up by hash. */
const auth = (req, res, next) => {
  const k = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  let m = null, role = "api", user = null, auditorKey = false;
  if (k.startsWith("wps_")) {
    const s = accounts.resolveSession(k);
    if (s) { m = merchants.byUid(s.merchantUid); role = s.role; user = s.user; }
  } else {
    m = merchants.byApiKey(k);
    if (!m) { m = merchants.byAuditorKey(k); if (m) { role = "viewer"; auditorKey = true; } }
  }
  if (!m) return res.status(401).json({ error: { code: "unauthorized", message: "Missing or invalid credentials" } });
  if (auditorKey && req.method !== "GET") return res.status(403).json({ error: { code: "read_only", message: "This is a read-only auditor key" } });
  const denied = accounts.authorize(role, req.method, req.path, { emailVerified: user ? !!user.email_verified : true });
  if (denied) return res.status(403).json({ error: { code: user && !user.email_verified && /verify/i.test(denied) ? "email_unverified" : "forbidden", message: denied } });
  // A merchant that hasn't registered on-chain yet can only see/edit its own profile.
  if (m.status !== "active" && !req.path.startsWith("/api/merchants/me")) return res.status(403).json({ error: { code: "merchant_pending",
    message: "Register this merchant on-chain first (see GET /api/v1/merchants/me → nextStep)" } });
  req.readOnly = role === "viewer"; req.role = role; req.user = user;
  req.m = m; req.mid = m.onchain_id;
  // Every successful change is recorded: who did what, from where.
  if (req.method !== "GET" && req.method !== "HEAD") res.on("finish", () => {
    if (res.statusCode < 400) accounts.audit(m.uid, user ? { id: user.id, label: user.name || user.email } : { label: "API key" }, `${req.method} ${req.path}`, null, req.ip);
  });
  next();
};
const platformKey = process.env.PLATFORM_KEY ? crypto.createHash("sha256").update(process.env.PLATFORM_KEY).digest() : null;
/** Platform operator (marketplace) key: onboards merchants. Disabled unless PLATFORM_KEY is set. */
const platform = (req, res, next) => {
  const k = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!platformKey || !crypto.timingSafeEqual(crypto.createHash("sha256").update(k).digest(), platformKey))
    return res.status(401).json({ error: { code: "unauthorized", message: "Platform key required" } });
  next();
};

module.exports = { auth, platform };
