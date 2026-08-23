import crypto from "node:crypto";
import type { AppDatabase } from "./db.js";

export type LedgerSide = "debit" | "credit";
export type LedgerCategory = "opening" | "transfer_reservation" | "transfer_capture" | "transfer_release";

interface LedgerLineInput {
  accountCode: string;
  side: LedgerSide;
  amount: number;
}

interface PostLedgerEntryInput {
  idempotencyKey: string;
  transferId?: string;
  category: LedgerCategory;
  description: string;
  createdAt: string;
  lines: LedgerLineInput[];
}

export const ledgerAccounts = {
  systemCash: "system:cash",
  transferPayable: "system:transfer_payable",
  userAvailable: (accountId: string) => `user:${accountId}:available`,
};

export class LedgerIntegrityError extends Error {}

export interface LedgerIntegrityReport {
  balanced: boolean;
  projectionMatches: boolean;
  availableLedgerBalance: number;
  balanceProjection: number;
  firstUnbalancedEntryId?: string;
}

export class LedgerService {
  constructor(private readonly db: AppDatabase) {}

  ensureAccounts(accountId: string): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO ledger_accounts
        (code, name, account_type, normal_side, owner_account_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    insert.run(ledgerAccounts.systemCash, "RelayPay cash", "asset", "debit", null);
    insert.run(ledgerAccounts.transferPayable, "Transfers payable", "liability", "credit", null);
    insert.run(
      ledgerAccounts.userAvailable(accountId),
      `Available balance for ${accountId}`,
      "liability",
      "credit",
      accountId,
    );
  }

  postOpeningBalance(accountId: string, amount: number, createdAt: string): void {
    this.ensureAccounts(accountId);
    if (amount === 0) return;
    this.postEntry({
      idempotencyKey: `opening:${accountId}`,
      category: "opening",
      description: `Opening balance for ${accountId}`,
      createdAt,
      lines: [
        { accountCode: ledgerAccounts.systemCash, side: "debit", amount },
        { accountCode: ledgerAccounts.userAvailable(accountId), side: "credit", amount },
      ],
    });
  }

  postEntry(input: PostLedgerEntryInput): void {
    this.assertEntryInput(input);
    const existing = this.db
      .prepare("SELECT id FROM ledger_entries WHERE idempotency_key = ?")
      .get(input.idempotencyKey);
    if (existing) return;

    const entryId = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO ledger_entries
        (id, idempotency_key, transfer_id, category, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      entryId,
      input.idempotencyKey,
      input.transferId ?? null,
      input.category,
      input.description,
      input.createdAt,
    );

    const insertLine = this.db.prepare(`
      INSERT INTO ledger_lines (entry_id, account_code, side, amount)
      VALUES (?, ?, ?, ?)
    `);
    for (const line of input.lines) {
      insertLine.run(entryId, line.accountCode, line.side, line.amount);
    }
  }

  postReservation(transferId: string, accountId: string, amount: number, createdAt: string): void {
    this.ensureAccounts(accountId);
    this.postEntry({
      idempotencyKey: `transfer:${transferId}:reserve`,
      transferId,
      category: "transfer_reservation",
      description: `Reserve funds for transfer ${transferId}`,
      createdAt,
      lines: [
        { accountCode: ledgerAccounts.userAvailable(accountId), side: "debit", amount },
        { accountCode: ledgerAccounts.transferPayable, side: "credit", amount },
      ],
    });
  }

  postCapture(transferId: string, amount: number, createdAt: string): void {
    this.postEntry({
      idempotencyKey: `transfer:${transferId}:capture`,
      transferId,
      category: "transfer_capture",
      description: `Settle transfer ${transferId}`,
      createdAt,
      lines: [
        { accountCode: ledgerAccounts.transferPayable, side: "debit", amount },
        { accountCode: ledgerAccounts.systemCash, side: "credit", amount },
      ],
    });
  }

  postRelease(transferId: string, accountId: string, amount: number, createdAt: string): void {
    this.ensureAccounts(accountId);
    this.postEntry({
      idempotencyKey: `transfer:${transferId}:release`,
      transferId,
      category: "transfer_release",
      description: `Release funds for transfer ${transferId}`,
      createdAt,
      lines: [
        { accountCode: ledgerAccounts.transferPayable, side: "debit", amount },
        { accountCode: ledgerAccounts.userAvailable(accountId), side: "credit", amount },
      ],
    });
  }

  integrityReport(accountId: string): LedgerIntegrityReport {
    const unbalanced = this.db.prepare(`
      SELECT e.id
      FROM ledger_entries e
      LEFT JOIN ledger_lines l ON l.entry_id = e.id
      GROUP BY e.id
      HAVING COUNT(l.id) < 2
        OR COALESCE(SUM(CASE WHEN l.side = 'debit' THEN l.amount ELSE -l.amount END), 0) != 0
      LIMIT 1
    `).get() as { id: string } | undefined;
    const account = this.db
      .prepare("SELECT balance FROM accounts WHERE id = ?")
      .get(accountId) as { balance: number } | undefined;
    if (!account) throw new LedgerIntegrityError(`account ${accountId} is missing`);

    const ledger = this.db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN side = 'credit' THEN amount ELSE -amount END), 0) AS balance
      FROM ledger_lines
      WHERE account_code = ?
    `).get(ledgerAccounts.userAvailable(accountId)) as { balance: number };

    return {
      balanced: !unbalanced,
      projectionMatches: Number(ledger.balance) === Number(account.balance),
      availableLedgerBalance: Number(ledger.balance),
      balanceProjection: Number(account.balance),
      firstUnbalancedEntryId: unbalanced?.id,
    };
  }

  assertProjectionMatches(accountId: string): number {
    const report = this.integrityReport(accountId);
    if (!report.balanced) {
      throw new LedgerIntegrityError(`ledger entry ${report.firstUnbalancedEntryId} is not balanced`);
    }
    if (!report.projectionMatches) {
      throw new LedgerIntegrityError(
        `ledger balance ${report.availableLedgerBalance} does not match account projection ${report.balanceProjection}`,
      );
    }

    return report.availableLedgerBalance;
  }

  derivedAvailableBalance(accountId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN side = 'credit' THEN amount ELSE -amount END), 0) AS balance
      FROM ledger_lines
      WHERE account_code = ?
    `).get(ledgerAccounts.userAvailable(accountId)) as { balance: number };
    return Number(row.balance);
  }

  private assertEntryInput(input: PostLedgerEntryInput): void {
    if (!input.idempotencyKey.trim()) throw new LedgerIntegrityError("ledger idempotency key is required");
    if (input.lines.length < 2) throw new LedgerIntegrityError("ledger entry requires at least two lines");

    let debits = 0;
    let credits = 0;
    for (const line of input.lines) {
      if (!Number.isSafeInteger(line.amount) || line.amount <= 0) {
        throw new LedgerIntegrityError("ledger amounts must be positive safe integers");
      }
      if (line.side === "debit") debits += line.amount;
      else credits += line.amount;
    }
    if (debits !== credits) throw new LedgerIntegrityError("ledger debits must equal credits");
  }
}
