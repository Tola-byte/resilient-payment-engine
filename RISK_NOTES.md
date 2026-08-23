# RelayPay risk notes

The ranking below prioritises loss of money, duplicate external instructions, and
loss of an audit/recovery path over style or framework concerns.

## P0 — duplicate provider instructions and duplicate debits

The baseline implementation performs a check-then-act idempotency lookup, calls the provider,
and only then inserts the transfer. Two requests can both observe no transfer
and both send money. The optional key and lack of a database uniqueness
constraint make this possible across both concurrent handlers and application
instances.

**Broken invariants:** one `(owner, idempotency key)` represents one request;
one logical request creates at most one provider instruction and one debit.

## P0 — debit-account authorization is missing

The caller can supply another user's account ID. The account is looked up by ID
without checking `owner_id`, allowing `user-a` to transfer from `user-b`.

**Broken invariant:** only the owner of the debit account can initiate a transfer.

## P0 — balance updates are racy and non-atomic

The balance check, provider instruction, debit, and transfer insert are separate
operations. Concurrent transfers can both pass the balance check. A later write
failure can also leave the provider instructed without a durable local record.

**Broken invariants:** balances never become negative; every local money change
has a durable transfer record; a transfer's financial effect is applied once.

## P0 — an accepted transfer can be reported as failed

The fake provider models “accepted, then response lost” by throwing. The baseline
returns `502` and persists nothing, inviting a client retry that can instruct the
provider again.

**Broken invariant:** lack of a response is not evidence of failure. Ambiguous
outcomes remain durable and explicitly `uncertain` until reconciled.

## P0 — callbacks are unauthenticated and accept arbitrary states

Anyone can currently set any transfer to any string. The route neither verifies
the exact request bytes with HMAC nor limits legal state transitions.

**Broken invariants:** only the provider can report provider outcomes; terminal
states cannot be overwritten; external input cannot invent internal states.

## P1 — callbacks and reconciliation can apply effects repeatedly

Although a webhook table exists, events are not inserted into it. Reconciliation
credits the account before changing status, so two workers can both reverse the
same debit.

**Broken invariants:** each provider event is processed once; captured funds are
released at most once; concurrent workers converge on the same result.

## P1 — amount validation does not enforce minor-unit integers

`positive()` accepts fractions. A value such as `10.5` is not a valid integer
minor-unit amount and creates unclear rounding/accounting behaviour.

**Broken invariant:** every persisted and provider-sent amount is the exact same
positive integer minor-unit value supplied by the client.

## P1 — sensitive account fields are returned

`SELECT *` exposes the provider token and BVN through `/api/accounts`.

**Broken invariant:** API responses contain only data needed by the caller.

## P2 — operations state is hard to interpret

The UI does not distinguish loading from an empty result, does not report fetch
errors, cannot filter status, and does not identify uncertain records requiring
reconciliation.

**Operational impact:** delayed detection and recovery when provider outcomes
are ambiguous.
