# RelayPay decisions

## Invariants

- `(owner_id, idempotency_key)` is unique and stores a SHA-256 fingerprint of
  the canonical request.
- Reusing the key with a different fingerprint returns `409` before any new
  balance or provider effect.
- Every ledger entry has at least two lines and equal integer debits and credits.
- Ledger entries and lines are append-only; SQLite triggers reject updates and
  deletes even if application code attempts them.
- The append-only ledger is the financial source of truth. `accounts.balance`
  is a fast available-balance projection and must equal the user's ledger-derived
  available balance before and after every money transition.
- Sufficient funds is decided from the ledger-derived available balance. The
  guarded projection update is retained as concurrency control.
- A transfer reservation, its ledger entry, and its balance projection reduction
  commit atomically.
- A transfer's funds move from `reserved` to exactly one terminal financial
  disposition: `captured` or `released`.
- Only `pending` and `uncertain` transfers may be settled or reversed.
- Provider webhook event IDs are durably unique.
- Amounts are positive integer minor units from validation through persistence
  and provider calls.
- A client retry for the same unresolved transfer intent reuses its idempotency
  key rather than creating a new logical operation.

## State machine

```text
pending ───────► succeeded
   │                  (funds captured)
   ├──────────► failed
   │                  (immediate rejection; funds released)
   ├──────────► reversed
   │                  (asynchronous failure; funds released)
   └──────────► uncertain ─────► succeeded
                         └─────► reversed
                                (funds released)
```

`failed` represents a synchronous rejection returned by `provider.send`;
`reversed` represents a later failure learned through a callback or status
query, which can arrive while the local state is still `pending` or after it
became `uncertain`. Terminal states do not transition automatically. A
contradictory late callback is recorded and ignored for manual investigation
rather than silently moving money again.

## Transaction boundaries

Transfer initiation uses a short `BEGIN IMMEDIATE` transaction to claim the
idempotency key, verify account ownership, verify journal integrity, compare the
user's ledger balance with its projection, check ledger funds, conditionally
reduce the projection, insert a `pending` transfer, and post its balanced
reservation entry. The provider call happens after commit. A second short
transaction records `accepted`, `rejected`, or `uncertain` and atomically posts
capture or release entries when required.

Webhook deduplication and its transfer transition happen in one transaction.
Reconciliation reads a bounded candidate batch, queries the provider outside
the transaction with capped concurrency, then locks SQLite for short
compare-and-transition transactions. The transaction re-reads the current
transfer state before changing balance, so a webhook and concurrent workers can
query the same transfer but cannot settle or reverse it twice. The returned
`remaining` count makes backlog visible to an operator or future worker loop.

## Ledger model

The ledger uses named accounts and immutable-by-convention journal entries with
positive integer minor-unit lines:

| Event | Debit | Credit |
| --- | --- | --- |
| Opening balance | RelayPay cash | User available liability |
| Reserve transfer | User available liability | Transfer payable liability |
| Capture transfer | Transfer payable liability | RelayPay cash |
| Release failed transfer | Transfer payable liability | User available liability |

Reservation reduces the user's available ledger balance immediately. Capture
therefore does not debit the user a second time; it clears the payable against
cash. Release restores available funds exactly once. Each financial entry has a
unique semantic key such as `transfer:<id>:release`, while the guarded transfer
state machine prevents a second terminal disposition.

For this compact implementation, withdrawal performs a full balanced-entry integrity
scan before spending. That makes corruption fail closed and keeps the invariant
easy to demonstrate, but it is O(journal history). At scale, posting would be
enforced by a single database function/transaction, integrity would be monitored
continuously, and requests would validate the relevant account against a trusted
checkpoint rather than rescan all history. The scan currently runs while
`BEGIN IMMEDIATE` holds SQLite's serialized write path, so its growing latency
would eventually block unrelated writers; that placement is an intentional
reference-scale trade-off, not a production scaling claim.

## Accepted by provider, response lost, callback delayed

The reservation already exists with a stable transfer ID stored and used as the
provider client reference. A timeout changes the transfer to `uncertain` and
returns that truth to the client; it does not claim failure or release funds. A
later signed callback or reconciliation query can capture or release the
reservation once.
Provider calls have a local deadline so an adapter that hangs without rejecting
cannot hold the HTTP request or reconciliation batch forever. That deadline does
not cancel or prove failure of the remote operation.

This is not distributed exactly-once delivery. SQLite and the provider do not
share a transaction. The enforceable guarantees are a unique local claim,
at-most-one provider call by concurrent HTTP requests, idempotent local effects,
a stable provider client reference, and eventual reconciliation of provider
outcomes that can be looked up. A process crash between reserving and beginning
the provider call remains a known limitation; a crash immediately after sending
is observationally ambiguous because the process cannot know whether the
provider accepted the instruction. Reconciliation only queries status—it does
not redrive sends—so a never-sent reservation can remain `pending` and reserved.
Production would atomically create a transactional-outbox job with the
reservation, retry delivery, and require the provider to deduplicate the stable
client reference. The provider adapter must also support status lookup by that
reference when its own acknowledgement was lost.

Client retries have the same ambiguity boundary. The UI retains the
idempotency key for unchanged form data after a network error, 5xx response, or
`202 uncertain` result. HTTP acceptance is not financial finality. The key is
replaced only after a terminal result is observed or the user changes the
transfer intent.

Webhook event IDs are the provider's deduplication key. Even if a provider were
to resend the same logical notification under a different event ID, the guarded
transfer state and funds state remain the financial backstop: the event is
audited but cannot apply money twice.

## Scaling beyond local SQLite

- Replace SQLite with PostgreSQL, unique indexes, row-level locks, and guarded
  updates such as `UPDATE ... WHERE funds_state = 'reserved'`.
- Write an outbox job in the same transaction as the transfer reservation.
- Dispatch through a durable queue with leases, retries, and dead-lettering.
- Require the provider to deduplicate the stable client reference.
- Run horizontally scaled reconciliation workers using `FOR UPDATE SKIP LOCKED`
  or explicit work leases.
- Preserve the journal as the source of truth, enforce balanced posting in the
  database, and rebuild/check balance projections from ledger checkpoints.

## Observability and audit

Structured logs would include a request/trace ID, transfer ID, hashed user ID,
idempotency-key hash, state transition, provider reference, event ID, latency,
and outcome—never BVNs, provider tokens, or full destination details.

Metrics and alerts would cover transfer counts by state, provider latency/error
rate, uncertain-transfer age, reconciliation backlog and failures, signature
failures, idempotency conflicts, insufficient-funds attempts, and illegal state
transition attempts. Ledger-specific alerts would cover unbalanced-entry checks,
projection drift, payable aging, and failed journal posts. The ledger records
financial facts; a separate append-only transition/audit table would record
actor, source, old/new state, reason, and timestamp.

For the operations UI, an authenticated owner-scoped integrity endpoint exposes
only the balanced/projection-match result and the owner's two balance values.
It deliberately does not expose journal entries, system accounts, or other
users' data.

Wall-clock timestamps support display, aging, and operational recovery; they do
not decide financial conflicts or terminal-state precedence. Correctness comes
from unique keys, database serialization, and guarded state transitions rather
than assuming synchronized clocks.

## Known limitations and next three changes

1. Add a transactional outbox/dispatcher to close the crash window between the
   local reservation and provider call, including stale-reservation detection.
2. Replace demo-header identity with authenticated principals and scoped roles.
3. Move the existing double-entry model to PostgreSQL, enforce journal posting
   through a restricted database function, add durable worker leases, and test
   failover across real processes.

## Authorship and AI assistance

The author directed the design rather than delegating the project wholesale.
They brought relevant ideas from an earlier Ondesk backend project, questioned
whether account balances should be trusted independently of the ledger, and
proposed verifying both global journal balance and agreement between each
user's ledger-derived balance and database projection before withdrawal. They
also asked for the design to be challenged using Martin Kleppmann's *Designing
Data-Intensive Applications* principles, especially partial failure,
idempotence, derived data, transaction boundaries, backpressure, and the limits
of distributed exactly-once claims. The author repeatedly questioned scope and
trade-offs—including whether the ledger work was proportionate to the intended
scope and which production concerns should remain documented rather than
implemented—and requested independent Claude reviews. They specifically
challenged how easily the system could switch third-party payment providers.
That prompted verification of the `TransferProvider` port, constructor-based
dependency injection, canonical provider status mapping, and the requirement
that adapters support a stable client reference for idempotency and status
lookup. The discussion also identified provider-specific webhook authentication
as the remaining coupling that should move behind an adapter boundary before
claiming complete provider portability.

OpenAI Codex helped audit the baseline, translate those directions and prior
experience into explicit invariants, formulate the state machine and transaction
boundaries, implement the focused code and tests, explain the patterns, and
review the final diff. Claude Code independently reviewed the implementation and
identified missing local deadlines around provider calls and assumptions about
client-reference status lookup. A later Claude Opus 4.8 high-effort DDIA-style
review challenged the crash-recovery, backpressure, ledger, concurrency, and
client-retry claims.

AI suggestions were checked against the code instead of accepted automatically.
For example, bounded reconciliation and additional race tests were adopted, one
incorrect Claude claim that the initial provider reference was null was rejected,
and a valid final finding that `202 uncertain` must retain the client's intent
key was fixed and reverified. The author remains responsible for understanding,
validating, and defending every submitted line.
