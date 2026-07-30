# Zoryqon

Zoryqon is an English-language event exchange for web, iOS, Android, and
protected operations. PostgreSQL is authoritative for identity mappings,
markets, orders, fills, positions, payment state, double-entry journals,
resolution evidence, audit records, and transactional outbox events.

The runtime has no in-process financial store, no automatically authenticated
identity, no customer funding fixtures, and no provider-success fallback.
Required identity, payment, custody, compliance, pricing, notification, storage,
broker, Redis, and PostgreSQL settings are validated at startup. Readiness stays
closed until every mandatory dependency is healthy.

## Applications

- `apps/web`: public market catalogue and authenticated customer account.
- `apps/admin`: separately deployed operations console.
- `apps/mobile`: Expo application using OIDC PKCE and native secure storage.
- `apps/api`: Fastify REST and WebSocket API.
- `apps/worker`: price ingestion, scheduled jobs, outbox publishing,
  notification delivery, and reconciliation checks.

Shared contracts, deterministic matching rules, financial invariants, and the
canonical PostgreSQL schema live under `packages/`.

## Local prerequisites

- Node.js 22 or later
- npm 10 or later
- Docker with Compose
- Explicit development credentials for every external adapter

Install dependencies, create the repository-root environment file, start the
local data services and apply the database migrations:

```bash
npm ci
npm run dev:setup
```

`dev:setup` creates `.env` only when it is missing, generates the local
cryptographic secrets, starts PostgreSQL, Redis, Redpanda and MinIO, and applies
all migrations. Replace every provider, OIDC and tenant placeholder in `.env`
before using authentication, funding, custody, compliance, price ingestion or
notifications.

Start all applications with:

```bash
npm run dev
```

API, worker, database, web and operations commands all load environment files
from the repository root. No duplicate `apps/*/.env` files are required.

Endpoints:

- Customer web: `http://localhost:3000`
- Operations: `http://localhost:3001`
- API liveness: `http://localhost:4000/health/live`
- API readiness: `http://localhost:4000/health/ready`

The checked-in baseline contains schema only. Create the first tenant,
administrator, assets, products, policies, providers, fee schedules, and market
templates through audited operator bootstrap procedures before starting the
customer runtime.

## Release policy

Passing builds do not authorize a launch. Follow
`docs/PRODUCTION_READINESS_REPORT.md` and
`docs/compliance/GO_LIVE_GATES.md`. Production activation also requires the
applicable licences, approved product and jurisdiction policies, configured
provider accounts, key management, backup/restore evidence, penetration
testing, and operational sign-off.
