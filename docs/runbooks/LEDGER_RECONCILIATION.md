# Ledger reconciliation runbook

Run at least daily and after every settlement batch.

1. Freeze the comparison window and asset.
2. Sum posted ledger accounts by normal side.
3. Compare available + locked + pending customer liabilities with source systems.
4. Compare collateral with maximum possible payout.
5. Compare every trade to exactly one posted journal.
6. Compare pending deposits/withdrawals with provider and chain state.
7. Open a reconciliation case for every non-zero unexplained difference.
8. For a critical difference, stop withdrawals and settlement automatically.
9. Record evidence, owner, decision, correcting journal and independent approval.
10. Never alter or delete an old entry; use a linked reversal/correction journal.
