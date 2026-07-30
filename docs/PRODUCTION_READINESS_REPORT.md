# Production readiness report

Decision date: 2026-07-30  
Decision: **NO-GO**

## Implemented

- PostgreSQL-backed identity mappings, customer records, markets, orders,
  trades, positions, ledger, payments, pricing, resolution, audit, outbox, and
  reconciliation entities.
- Verified OIDC token identity, PKCE web login, encrypted rotating refresh-token
  storage, secure cookies, CSRF protection, session revocation, scoped roles,
  permissions, and independent resolution approval.
- Public market catalogue, category/search/sort/pagination, real stored history,
  order book, trades, wallet, portfolio, order, settings, verification, legal,
  and support routes.
- Persistent order acceptance and cancellation, price-time matching,
  self-trade prevention, fee quotes, reservations, fills, journals, position
  lots, and outbox events in one database transaction.
- Signed, idempotent payment webhooks; deposit credit journals; withdrawal
  reservation, current-session MFA confirmation, atomic submission claim,
  stable provider idempotency, completion and failure release boundaries.
- Durable scheduled-market materialisation with tenant context, independent
  approval, canonical market children, recurrence advancement and persisted
  worker failures.
- Fully collateralised binary complete-set minting, cumulative position limits,
  dispute-window finalisation and replay-safe exactly-once settlement journals.
- Protected operations client and production mobile identifiers, OIDC PKCE,
  secure token storage, biometric prompt, and shared API contracts.

## Verification status

- The repository baseline previously passed lockfile installation, formatting,
  forbidden-terminology scanning, migration verification, TypeScript checks,
  unit tests and production builds.
- This financial-core completion passed the forbidden-terminology scan and the
  two-migration filename/checksum manifest check.
- The current delivery environment's package source returned integrity errors
  during clean installation. Formatting, TypeScript, tests and production
  builds for this completion therefore require a clean CI rerun.
- The forward migration requires application and concurrency/replay testing
  against the target PostgreSQL version.
- No process-local financial store or customer funding fixtures in runtime code.

## Required configuration

All variables in `.env.example` are mandatory for the relevant process. Secrets
must come from an approved secrets manager. The API requires PostgreSQL, Redis,
an event broker, object storage, OIDC, payment, custody, price, and compliance
providers. The worker additionally requires notification-provider settings.

## External and operational blockers

- Applicable product classification, licences, country policies, customer
  terms, privacy notice, risk disclosure, complaints process, and mobile-store
  approval are not supplied.
- Production provider accounts, credentials, webhook certificates, custody key
  ceremony, licensed price data, index governance, and notification sender
  approval are not supplied.
- Independent penetration testing, load testing, database failover, backup
  restore, disaster-recovery, reconciliation, incident, and withdrawal drills
  have not been evidenced.
- Approved bootstrap data for tenant, staff roles, assets, product definitions,
  jurisdiction policies, fee schedules, providers, and market templates is not
  supplied.

## Remaining engineering blockers

- Full automated price-index calculation still needs its licensed
  target-provider adapter and governance rules.
- Admin modules beyond overview, market lifecycle, and resolution require full
  workflow screens and API actions.
- Database-backed concurrency, webhook replay, settlement replay, tenant
  isolation, browser, and device integration suites require target
  infrastructure and are not yet implemented as executable tests.
- CI must complete a clean install, formatting, TypeScript, tests and production
  builds for the new forward migration and runtime flows.

Zoryqon must remain unavailable for production customer funds until the code
blockers are completed and every applicable gate has dated, independently
approved evidence.
