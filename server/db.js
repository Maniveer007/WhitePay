require("dotenv").config({ path: process.env.ENV_FILE || ".env", quiet: true }); // DATA_DIR must be known before opening
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", process.env.DATA_DIR || "data");
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(process.env.DB_PATH || path.join(dir, "whitepay.db"));

db.exec(`
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,            -- bytes32 intentId (hex)
  public_id TEXT UNIQUE,          -- short id used in URLs
  order_ref TEXT, description TEXT,
  fiat_amount REAL, currency TEXT, rate REAL,
  amount TEXT,                    -- USDT base units
  token TEXT, expiry INTEGER, signature TEXT,
  policy TEXT DEFAULT 'safe',     -- finality level required to fulfil
  created_at INTEGER,
  payer TEXT, tx_hash TEXT, block_number INTEGER, block_hash TEXT, log_index INTEGER,
  paid_at INTEGER, finality TEXT DEFAULT 'created', refunded TEXT DEFAULT '0',
  fulfillable INTEGER DEFAULT 0, gas_used TEXT, gas_price TEXT, gas_payer TEXT, relay_tx TEXT
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, entry_group TEXT,
  account TEXT, debit TEXT DEFAULT '0', credit TEXT DEFAULT '0',
  intent_id TEXT, memo TEXT, tx_hash TEXT, log_index INTEGER, block_number INTEGER,
  UNIQUE(entry_group, account)
);
CREATE TABLE IF NOT EXISTS subs (
  id INTEGER PRIMARY KEY, merchant_id INTEGER, payer TEXT, token TEXT, amount TEXT, period INTEGER,
  cap TEXT, charged TEXT DEFAULT '0', next_charge INTEGER, end_ts INTEGER, cancelled INTEGER DEFAULT 0,
  tx_hash TEXT
);
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, type TEXT, payload TEXT,
  created_at INTEGER, attempts INTEGER DEFAULT 0, next_attempt INTEGER, status TEXT DEFAULT 'pending',
  last_status INTEGER, last_error TEXT
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
-- Event store: every onchain log we acted on. Derived state (refunded, charged) is recomputed
-- from ACTIVE rows, so a reorg is handled by flipping rows to 'reorged' and recomputing.
CREATE TABLE IF NOT EXISTS chain_events (
  key TEXT PRIMARY KEY,            -- txHash:logIndex:blockHash
  name TEXT, ref TEXT,             -- intentId or sub:<id>
  amount TEXT, block_number INTEGER, block_hash TEXT, tx_hash TEXT, log_index INTEGER,
  ledger_group TEXT, status TEXT DEFAULT 'active', seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS ev_status ON chain_events(status, block_number);
-- Money that reached the payout wallet outside the contract (exchange sends, wrong token).
CREATE TABLE IF NOT EXISTS exceptions (
  key TEXT PRIMARY KEY, kind TEXT, token TEXT, sender TEXT, amount TEXT,
  tx_hash TEXT, block_number INTEGER, created_at INTEGER, resolved INTEGER DEFAULT 0, note TEXT
);
CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, response TEXT, created_at INTEGER);
`);

for (const col of ["gas_payer TEXT", "relay_tx TEXT"]) { try { db.exec(`ALTER TABLE intents ADD COLUMN ${col}`); } catch {} } // older DBs
for (const col of ["reason TEXT", "operator TEXT", "counterparty TEXT"]) { try { db.exec(`ALTER TABLE chain_events ADD COLUMN ${col}`); } catch {} }
// Multi-merchant: every merchant-owned row carries the merchant's on-chain id (backfilled to the default merchant on boot).
for (const t of ["intents", "webhooks", "exceptions", "ledger"]) { try { db.exec(`ALTER TABLE ${t} ADD COLUMN merchant_id INTEGER`); } catch {} }
db.exec(`
-- Customer-initiated refund requests (signed by the paying wallet) and their resolution.
CREATE TABLE IF NOT EXISTS refund_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, intent_id TEXT, amount TEXT, reason TEXT, note TEXT,
  requester TEXT, signature TEXT, status TEXT DEFAULT 'open', created_at INTEGER, resolved_at INTEGER, resolution TEXT
);
-- Refund operators as configured onchain (RefunderSet events).
CREATE TABLE IF NOT EXISTS refund_operators (merchant_id INTEGER, address TEXT, per_refund TEXT, per_day TEXT, updated_at INTEGER, PRIMARY KEY (merchant_id, address));
`);

// Older DBs had refund_operators keyed by address only: rebuild it with a per-merchant key.
if (!db.prepare("PRAGMA table_info(refund_operators)").all().some((c) => c.name === "merchant_id")) {
  db.exec(`ALTER TABLE refund_operators RENAME TO refund_operators_v1;
    CREATE TABLE refund_operators (merchant_id INTEGER, address TEXT, per_refund TEXT, per_day TEXT, updated_at INTEGER, PRIMARY KEY (merchant_id, address));
    INSERT INTO refund_operators SELECT NULL, address, per_refund, per_day, updated_at FROM refund_operators_v1; DROP TABLE refund_operators_v1;`);
}

const kv = {
  get: (k, d = null) => db.prepare("SELECT v FROM kv WHERE k=?").get(k)?.v ?? d,
  set: (k, v) => db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v)),
};

module.exports = { db, kv };
