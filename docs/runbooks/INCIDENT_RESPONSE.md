# Incident response runbook

1. Declare severity, incident reference, commander, affected tenants, assets,
   products, providers, and first known timestamp.
2. Preserve logs, audit events, database state, provider payload hashes, object
   evidence, and deployment digests.
3. Apply the narrowest available control: suspend a market, block withdrawals,
   block settlement, restrict an account, or stop publication.
4. Never mutate posted journals, completed provider events, audit rows, or
   resolution evidence.
5. Reconcile financial state before restoring any money-moving capability.
6. Require independent approval for ledger corrections, market voids, large
   refunds, and security unfreezes.
7. Communicate through approved legal, compliance, customer, and regulatory
   channels without exposing sensitive data.
8. Restore in stages, monitor invariants, record the decision evidence, and
   complete a blameless review with owned corrective actions.
