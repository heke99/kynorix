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
  reservation, current-session MFA confirmation, provider submission, completion
  and failure release boundaries.
- Protected operations client and production mobile identifiers, OIDC PKCE,
  secure token storage, biometric prompt, and shared API contracts.

## Verified in this delivery

- Dependency installation from the lockfile.
- Formatting, forbidden-terminology scan, migration checksum verification,
  TypeScript checks, unit tests, integration/e2e command wiring, and production
  builds.
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

## Code blockers

- The scheduled-market worker records due schedules but does not yet materialize
  a complete approved market through the canonical creation transaction.
- Full automated price-index calculation, dispute-window enforcement, and
  exactly-once settlement orchestration are not complete runtime flows.
- Admin modules beyond overview, market lifecycle, and resolution require full
  workflow screens and API actions.
- Database-backed concurrency, webhook replay, settlement replay, tenant
  isolation, browser, and device integration suites require target
  infrastructure and are not yet implemented as executable tests.

Kynorix must remain unavailable for production customer funds until the code
blockers are completed and every applicable gate has dated, independently
approved evidence.
