import { DatabaseSync } from "node:sqlite";
import { LedgerService } from "./ledger-service.js";

export type AppDatabase = DatabaseSync;

export function createDatabase(filename = ":memory:"): AppDatabase {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      balance INTEGER NOT NULL CHECK (balance >= 0),
      provider_token TEXT NOT NULL,
      bvn TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      debit_account_id TEXT NOT NULL REFERENCES accounts(id),
      destination_account TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount > 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'uncertain', 'succeeded', 'failed', 'reversed')),
      funds_state TEXT NOT NULL CHECK (funds_state IN ('reserved', 'captured', 'released')),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      provider_reference TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      transfer_id TEXT NOT NULL,
      provider_status TEXT NOT NULL,
      outcome TEXT NOT NULL,
      received_at TEXT NOT NULL,
      processed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ledger_accounts (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL CHECK (account_type IN ('asset', 'liability')),
      normal_side TEXT NOT NULL CHECK (normal_side IN ('debit', 'credit')),
      owner_account_id TEXT REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      transfer_id TEXT REFERENCES transfers(id),
      category TEXT NOT NULL CHECK (category IN ('opening', 'transfer_reservation', 'transfer_capture', 'transfer_release')),
      description TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ledger_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id TEXT NOT NULL REFERENCES ledger_entries(id),
      account_code TEXT NOT NULL REFERENCES ledger_accounts(code),
      side TEXT NOT NULL CHECK (side IN ('debit', 'credit')),
      amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount > 0)
    );

    CREATE INDEX IF NOT EXISTS transfers_status_idx ON transfers(status);
    CREATE INDEX IF NOT EXISTS transfers_owner_created_idx ON transfers(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS ledger_lines_entry_idx ON ledger_lines(entry_id);
    CREATE INDEX IF NOT EXISTS ledger_lines_account_idx ON ledger_lines(account_code);
    CREATE INDEX IF NOT EXISTS ledger_entries_transfer_idx ON ledger_entries(transfer_id);

    CREATE TRIGGER IF NOT EXISTS ledger_entries_no_update
    BEFORE UPDATE ON ledger_entries
    BEGIN
      SELECT RAISE(ABORT, 'ledger entries are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS ledger_entries_no_delete
    BEFORE DELETE ON ledger_entries
    BEGIN
      SELECT RAISE(ABORT, 'ledger entries are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS ledger_lines_no_update
    BEFORE UPDATE ON ledger_lines
    BEGIN
      SELECT RAISE(ABORT, 'ledger lines are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS ledger_lines_no_delete
    BEFORE DELETE ON ledger_lines
    BEGIN
      SELECT RAISE(ABORT, 'ledger lines are immutable');
    END;
  `);
  return db;
}

export function inImmediateTransaction<T>(db: AppDatabase, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function seedDatabase(db: AppDatabase): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO accounts
      (id, owner_id, name, balance, provider_token, bvn)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insert.run("acc-a", "user-a", "Tobi Demo", 500_000, "demo-token-a", "00000000001");
  insert.run("acc-b", "user-b", "Ada Demo", 250_000, "demo-token-b", "00000000002");

  const ledger = new LedgerService(db);
  const now = new Date().toISOString();
  const accounts = db.prepare("SELECT id, balance FROM accounts ORDER BY id").all() as Array<{
    id: string;
    balance: number;
  }>;
  for (const account of accounts) {
    ledger.postOpeningBalance(account.id, Number(account.balance), now);
  }
}
