import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { createDatabase, seedDatabase, type AppDatabase } from "../../src/server/db.js";
import { FakeProvider } from "../../src/server/provider.js";
import type { ProviderStatusResult, ProviderTransferRequest, ProviderTransferResult, TransferProvider } from "../../src/server/types.js";

const userHeaders = { "x-demo-user": "user-a", "Idempotency-Key": "safety-key" };
const validTransfer = {
  debitAccountId: "acc-a",
  destinationAccount: "0123456789",
  amount: 10_000,
};
const webhookSecret = "test-webhook-secret";

function balance(db: AppDatabase, accountId = "acc-a"): number {
  const row = db.prepare("SELECT balance FROM accounts WHERE id = ?").get(accountId) as { balance: number };
  return Number(row.balance);
}

function signedWebhook(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const signature = crypto.createHmac("sha256", webhookSecret).update(raw).digest("hex");
  return request(app)
    .post("/api/provider/webhook")
    .set("Content-Type", "application/json")
    .set("x-provider-signature", signature)
    .send(raw);
}

describe("transfer safety contracts", () => {
  let db: AppDatabase;
  let provider: FakeProvider;

  beforeEach(() => {
    db = createDatabase();
    seedDatabase(db);
    provider = new FakeProvider();
  });

  afterEach(() => db.close());

  it("returns only public account fields", async () => {
    const response = await request(createApp({ db, provider }))
      .get("/api/accounts")
      .set("x-demo-user", "user-a");

    expect(response.status).toBe(200);
    expect(response.body[0]).toEqual({ id: "acc-a", name: "Tobi Demo", balance: 500_000 });
    expect(response.body[0]).not.toHaveProperty("provider_token");
    expect(response.body[0]).not.toHaveProperty("bvn");
  });

  it("requires an idempotency key and positive integer minor units", async () => {
    const app = createApp({ db, provider });

    const missingKey = await request(app).post("/api/transfers").set("x-demo-user", "user-a").send(validTransfer);
    const fractional = await request(app)
      .post("/api/transfers")
      .set(userHeaders)
      .send({ ...validTransfer, amount: 10.5 });
    const zero = await request(app)
      .post("/api/transfers")
      .set({ ...userHeaders, "Idempotency-Key": "zero-key" })
      .send({ ...validTransfer, amount: 0 });

    expect(missingKey.status).toBe(400);
    expect(fractional.status).toBe(400);
    expect(zero.status).toBe(400);
    expect(provider.calls).toHaveLength(0);
    expect(balance(db)).toBe(500_000);
  });

  it("prevents a user from debiting another owner's account", async () => {
    const response = await request(createApp({ db, provider }))
      .post("/api/transfers")
      .set(userHeaders)
      .send({ ...validTransfer, debitAccountId: "acc-b" });

    expect(response.status).toBe(403);
    expect(provider.calls).toHaveLength(0);
    expect(balance(db, "acc-b")).toBe(250_000);
  });

  it("returns one transfer and performs one provider call and debit for concurrent duplicates", async () => {
    const app = createApp({ db, provider });
    const [first, second] = await Promise.all([
      request(app).post("/api/transfers").set(userHeaders).send(validTransfer),
      request(app).post("/api/transfers").set(userHeaders).send(validTransfer),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(first.body.id).toBe(second.body.id);
    expect(provider.calls).toHaveLength(1);
    expect(balance(db)).toBe(490_000);
    expect(db.prepare("SELECT COUNT(*) AS count FROM transfers").get()).toMatchObject({ count: 1 });
  });

  it("rejects reuse of a key for a different request without another side effect", async () => {
    const app = createApp({ db, provider });
    const first = await request(app).post("/api/transfers").set(userHeaders).send(validTransfer);
    const conflict = await request(app)
      .post("/api/transfers")
      .set(userHeaders)
      .send({ ...validTransfer, amount: 20_000 });

    expect(first.status).toBe(201);
    expect(conflict.status).toBe(409);
    expect(provider.calls).toHaveLength(1);
    expect(balance(db)).toBe(490_000);
  });

  it("records an immediate provider rejection and releases the reservation", async () => {
    const response = await request(createApp({ db, provider }))
      .post("/api/transfers")
      .set(userHeaders)
      .send({ ...validTransfer, destinationAccount: "0123456799" });

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("failed");
    expect(provider.calls).toHaveLength(1);
    expect(balance(db)).toBe(500_000);
    expect(db.prepare("SELECT funds_state FROM transfers WHERE id = ?").get(response.body.id)).toMatchObject({
      funds_state: "released",
    });
  });

  it("persists an accepted-but-timed-out instruction as uncertain and reconciles it once", async () => {
    const app = createApp({ db, provider });
    const uncertain = await request(app)
      .post("/api/transfers")
      .set(userHeaders)
      .send({ ...validTransfer, destinationAccount: "0123456788" });
    const repeated = await request(app)
      .post("/api/transfers")
      .set(userHeaders)
      .send({ ...validTransfer, destinationAccount: "0123456788" });

    expect(uncertain.status).toBe(202);
    expect(uncertain.body.status).toBe("uncertain");
    expect(repeated.body.id).toBe(uncertain.body.id);
    expect(provider.calls).toHaveLength(1);
    expect(balance(db)).toBe(490_000);

    const [firstRecon, secondRecon] = await Promise.all([
      request(app).post("/api/admin/reconcile").set("x-demo-user", "ops-admin"),
      request(app).post("/api/admin/reconcile").set("x-demo-user", "ops-admin"),
    ]);
    expect(firstRecon.status).toBe(200);
    expect(secondRecon.status).toBe(200);
    expect(firstRecon.body.processed + secondRecon.body.processed).toBe(1);
    expect(balance(db)).toBe(490_000);
    expect(db.prepare("SELECT status FROM transfers WHERE id = ?").get(uncertain.body.id)).toMatchObject({ status: "succeeded" });
  });

  it("bounds a provider that hangs without rejecting and preserves uncertainty", async () => {
    class HangingProvider implements TransferProvider {
      async send(): Promise<ProviderTransferResult> {
        return new Promise(() => undefined);
      }

      async getStatus(): Promise<ProviderStatusResult> {
        return new Promise(() => undefined);
      }
    }

    const app = createApp({ db, provider: new HangingProvider(), providerTimeoutMs: 10 });
    const initiated = await request(app)
      .post("/api/transfers")
      .set(userHeaders)
      .send(validTransfer);

    expect(initiated.status).toBe(202);
    expect(initiated.body.status).toBe("uncertain");
    expect(balance(db)).toBe(490_000);

    const reconciled = await request(app)
      .post("/api/admin/reconcile")
      .set("x-demo-user", "ops-admin");
    expect(reconciled.body).toMatchObject({ examined: 1, processed: 0, errors: 1 });
    expect(balance(db)).toBe(490_000);
  });

  it("restricts reconciliation to ops-admin", async () => {
    const response = await request(createApp({ db, provider }))
      .post("/api/admin/reconcile")
      .set("x-demo-user", "user-a");
    expect(response.status).toBe(403);
  });

  it("verifies exact-body HMAC, deduplicates events, and ignores a contradictory late callback", async () => {
    const app = createApp({ db, provider, webhookSecret });
    const created = await request(app).post("/api/transfers").set(userHeaders).send(validTransfer);
    const body = { eventId: "event-1", transferId: created.body.id, status: "succeeded" };

    const invalid = await request(app)
      .post("/api/provider/webhook")
      .set("x-provider-signature", "0".repeat(64))
      .send(body);
    const accepted = await signedWebhook(app, body);
    const duplicate = await signedWebhook(app, body);
    const contradictory = await signedWebhook(app, { ...body, eventId: "event-2", status: "failed" });

    expect(invalid.status).toBe(401);
    expect(accepted.body).toMatchObject({ received: true, duplicate: false, outcome: "transitioned" });
    expect(duplicate.body).toMatchObject({ received: true, duplicate: true });
    expect(contradictory.body).toMatchObject({ received: true, outcome: "ignored" });
    expect(balance(db)).toBe(490_000);
    expect(db.prepare("SELECT status FROM transfers WHERE id = ?").get(created.body.id)).toMatchObject({ status: "succeeded" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM webhook_events").get()).toMatchObject({ count: 2 });
  });

  it.each([
    { providerStatus: "succeeded" as const, expectedStatus: "succeeded", ledgerCategory: "transfer_capture", expectedBalance: 490_000 },
    { providerStatus: "failed" as const, expectedStatus: "reversed", ledgerCategory: "transfer_release", expectedBalance: 500_000 },
  ])(
    "applies $providerStatus once when a webhook races reconciliation",
    async ({ providerStatus, expectedStatus, ledgerCategory, expectedBalance }) => {
      let announceLookup!: () => void;
      const lookupStarted = new Promise<void>((resolve) => {
        announceLookup = resolve;
      });
      let finishLookup!: () => void;
      const lookupResult = new Promise<ProviderStatusResult>((resolve) => {
        finishLookup = () => resolve({ status: providerStatus });
      });

      class RacingProvider implements TransferProvider {
        async send(input: ProviderTransferRequest): Promise<ProviderTransferResult> {
          return { providerReference: `race-${input.clientReference}`, status: "accepted" };
        }

        async getStatus(): Promise<ProviderStatusResult> {
          announceLookup();
          return lookupResult;
        }
      }

      const app = createApp({ db, provider: new RacingProvider(), webhookSecret });
      const created = await request(app).post("/api/transfers").set(userHeaders).send(validTransfer);
      const reconciliation = request(app)
        .post("/api/admin/reconcile")
        .set("x-demo-user", "ops-admin")
        .then((response) => response);

      await lookupStarted;
      const webhook = await signedWebhook(app, {
        eventId: `race-${providerStatus}`,
        transferId: created.body.id,
        status: providerStatus,
      });
      finishLookup();
      const reconciled = await reconciliation;

      expect(webhook.body.outcome).toBe("transitioned");
      expect(reconciled.body.processed).toBe(0);
      expect(balance(db)).toBe(expectedBalance);
      expect(db.prepare("SELECT status FROM transfers WHERE id = ?").get(created.body.id)).toMatchObject({
        status: expectedStatus,
      });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM ledger_entries WHERE transfer_id = ? AND category = ?")
          .get(created.body.id, ledgerCategory),
      ).toMatchObject({ count: 1 });
    },
  );

  it("keeps a provider-pending transfer reserved for later reconciliation", async () => {
    class PendingProvider implements TransferProvider {
      async send(input: ProviderTransferRequest): Promise<ProviderTransferResult> {
        return { providerReference: `pending-${input.clientReference}`, status: "accepted" };
      }

      async getStatus(): Promise<ProviderStatusResult> {
        return { status: "pending" };
      }
    }

    const app = createApp({ db, provider: new PendingProvider() });
    const created = await request(app).post("/api/transfers").set(userHeaders).send(validTransfer);
    const reconciled = await request(app)
      .post("/api/admin/reconcile")
      .set("x-demo-user", "ops-admin");

    expect(reconciled.body).toMatchObject({ examined: 1, processed: 0, errors: 0, remaining: 1 });
    expect(balance(db)).toBe(490_000);
    expect(db.prepare("SELECT status, funds_state FROM transfers WHERE id = ?").get(created.body.id)).toMatchObject({
      status: "pending",
      funds_state: "reserved",
    });
  });

  it("bounds both reconciliation batch size and provider concurrency", async () => {
    class CountingProvider implements TransferProvider {
      statusCalls = 0;
      activeCalls = 0;
      maxActiveCalls = 0;

      async send(input: ProviderTransferRequest): Promise<ProviderTransferResult> {
        return { providerReference: `batch-${input.clientReference}`, status: "accepted" };
      }

      async getStatus(): Promise<ProviderStatusResult> {
        this.statusCalls += 1;
        this.activeCalls += 1;
        this.maxActiveCalls = Math.max(this.maxActiveCalls, this.activeCalls);
        await new Promise((resolve) => setTimeout(resolve, 5));
        this.activeCalls -= 1;
        return { status: "succeeded" };
      }
    }

    const countingProvider = new CountingProvider();
    const app = createApp({
      db,
      provider: countingProvider,
      reconciliationBatchSize: 3,
      reconciliationConcurrency: 2,
    });
    for (let index = 0; index < 4; index += 1) {
      await request(app)
        .post("/api/transfers")
        .set({ ...userHeaders, "Idempotency-Key": `batch-${index}` })
        .send({ ...validTransfer, amount: 1_000 });
    }

    const first = await request(app)
      .post("/api/admin/reconcile")
      .set("x-demo-user", "ops-admin");
    expect(first.body).toMatchObject({ examined: 3, processed: 3, errors: 0, remaining: 1 });
    expect(countingProvider.statusCalls).toBe(3);
    expect(countingProvider.maxActiveCalls).toBe(2);

    const second = await request(app)
      .post("/api/admin/reconcile")
      .set("x-demo-user", "ops-admin");
    expect(second.body).toMatchObject({ examined: 1, processed: 1, errors: 0, remaining: 0 });
    expect(countingProvider.statusCalls).toBe(4);
  });

  it("releases reserved funds once when concurrent reconciliation reports failure", async () => {
    class FailingStatusProvider implements TransferProvider {
      calls: ProviderTransferRequest[] = [];

      async send(input: ProviderTransferRequest): Promise<ProviderTransferResult> {
        this.calls.push(input);
        return { providerReference: `failed-${input.clientReference}`, status: "accepted" };
      }

      async getStatus(): Promise<ProviderStatusResult> {
        return { status: "failed" };
      }
    }

    const failingProvider = new FailingStatusProvider();
    const app = createApp({ db, provider: failingProvider });
    const created = await request(app).post("/api/transfers").set(userHeaders).send(validTransfer);
    expect(balance(db)).toBe(490_000);

    await Promise.all([
      request(app).post("/api/admin/reconcile").set("x-demo-user", "ops-admin"),
      request(app).post("/api/admin/reconcile").set("x-demo-user", "ops-admin"),
    ]);

    expect(balance(db)).toBe(500_000);
    expect(db.prepare("SELECT status, funds_state FROM transfers WHERE id = ?").get(created.body.id)).toMatchObject({
      status: "reversed",
      funds_state: "released",
    });
  });
});

describe("multiple application instances", () => {
  it("uses SQLite as the shared idempotency arbiter", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relaypay-test-"));
    const filename = join(directory, "shared.sqlite");
    const firstDb = createDatabase(filename);
    seedDatabase(firstDb);
    const secondDb = createDatabase(filename);
    const provider = new FakeProvider();

    try {
      const firstApp = createApp({ db: firstDb, provider });
      const secondApp = createApp({ db: secondDb, provider });
      const [first, second] = await Promise.all([
        request(firstApp).post("/api/transfers").set(userHeaders).send(validTransfer),
        request(secondApp).post("/api/transfers").set(userHeaders).send(validTransfer),
      ]);

      expect([first.status, second.status].sort()).toEqual([200, 201]);
      expect(first.body.id).toBe(second.body.id);
      expect(provider.calls).toHaveLength(1);
      expect(balance(firstDb)).toBe(490_000);
    } finally {
      secondDb.close();
      firstDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
