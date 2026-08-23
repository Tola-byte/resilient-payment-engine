import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { createDatabase, seedDatabase, type AppDatabase } from "../../src/server/db.js";
import { LedgerService } from "../../src/server/ledger-service.js";
import { FakeProvider } from "../../src/server/provider.js";
import type {
  ProviderStatusResult,
  ProviderTransferRequest,
  ProviderTransferResult,
  TransferProvider,
} from "../../src/server/types.js";

const transfer = {
  debitAccountId: "acc-a",
  destinationAccount: "0123456789",
  amount: 10_000,
};
const headers = { "x-demo-user": "user-a", "Idempotency-Key": "ledger-test" };

function projection(db: AppDatabase): number {
  const row = db.prepare("SELECT balance FROM accounts WHERE id = 'acc-a'").get() as { balance: number };
  return Number(row.balance);
}

function unbalancedEntryCount(db: AppDatabase): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT e.id
      FROM ledger_entries e
      JOIN ledger_lines l ON l.entry_id = e.id
      GROUP BY e.id
      HAVING SUM(CASE WHEN l.side = 'debit' THEN l.amount ELSE -l.amount END) != 0
    )
  `).get() as { count: number };
  return Number(row.count);
}

describe("double-entry ledger", () => {
  let db: AppDatabase;
  let ledger: LedgerService;

  beforeEach(() => {
    db = createDatabase();
    seedDatabase(db);
    ledger = new LedgerService(db);
  });

  afterEach(() => db.close());

  it("starts with balanced opening entries matching account projections", () => {
    expect(unbalancedEntryCount(db)).toBe(0);
    expect(ledger.derivedAvailableBalance("acc-a")).toBe(500_000);
    expect(ledger.derivedAvailableBalance("acc-b")).toBe(250_000);
    expect(() => ledger.assertProjectionMatches("acc-a")).not.toThrow();
    expect(() => ledger.assertProjectionMatches("acc-b")).not.toThrow();
  });

  it("exposes an owner-scoped ledger integrity report without journal details", async () => {
    const app = createApp({ db, provider: new FakeProvider() });
    const healthy = await request(app)
      .get("/api/accounts/integrity")
      .set("x-demo-user", "user-a");

    expect(healthy.status).toBe(200);
    expect(healthy.body).toEqual({
      verified: true,
      accounts: [{
        accountId: "acc-a",
        balanced: true,
        projectionMatches: true,
        availableLedgerBalance: 500_000,
        balanceProjection: 500_000,
      }],
    });
    expect(JSON.stringify(healthy.body)).not.toContain("entry");

    db.prepare("UPDATE accounts SET balance = balance + 1 WHERE id = 'acc-a'").run();
    const drifted = await request(app)
      .get("/api/accounts/integrity")
      .set("x-demo-user", "user-a");
    expect(drifted.status).toBe(503);
    expect(drifted.body).toMatchObject({
      verified: false,
      accounts: [{ accountId: "acc-a", balanced: true, projectionMatches: false }],
    });
  });

  it("moves value through reservation and capture without changing the user twice", async () => {
    const provider = new FakeProvider();
    const app = createApp({ db, provider });
    const created = await request(app).post("/api/transfers").set(headers).send(transfer);

    expect(created.status).toBe(201);
    expect(created.body.status).toBe("pending");
    expect(projection(db)).toBe(490_000);
    expect(ledger.derivedAvailableBalance("acc-a")).toBe(490_000);

    const reconciled = await request(app)
      .post("/api/admin/reconcile")
      .set("x-demo-user", "ops-admin");
    expect(reconciled.body.processed).toBe(1);
    expect(projection(db)).toBe(490_000);
    expect(ledger.derivedAvailableBalance("acc-a")).toBe(490_000);
    expect(unbalancedEntryCount(db)).toBe(0);

    const categories = db
      .prepare("SELECT category FROM ledger_entries WHERE transfer_id = ? ORDER BY category")
      .all(created.body.id) as Array<{ category: string }>;
    expect(categories.map((row) => row.category).sort()).toEqual([
      "transfer_capture",
      "transfer_reservation",
    ]);
  });

  it("releases a failed reservation once and keeps projection equal to the ledger", async () => {
    class FailedStatusProvider implements TransferProvider {
      async send(input: ProviderTransferRequest): Promise<ProviderTransferResult> {
        return { providerReference: `provider-${input.clientReference}`, status: "accepted" };
      }

      async getStatus(): Promise<ProviderStatusResult> {
        return { status: "failed" };
      }
    }

    const app = createApp({ db, provider: new FailedStatusProvider() });
    const created = await request(app).post("/api/transfers").set(headers).send(transfer);
    expect(projection(db)).toBe(490_000);

    await Promise.all([
      request(app).post("/api/admin/reconcile").set("x-demo-user", "ops-admin"),
      request(app).post("/api/admin/reconcile").set("x-demo-user", "ops-admin"),
    ]);

    expect(projection(db)).toBe(500_000);
    expect(ledger.derivedAvailableBalance("acc-a")).toBe(500_000);
    expect(unbalancedEntryCount(db)).toBe(0);
    const releases = db
      .prepare("SELECT COUNT(*) AS count FROM ledger_entries WHERE transfer_id = ? AND category = 'transfer_release'")
      .get(created.body.id) as { count: number };
    expect(Number(releases.count)).toBe(1);
  });

  it("blocks a withdrawal when the balance projection has drifted from the ledger", async () => {
    db.prepare("UPDATE accounts SET balance = balance + 1 WHERE id = 'acc-a'").run();
    const provider = new FakeProvider();

    const response = await request(createApp({ db, provider }))
      .post("/api/transfers")
      .set(headers)
      .send(transfer);

    expect(response.status).toBe(503);
    expect(response.body.error).toContain("ledger integrity check failed");
    expect(provider.calls).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM transfers").get()).toMatchObject({ count: 0 });
  });

  it("blocks a withdrawal when any journal entry is unbalanced", async () => {
    db.prepare(`
      INSERT INTO ledger_entries (id, idempotency_key, transfer_id, category, description, created_at)
      VALUES ('corrupt-entry', 'corrupt-entry', NULL, 'opening', 'simulated corruption', ?)
    `).run(new Date().toISOString());
    db.prepare(`
      INSERT INTO ledger_lines (entry_id, account_code, side, amount)
      VALUES ('corrupt-entry', 'system:cash', 'debit', 1)
    `).run();
    const provider = new FakeProvider();

    const response = await request(createApp({ db, provider }))
      .post("/api/transfers")
      .set(headers)
      .send(transfer);

    expect(response.status).toBe(503);
    expect(response.body.error).toContain("is not balanced");
    expect(provider.calls).toHaveLength(0);
  });

  it("derives insufficient funds from the ledger before calling the provider", async () => {
    const provider = new FakeProvider();
    const response = await request(createApp({ db, provider }))
      .post("/api/transfers")
      .set(headers)
      .send({ ...transfer, amount: 500_001 });

    expect(response.status).toBe(422);
    expect(response.body.error).toBe("insufficient funds");
    expect(provider.calls).toHaveLength(0);
    expect(projection(db)).toBe(500_000);
    expect(ledger.derivedAvailableBalance("acc-a")).toBe(500_000);
    expect(db.prepare("SELECT COUNT(*) AS count FROM transfers").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM ledger_entries").get()).toMatchObject({ count: 2 });
  });

  it("enforces the append-only ledger at the database boundary", () => {
    const entry = db.prepare("SELECT id FROM ledger_entries ORDER BY id LIMIT 1").get() as { id: string };
    const line = db.prepare("SELECT id FROM ledger_lines ORDER BY id LIMIT 1").get() as { id: number };

    expect(() =>
      db.prepare("UPDATE ledger_entries SET description = 'tampered' WHERE id = ?").run(entry.id),
    ).toThrow(/ledger entries are immutable/);
    expect(() =>
      db.prepare("DELETE FROM ledger_lines WHERE id = ?").run(line.id),
    ).toThrow(/ledger lines are immutable/);
  });
});
