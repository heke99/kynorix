# Zoryqon delivery report

Delivery date: 2026-07-30  
Production decision: **NO-GO**

## Delivered

- PostgreSQL is the authoritative runtime store for customers, markets, orders,
  trades, positions, ledger journals, payment records, pricing, resolution,
  audit, sessions, notifications, outbox events, and reconciliation.
- Supabase Auth provides verified token identity, rotating refresh tokens, secure cookies, CSRF enforcement, session revocation, MFA evidence, role scopes, and server-side permissions instead of client-controlled identity.
- Order acceptance, cancellation, price-time matching, self-trade prevention,
  reservation, fill, fee, FIFO cost-basis, position, journal, and outbox writes
  share database transactions and idempotency boundaries.
- Payment and compliance adapters require configured providers, verify signed
  callbacks, and fail closed when configuration is incomplete.
- Web, operations, mobile, API, worker, contracts, database, deployment
  resources, OpenAPI, and runbooks use the same English production model.
- The repository includes an audited bootstrap CLI, immutable migration
  manifest, Kubernetes workload definitions and environment overlays.
- Scheduled definitions are materialised through durable, idempotent worker
  runs with tenant context, recurrence advancement and persisted failures.
- Binary complete sets lock full collateral and issue one position lot per
  outcome in the same transaction, subject to cumulative position limits.
- Withdrawal provider submission is claimed atomically before the external
  call and uses a stable provider idempotency key across retries.
- Resolution dispute windows and exactly-once settlement orchestration are
  implemented with durable claims, balanced journals and replay-safe state.

## Verification evidence

The repository baseline previously completed:

```bash
npm run verify
```

It ran formatting, forbidden-terminology verification, migration filename and
checksum verification, lint, TypeScript checks, six unit tests, integration and
end-to-end command wiring, and production builds for packages, API, worker, web,
operations, and mobile. The integration and end-to-end runners currently report
that no matching test files exist; this is a release blocker, not test evidence.

For the 2026-07-30 financial-core completion, the forbidden-terminology scan and
the three-migration filename/checksum manifest were run successfully. A clean
lockfile installation could not be completed in the delivery environment
because the package source returned integrity/checksum failures, so formatting,
TypeScript, test and build commands must be rerun in CI. A live Supabase project and its credentials are not available in this delivery environment, so the forward migration has not been applied to the user's remote database here.

## Remaining release blockers

- Automated price-index calculation still requires a licensed target-provider
  implementation and governance approval.
- Operations workflows outside the delivered read models, market lifecycle, and
  resolution action require complete screens and mutations.
- Database concurrency, webhook replay, settlement replay, tenant isolation,
  browser, and device integration suites have not been implemented.
- Legal classification, licences, policies, production provider accounts,
  custody ceremony, licensed price data, penetration/load/failover tests,
  backup restoration, disaster recovery, and operational drills need dated
  independent approval.

Do not accept production customer funds until every blocker in this report and
`docs/PRODUCTION_READINESS_REPORT.md` is closed with evidence.

## Migration safety

The baseline migration is appropriate only for an empty, unreleased database.
The Zoryqon rename changed its textual checksum. If the previous baseline has
ever been applied to a persistent environment, keep the exact applied baseline
and reconcile migration history before applying the new forward migration.
