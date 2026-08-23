import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AppDatabase } from "./db.js";
import { LedgerService } from "./ledger-service.js";
import { asPublicTransfer, TransferError, TransferService } from "./transfer-service.js";
import { systemClock, type Clock, type TransferProvider, type TransferStatus } from "./types.js";

const transferInput = z.object({
  debitAccountId: z.string().min(1),
  destinationAccount: z.string().regex(/^\d{10}$/),
  amount: z.number().int().positive().safe(),
});

const idempotencyKeyInput = z.string().trim().min(1).max(200);
const transferStatusInput = z.enum(["pending", "uncertain", "succeeded", "failed", "reversed"]);
const webhookInput = z.object({
  eventId: z.string().trim().min(1).max(200),
  transferId: z.string().trim().min(1).max(200),
  status: z.enum(["pending", "succeeded", "failed"]),
});

interface AppOptions {
  db: AppDatabase;
  provider: TransferProvider;
  webhookSecret?: string;
  clock?: Clock;
  providerTimeoutMs?: number;
  reconciliationBatchSize?: number;
  reconciliationConcurrency?: number;
}

interface DemoRequest extends Request {
  demoUser?: string;
}

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

function authenticate(req: DemoRequest, res: Response, next: NextFunction): void {
  const user = req.header("x-demo-user");
  if (!user) {
    res.status(401).json({ error: "x-demo-user is required" });
    return;
  }
  req.demoUser = user;
  next();
}

function hasValidProviderSignature(req: RawBodyRequest, secret: string): boolean {
  const signature = req.header("x-provider-signature");
  if (!signature || !/^[a-f\d]{64}$/i.test(signature) || !req.rawBody) return false;

  const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest();
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

export function createApp({
  db,
  provider,
  webhookSecret = "local-webhook-secret",
  clock = systemClock,
  providerTimeoutMs = 5_000,
  reconciliationBatchSize = 50,
  reconciliationConcurrency = 5,
}: AppOptions) {
  const app = express();
  const ledger = new LedgerService(db);
  const transfers = new TransferService(
    db,
    provider,
    clock,
    ledger,
    providerTimeoutMs,
    reconciliationBatchSize,
    reconciliationConcurrency,
  );

  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        (req as RawBodyRequest).rawBody = Buffer.from(buffer);
      },
    }),
  );

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.get("/api/accounts/integrity", authenticate, (req: DemoRequest, res) => {
    const accounts = db
      .prepare("SELECT id FROM accounts WHERE owner_id = ? ORDER BY id")
      .all(req.demoUser!) as Array<{ id: string }>;
    const reports = accounts.map(({ id }) => {
      const report = ledger.integrityReport(id);
      return {
        accountId: id,
        balanced: report.balanced,
        projectionMatches: report.projectionMatches,
        availableLedgerBalance: report.availableLedgerBalance,
        balanceProjection: report.balanceProjection,
      };
    });
    const verified = reports.every((report) => report.balanced && report.projectionMatches);
    res.status(verified ? 200 : 503).json({ verified, accounts: reports });
  });

  app.get("/api/accounts", authenticate, (req: DemoRequest, res) => {
    const rows = db
      .prepare("SELECT id, name, balance FROM accounts WHERE owner_id = ? ORDER BY id")
      .all(req.demoUser!);
    res.json(rows);
  });

  app.get("/api/transfers", authenticate, (req: DemoRequest, res) => {
    const rawStatus = typeof req.query.status === "string" ? req.query.status : undefined;
    const parsedStatus = rawStatus ? transferStatusInput.safeParse(rawStatus) : null;
    if (parsedStatus && !parsedStatus.success) {
      res.status(400).json({ error: "invalid transfer status" });
      return;
    }

    const status = parsedStatus?.data as TransferStatus | undefined;
    const rows = status
      ? db.prepare("SELECT * FROM transfers WHERE owner_id = ? AND status = ? ORDER BY created_at DESC").all(req.demoUser!, status)
      : db.prepare("SELECT * FROM transfers WHERE owner_id = ? ORDER BY created_at DESC").all(req.demoUser!);
    res.json(rows.map((row) => asPublicTransfer(row as Record<string, unknown>)));
  });

  app.post("/api/transfers", authenticate, async (req: DemoRequest, res) => {
    const parsed = transferInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid transfer", details: parsed.error.issues });
      return;
    }

    const parsedKey = idempotencyKeyInput.safeParse(req.header("idempotency-key"));
    if (!parsedKey.success) {
      res.status(400).json({ error: "Idempotency-Key header is required" });
      return;
    }

    try {
      const result = await transfers.initiate(req.demoUser!, parsedKey.data, parsed.data);
      res.status(result.statusCode).json(result.transfer);
    } catch (error) {
      if (error instanceof TransferError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.post("/api/provider/webhook", (req: RawBodyRequest, res) => {
    if (!hasValidProviderSignature(req, webhookSecret)) {
      res.status(401).json({ error: "invalid provider signature" });
      return;
    }

    const parsed = webhookInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid provider event", details: parsed.error.issues });
      return;
    }

    const result = transfers.processProviderEvent(parsed.data);
    if (result.outcome === "not_found") {
      res.status(404).json({ error: "transfer not found", duplicate: false });
      return;
    }
    res.json({ received: true, duplicate: result.duplicate, outcome: result.outcome });
  });

  app.post("/api/admin/reconcile", authenticate, async (req: DemoRequest, res) => {
    if (req.demoUser !== "ops-admin") {
      res.status(403).json({ error: "ops-admin access required" });
      return;
    }

    const summary = await transfers.reconcile();
    res.json(summary);
  });

  return app;
}
