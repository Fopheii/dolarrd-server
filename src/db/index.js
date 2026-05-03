const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/dolarrd.db');

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Fresh-install schema — no CHECK constraint on source so 'wu_api' is valid
db.exec(`
  CREATE TABLE IF NOT EXISTS rates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,
    type            TEXT NOT NULL CHECK(type IN ('bank', 'remittance', 'exchange')),
    buy_rate        REAL,
    sell_rate       REAL,
    fee             REAL,
    receive_amount  REAL,
    status          TEXT NOT NULL DEFAULT 'live',
    last_updated    TEXT NOT NULL,
    source          TEXT NOT NULL,
    manual_override INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sync_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT NOT NULL,
    source          TEXT NOT NULL,
    records_updated INTEGER NOT NULL DEFAULT 0,
    error           TEXT
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_name     TEXT NOT NULL,
    direction       TEXT NOT NULL CHECK(direction IN ('buy', 'sell')),
    threshold_rate  REAL NOT NULL,
    push_token      TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );
`);

// Migrate existing databases:
// 1. If `status` column is missing the rates table was created with the old schema
//    (which also had a CHECK constraint on source blocking 'wu_api').
//    Recreate it preserving all existing rows.
const cols = db.pragma('table_info(rates)').map((c) => c.name);

if (!cols.includes('status')) {
  const hasReceiveAmount = cols.includes('receive_amount');

  db.exec(`
    BEGIN;

    CREATE TABLE rates_new (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL UNIQUE,
      type            TEXT NOT NULL CHECK(type IN ('bank', 'remittance', 'exchange')),
      buy_rate        REAL,
      sell_rate       REAL,
      fee             REAL,
      receive_amount  REAL,
      status          TEXT NOT NULL DEFAULT 'live',
      last_updated    TEXT NOT NULL,
      source          TEXT NOT NULL,
      manual_override INTEGER NOT NULL DEFAULT 0
    );

    INSERT OR IGNORE INTO rates_new
      (id, name, type, buy_rate, sell_rate, fee, receive_amount, status, last_updated, source, manual_override)
    SELECT
      id, name, type, buy_rate, sell_rate, fee,
      ${hasReceiveAmount ? 'receive_amount' : 'NULL'},
      'live',
      last_updated, source, manual_override
    FROM rates;

    DROP TABLE rates;
    ALTER TABLE rates_new RENAME TO rates;

    COMMIT;
  `);

  console.log('[db] Migrated rates table: added status column, relaxed source constraint');
}

module.exports = db;
