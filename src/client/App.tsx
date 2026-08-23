import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

interface Account {
  id: string;
  name: string;
  balance: number;
}

interface Transfer {
  id: string;
  destinationAccount: string;
  amount: number;
  status: string;
  needsReconciliation: boolean;
  createdAt: string;
}

interface LedgerIntegrityResponse {
  verified: boolean;
}

const statuses = ["all", "pending", "uncertain", "succeeded", "failed", "reversed"] as const;
type StatusFilter = (typeof statuses)[number];

const headers = { "Content-Type": "application/json", "x-demo-user": "user-a" };
const money = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" });

export function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [destinationAccount, setDestinationAccount] = useState("0000000001");
  const [amount, setAmount] = useState("10000");
  const [message, setMessage] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [ledgerVerified, setLedgerVerified] = useState<boolean | null>(null);
  const pendingIntent = useRef<{
    fingerprint: string;
    idempotencyKey: string;
    transferId?: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const transferUrl = statusFilter === "all" ? "/api/transfers" : `/api/transfers?status=${statusFilter}`;
      const [accountResponse, transferResponse, integrityResponse] = await Promise.all([
        fetch("/api/accounts", { headers }),
        fetch(transferUrl, { headers }),
        fetch("/api/accounts/integrity", { headers }),
      ]);
      if (!accountResponse.ok || !transferResponse.ok) throw new Error("Could not load operations data");
      const nextAccounts = await accountResponse.json() as Account[];
      const nextTransfers = await transferResponse.json() as Transfer[];
      const integrity = await integrityResponse.json() as LedgerIntegrityResponse;
      setAccounts(nextAccounts);
      setTransfers(nextTransfers);
      setLedgerVerified(integrity.verified === true);

      const unresolvedTransferId = pendingIntent.current?.transferId;
      if (unresolvedTransferId) {
        const observed = nextTransfers.find((transfer) => transfer.id === unresolvedTransferId);
        if (observed && !["pending", "uncertain"].includes(observed.status)) {
          pendingIntent.current = null;
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load operations data");
      setLedgerVerified(null);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage("Sending…");
    const payload = {
      debitAccountId: accounts[0]?.id,
      destinationAccount,
      amount: Number(amount),
    };
    const fingerprint = JSON.stringify(payload);
    if (pendingIntent.current?.fingerprint !== fingerprint) {
      pendingIntent.current = { fingerprint, idempotencyKey: crypto.randomUUID() };
    }

    try {
      const response = await fetch("/api/transfers", {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": pendingIntent.current.idempotencyKey },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      setMessage(response.ok ? `Created ${result.id} (${result.status})` : result.error ?? "Request failed");
      const remainsUnresolved = response.status === 202 || result.status === "uncertain";
      if (remainsUnresolved) {
        pendingIntent.current.transferId = result.id;
      } else if (response.ok || response.status < 500) {
        pendingIntent.current = null;
      }
      if (response.ok) await refresh();
    } catch {
      setMessage("The transfer request could not be sent. Its outcome may be unknown; refresh before retrying.");
    }
  }

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">RelayPay</p>
          <h1>Transfer operations</h1>
          <p className="muted">A deliberately basic screen. Make operational risk visible.</p>
        </div>
        <span className="environment">Local sandbox</span>
      </header>

      <section className="grid">
        <article className="card balance">
          <p className="label">Available balance</p>
          <strong>{money.format((accounts[0]?.balance ?? 0) / 100)}</strong>
          <p className="muted">{accounts[0]?.id ?? "Loading account…"}</p>
          <span className={ledgerVerified === true ? "integrity verified" : ledgerVerified === false ? "integrity failed" : "integrity unknown"}>
            {ledgerVerified === true ? "Ledger verified" : ledgerVerified === false ? "Ledger mismatch" : "Ledger check unavailable"}
          </span>
        </article>

        <form className="card" onSubmit={submit}>
          <h2>New transfer</h2>
          <label>
            Destination account
            <input value={destinationAccount} onChange={(event) => setDestinationAccount(event.target.value)} />
          </label>
          <label>
            Amount in minor units
            <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="numeric" />
          </label>
          <button type="submit" disabled={!accounts.length}>Send transfer</button>
          <p className="message">{message}</p>
        </form>
      </section>

      <section className="card transfers">
        <div className="section-heading">
          <div>
            <p className="label">Activity</p>
            <h2>Transfers</h2>
          </div>
          <div className="actions">
            <label className="filter">
              Status
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
            <button className="secondary" onClick={() => void refresh()} disabled={loading}>Refresh</button>
          </div>
        </div>
        {error ? (
          <p className="error" role="alert">{error}</p>
        ) : loading ? (
          <p className="empty" aria-live="polite">Loading transfers…</p>
        ) : transfers.length === 0 ? (
          <p className="empty">No transfers yet.</p>
        ) : (
          <table>
            <thead><tr><th>Destination</th><th>Amount</th><th>Status</th><th>Attention</th><th>Created</th></tr></thead>
            <tbody>
              {transfers.map((transfer) => (
                <tr key={transfer.id} className={transfer.needsReconciliation ? "needs-reconciliation" : undefined}>
                  <td>{transfer.destinationAccount}</td>
                  <td>{money.format(transfer.amount / 100)}</td>
                  <td><span className={`status ${transfer.status}`}>{transfer.status}</span></td>
                  <td>{transfer.needsReconciliation ? <span className="attention">Reconcile</span> : "—"}</td>
                  <td>{new Date(transfer.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
