import crypto from "node:crypto";
import type { AppDatabase } from "./db.js";
import { inImmediateTransaction } from "./db.js";
import { LedgerIntegrityError, type LedgerService } from "./ledger-service.js";
import type {
  Clock,
  FundsState,
  ProviderStatusResult,
  PublicTransfer,
  TransferInput,
  TransferProvider,
  TransferStatus,
} from "./types.js";

interface TransferRow extends Record<string, unknown> {
  id: string;
  owner_id: string;
  debit_account_id: string;
  destination_account: string;
  amount: number;
  status: TransferStatus;
  funds_state: FundsState;
  idempotency_key: string;
  request_hash: string;
  provider_reference: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export class TransferError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface InitiationResult {
  statusCode: number;
  transfer: PublicTransfer;
}

export interface ProviderEvent {
  eventId: string;
  transferId: string;
  status: ProviderStatusResult["status"];
}

interface TransitionResult {
  kind: "transitioned" | "ignored" | "not_found";
  transfer?: TransferRow;
}

function asTransferRow(value: unknown): TransferRow {
  return value as TransferRow;
}

export function asPublicTransfer(row: TransferRow | Record<string, unknown>): PublicTransfer {
  return {
    id: String(row.id),
    debitAccountId: String(row.debit_account_id),
    destinationAccount: String(row.destination_account),
    amount: Number(row.amount),
    status: row.status as TransferStatus,
    providerReference: row.provider_reference ? String(row.provider_reference) : null,
    failureReason: row.failure_reason ? String(row.failure_reason) : null,
    needsReconciliation: row.status === "uncertain",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class TransferService {
  constructor(
    private readonly db: AppDatabase,
    private readonly provider: TransferProvider,
    private readonly clock: Clock,
    private readonly ledger: LedgerService,
    private readonly providerTimeoutMs = 5_000,
    private readonly reconciliationBatchSize = 50,
    private readonly reconciliationConcurrency = 5,
  ) {}

  async initiate(ownerId: string, idempotencyKey: string, input: TransferInput): Promise<InitiationResult> {
    const requestHash = this.requestHash(input);
    const id = crypto.randomUUID();
    const now = this.clock.now().toISOString();

    const reservation = inImmediateTransaction(this.db, () => {
      const existing = this.findByIdempotencyKey(ownerId, idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new TransferError(409, "idempotency key reused with a different request");
        }
        return { created: false, transfer: existing };
      }

      const account = this.db
        .prepare("SELECT id, owner_id FROM accounts WHERE id = ?")
        .get(input.debitAccountId) as { id: string; owner_id: string } | undefined;

      if (!account) throw new TransferError(404, "account not found");
      if (account.owner_id !== ownerId) {
        throw new TransferError(403, "only the account owner can initiate a transfer");
      }

      let availableLedgerBalance: number;
      try {
        availableLedgerBalance = this.ledger.assertProjectionMatches(input.debitAccountId);
      } catch (error) {
        if (error instanceof LedgerIntegrityError) {
          throw new TransferError(503, `ledger integrity check failed: ${error.message}`);
        }
        throw error;
      }
      if (availableLedgerBalance < input.amount) throw new TransferError(422, "insufficient funds");

      // The ledger authorizes the spend; this guarded projection update is the
      // concurrency control that stops two withdrawals spending the same funds.
      const debit = this.db
        .prepare("UPDATE accounts SET balance = balance - ? WHERE id = ? AND owner_id = ? AND balance >= ?")
        .run(input.amount, input.debitAccountId, ownerId, input.amount);
      if (Number(debit.changes) !== 1) throw new TransferError(422, "insufficient funds");

      this.db.prepare(`
        INSERT INTO transfers
          (id, owner_id, debit_account_id, destination_account, amount, status, funds_state,
           idempotency_key, request_hash, provider_reference, failure_reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 'reserved', ?, ?, ?, NULL, ?, ?)
      `).run(
        id,
        ownerId,
        input.debitAccountId,
        input.destinationAccount,
        input.amount,
        idempotencyKey,
        requestHash,
        id,
        now,
        now,
      );

      this.ledger.postReservation(id, input.debitAccountId, input.amount, now);
      this.ledger.assertProjectionMatches(input.debitAccountId);

      return { created: true, transfer: this.findById(id)! };
    });

    if (!reservation.created) {
      return { statusCode: 200, transfer: asPublicTransfer(reservation.transfer) };
    }

    try {
      const providerResult = await this.withProviderTimeout(
        Promise.resolve().then(() =>
          this.provider.send({
            clientReference: id,
            destinationAccount: input.destinationAccount,
            amount: input.amount,
          }),
        ),
      );

      const transfer = inImmediateTransaction(this.db, () => {
        this.db
          .prepare("UPDATE transfers SET provider_reference = ?, updated_at = ? WHERE id = ?")
          .run(providerResult.providerReference, this.clock.now().toISOString(), id);

        if (providerResult.status === "rejected") {
          return this.applyOutcomeInTransaction(id, "failed", "failed", "provider rejected").transfer!;
        }
        return this.findById(id)!;
      });

      return { statusCode: 201, transfer: asPublicTransfer(transfer) };
    } catch (error) {
      const transfer = inImmediateTransaction(this.db, () => {
        const current = this.findById(id)!;
        if (current.status === "pending") {
          this.db
            .prepare("UPDATE transfers SET status = 'uncertain', failure_reason = ?, updated_at = ? WHERE id = ?")
            .run("provider response unavailable", this.clock.now().toISOString(), id);
        }
        return this.findById(id)!;
      });

      return {
        statusCode: transfer.status === "uncertain" ? 202 : 201,
        transfer: asPublicTransfer(transfer),
      };
    }
  }

  processProviderEvent(event: ProviderEvent): {
    duplicate: boolean;
    outcome: TransitionResult["kind"];
    transfer?: PublicTransfer;
  } {
    return inImmediateTransaction(this.db, () => {
      const now = this.clock.now().toISOString();
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO webhook_events
          (event_id, transfer_id, provider_status, outcome, received_at, processed_at)
        VALUES (?, ?, ?, 'received', ?, ?)
      `).run(event.eventId, event.transferId, event.status, now, now);

      if (Number(inserted.changes) === 0) {
        return { duplicate: true, outcome: "ignored" as const };
      }

      const transition =
        event.status === "pending"
          ? { kind: this.findById(event.transferId) ? "ignored" as const : "not_found" as const }
          : this.applyOutcomeInTransaction(
              event.transferId,
              event.status,
              event.status === "failed" ? "reversed" : "succeeded",
              event.status === "failed" ? "provider reported failure" : null,
            );

      this.db
        .prepare("UPDATE webhook_events SET outcome = ?, processed_at = ? WHERE event_id = ?")
        .run(transition.kind, this.clock.now().toISOString(), event.eventId);

      return {
        duplicate: false,
        outcome: transition.kind,
        transfer: transition.transfer ? asPublicTransfer(transition.transfer) : undefined,
      };
    });
  }

  async reconcile(): Promise<{ examined: number; processed: number; errors: number; remaining: number }> {
    const batchSize = Math.max(1, Math.floor(this.reconciliationBatchSize));
    const concurrency = Math.max(1, Math.floor(this.reconciliationConcurrency));
    const candidates = this.db
      .prepare("SELECT * FROM transfers WHERE status IN ('pending', 'uncertain') ORDER BY created_at LIMIT ?")
      .all(batchSize)
      .map(asTransferRow);
    let processed = 0;
    let errors = 0;

    const providerResults: Array<PromiseSettledResult<ProviderStatusResult>> = [];
    for (let offset = 0; offset < candidates.length; offset += concurrency) {
      const chunk = candidates.slice(offset, offset + concurrency);
      providerResults.push(
        ...(await Promise.allSettled(
          chunk.map((candidate) =>
            this.withProviderTimeout(
              Promise.resolve().then(() =>
                this.provider.getStatus(candidate.provider_reference ?? candidate.id),
              ),
            ),
          ),
        )),
      );
    }

    for (const [index, candidate] of candidates.entries()) {
      const providerResult = providerResults[index];
      if (!providerResult || providerResult.status === "rejected") {
        errors += 1;
        continue;
      }

      try {
        if (providerResult.value.status === "pending") continue;
        const finalStatus = providerResult.value.status;

        const transition = inImmediateTransaction(this.db, () =>
          this.applyOutcomeInTransaction(
            candidate.id,
            finalStatus,
            finalStatus === "failed" ? "reversed" : "succeeded",
            finalStatus === "failed" ? "provider reconciliation reported failure" : null,
          ),
        );
        if (transition.kind === "transitioned") processed += 1;
      } catch {
        errors += 1;
      }
    }

    const remainingRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM transfers WHERE status IN ('pending', 'uncertain')")
      .get() as { count: number };
    return { examined: candidates.length, processed, errors, remaining: Number(remainingRow.count) };
  }

  private applyOutcomeInTransaction(
    transferId: string,
    providerStatus: "succeeded" | "failed",
    targetStatus: "succeeded" | "failed" | "reversed",
    failureReason: string | null,
  ): TransitionResult {
    const current = this.findById(transferId);
    if (!current) return { kind: "not_found" };
    if (!(["pending", "uncertain"] as TransferStatus[]).includes(current.status)) {
      return { kind: "ignored", transfer: current };
    }
    if (current.funds_state !== "reserved") return { kind: "ignored", transfer: current };

    const now = this.clock.now().toISOString();
    const transition = this.db.prepare(`
      UPDATE transfers
      SET status = ?, funds_state = ?, failure_reason = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'uncertain') AND funds_state = 'reserved'
    `).run(
      targetStatus,
      providerStatus === "failed" ? "released" : "captured",
      failureReason,
      now,
      transferId,
    );
    if (Number(transition.changes) !== 1) {
      throw new LedgerIntegrityError(`transfer ${transferId} lost its terminal transition guard`);
    }

    if (providerStatus === "failed") {
      this.db
        .prepare("UPDATE accounts SET balance = balance + ? WHERE id = ?")
        .run(current.amount, current.debit_account_id);
      this.ledger.postRelease(
        transferId,
        current.debit_account_id,
        current.amount,
        now,
      );
    } else {
      this.ledger.postCapture(transferId, current.amount, now);
    }

    this.ledger.assertProjectionMatches(current.debit_account_id);

    return { kind: "transitioned", transfer: this.findById(transferId)! };
  }

  private findById(id: string): TransferRow | undefined {
    const row = this.db.prepare("SELECT * FROM transfers WHERE id = ?").get(id);
    return row ? asTransferRow(row) : undefined;
  }

  private findByIdempotencyKey(ownerId: string, key: string): TransferRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM transfers WHERE owner_id = ? AND idempotency_key = ?")
      .get(ownerId, key);
    return row ? asTransferRow(row) : undefined;
  }

  private requestHash(input: TransferInput): string {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify([input.debitAccountId, input.destinationAccount, input.amount]))
      .digest("hex");
  }

  private withProviderTimeout<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`provider operation timed out after ${this.providerTimeoutMs}ms`)),
        this.providerTimeoutMs,
      );

      operation.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }
}
