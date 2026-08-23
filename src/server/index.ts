import { createApp } from "./app.js";
import { createDatabase, seedDatabase } from "./db.js";
import { FakeProvider } from "./provider.js";

const db = createDatabase(process.env.DATABASE_FILE ?? "relaypay.sqlite");
seedDatabase(db);

const app = createApp({
  db,
  provider: new FakeProvider(),
  webhookSecret: process.env.WEBHOOK_SECRET ?? "local-webhook-secret",
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`RelayPay API listening on http://localhost:${port}`);
});
