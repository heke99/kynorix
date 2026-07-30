# Resolution runbook

1. Confirm market is the expected tenant and immutable rule version.
2. Transition `open → closing`; cancel all remaining orders and release locks.
3. Verify final fill sequence and ledger journals.
4. Capture the primary and backup source with timestamps and content hashes.
5. If sources are stale, missing or contradictory, stop at manual review.
6. A resolution officer proposes an outcome and attaches evidence.
7. A different officer independently reproduces the decision.
8. Open the configured dispute period. Do not settle early in production.
9. Lock the outcome, transition `resolved → settling`, and execute idempotent settlement.
10. Reconcile collateral, positions and journals; then transition to `settled`.
11. Publish the evidence bundle and notify affected users through the outbox.

Never edit a rule, source, fee or time window to make evidence fit an outcome.
Void and extraordinary refunds require the same independent approval.
