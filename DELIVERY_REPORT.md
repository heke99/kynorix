# Kynorix delivery report

Delivery date: 2026-07-30  
Production decision: **NO-GO**

## Delivered

- PostgreSQL is the authoritative runtime store for customers, markets, orders,
  trades, positions, ledger journals, payment records, pricing, resolution,
  audit, sessions, notifications, outbox events, and reconciliation.
- OIDC Authorization Code with PKCE, verified token identity, rotating encrypted
  refresh tokens, secure cookies, CSRF enforcement, session revocation, MFA
  evidence, role scopes, and server-side permissions replace client-controlled
  identity.
- Order acceptance, cancellation, price-time matching, self-trade prevention,
  reservation, fill, fee, FIFO cost-basis, position, journal, and outbox writes
  share database transactions and idempotency boundaries.
- Payment and compliance adapters require configured providers, verify signed
  callbacks, and fail closed when configuration is incomplete.
- Web, operations, mobile, API, worker, contracts, database, deployment
  resources, OpenAPI, and runbooks use the same English production model.
- The repository includes an audited bootstrap CLI, immutable migration
  manifest, Kubernetes workload definitions and environment overlays.

## Verification evidence

The following command completed successfully in this delivery:

```bash
npm run verify
```

It ran formatting, forbidden-terminology verification, migration filename and
checksum verification, lint, TypeScript checks, six unit tests, integration and
end-to-end command wiring, and production builds for packages, API, worker, web,
operations, and mobile. The integration and end-to-end runners currently report
that no matching test files exist; this is a release blocker, not test evidence.

PostgreSQL binaries and container execution are unavailable in the delivery
environment, so the migration has not been applied to a real database here.

## Remaining release blockers

- Scheduled definitions are detected by the worker but complete approved market
  materialisation is not yet implemented as one canonical transaction.
- Automated price-index calculation, dispute-window enforcement, and
  exactly-once settlement require complete target-provider flows.
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
If the previous baseline has ever been applied to a persistent environment, do
not replace its file. Restore the exact applied migration and create a forward
migration from the real schema state before deployment.
