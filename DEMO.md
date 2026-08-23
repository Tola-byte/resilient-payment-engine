# RelayPay interview demo

This walkthrough demonstrates the important guarantees in about five minutes.
Run it from the repository root with Node.js 22 or newer.

## 1. Start a clean local environment

Use a new database filename for each demonstration:

```bash
DATABASE_FILE=/tmp/relaypay-interview.sqlite npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The balance card should show
₦5,000.00 and **Ledger verified**.

Talking point:

> The journal is authoritative. The balance displayed here is a fast projection,
> and the integrity endpoint verifies that the projection still agrees with the
> ledger.

## 2. Create a normal transfer

Use destination `0000000001` and amount `10000` minor units in the UI.

Expected result:

- the transfer is `pending`;
- the available balance falls by ₦100.00 immediately;
- the reservation is visible in the ledger-derived integrity check;
- refreshing or filtering does not change the financial result.

Then reconcile it:

```bash
curl -s -X POST http://localhost:3001/api/admin/reconcile \
  -H 'x-demo-user: ops-admin'
```

The transfer becomes `succeeded`. The user's balance does not decrease again
because capture clears transfer payable against system cash.

## 3. Demonstrate an immediate rejection

Create a transfer whose destination ends in `99`, for example
`0000000099`.

Expected result:

- status becomes `failed`;
- the reservation is released;
- the available balance returns to its previous value;
- exactly one release journal entry exists.

## 4. Demonstrate an ambiguous provider outcome

Create a transfer whose destination ends in `88`, for example
`0000000088`.

Expected result:

- the provider accepts the stable client reference but its response is lost;
- the API returns `202`;
- status becomes `uncertain`, not `failed`;
- funds remain reserved;
- the UI marks the record for reconciliation.

Run the reconciliation command again. The fake provider can look up the stable
client reference, so the transfer becomes `succeeded`.

Talking point:

> A timeout describes what the caller observed, not what the provider did.
> Releasing funds or retrying under a new identity would risk sending money
> twice, so RelayPay preserves uncertainty until it learns a definite outcome.

## 5. Demonstrate API idempotency

Send the same request twice with the same key:

```bash
curl -s -X POST http://localhost:3001/api/transfers \
  -H 'content-type: application/json' \
  -H 'x-demo-user: user-a' \
  -H 'idempotency-key: interview-duplicate' \
  -d '{"debitAccountId":"acc-a","destinationAccount":"0000000002","amount":1000}'

curl -s -X POST http://localhost:3001/api/transfers \
  -H 'content-type: application/json' \
  -H 'x-demo-user: user-a' \
  -H 'idempotency-key: interview-duplicate' \
  -d '{"debitAccountId":"acc-a","destinationAccount":"0000000002","amount":1000}'
```

Both responses contain the same transfer ID. The second call returns the
durable original operation rather than sending another provider instruction.

Reuse that key with a different amount:

```bash
curl -i -X POST http://localhost:3001/api/transfers \
  -H 'content-type: application/json' \
  -H 'x-demo-user: user-a' \
  -H 'idempotency-key: interview-duplicate' \
  -d '{"debitAccountId":"acc-a","destinationAccount":"0000000002","amount":2000}'
```

Expected result: HTTP `409 Conflict` and no new side effect.

## 6. Show the integrity report

```bash
curl -s http://localhost:3001/api/accounts/integrity \
  -H 'x-demo-user: user-a'
```

Expected shape:

```json
{
  "verified": true,
  "accounts": [
    {
      "accountId": "acc-a",
      "balanced": true,
      "projectionMatches": true,
      "availableLedgerBalance": 479000,
      "balanceProjection": 479000
    }
  ]
}
```

The exact balance depends on which demo transfers were created. The important
properties are `balanced: true`, `projectionMatches: true`, and equality of
the two balances.

## 7. Close with the honest production boundary

> SQLite and the payment provider cannot participate in one atomic commit. The
> next production change is a transactional outbox written with the reservation,
> an at-least-once dispatcher, and provider-side deduplication of the stable
> client reference. I do not claim distributed exactly-once delivery.

Supporting design material:

- [RISK_NOTES.md](./RISK_NOTES.md)
- [DECISIONS.md](./DECISIONS.md)
