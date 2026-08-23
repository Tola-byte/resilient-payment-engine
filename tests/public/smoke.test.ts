import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { createDatabase, seedDatabase, type AppDatabase } from "../../src/server/db.js";
import { FakeProvider } from "../../src/server/provider.js";

describe("baseline smoke checks", () => {
  let db: AppDatabase;
  let provider: FakeProvider;

  beforeEach(() => {
    db = createDatabase();
    seedDatabase(db);
    provider = new FakeProvider();
  });

  afterEach(() => db.close());

  it("starts and reports health", async () => {
    const response = await request(createApp({ db, provider })).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("requires a demo identity on user routes", async () => {
    const response = await request(createApp({ db, provider })).get("/api/accounts");
    expect(response.status).toBe(401);
  });

  it("can create and list a transfer on the happy path", async () => {
    const app = createApp({ db, provider });
    const created = await request(app)
      .post("/api/transfers")
      .set("x-demo-user", "user-a")
      .set("Idempotency-Key", "public-test-1")
      .send({ debitAccountId: "acc-a", destinationAccount: "0123456789", amount: 10_000 });

    expect(created.status).toBe(201);
    expect(created.body.amount).toBe(10_000);

    const listed = await request(app).get("/api/transfers").set("x-demo-user", "user-a");
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
  });
});
