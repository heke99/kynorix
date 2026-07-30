# Kynorix

Kynorix is a modular event-exchange platform. This repository is intentionally
**sandbox-first**: the working product uses virtual balances and is suitable for
technical validation and private forecasting pilots. Real-money trading,
custody, spot crypto, five-minute UP/DOWN markets and binary-option-like
products are denied by server-side product policy.

## Included

- Public trading web app
- Operations/admin portal
- Expo React Native mobile app
- Fastify REST and WebSocket API
- Deterministic price/time matching engine
- Double-entry virtual-money ledger
- Market lifecycle and two-person resolution workflow
- Tenant, product, jurisdiction and feature-policy boundaries
- PostgreSQL canonical schema, RLS policies and immutable-market protections
- Local infrastructure, CI, OpenAPI, threat model and runbooks

## Quick start

Requirements: Node.js 22+, npm 10+.

```bash
cp .env.example .env
npm install
npm run dev
```

Open:

- Trading web: http://localhost:3000
- Admin: http://localhost:3001
- API health: http://localhost:4000/health

The API starts with deterministic sandbox seed data. Use the displayed demo
identities (`demo-alex` and `demo-sam`). Restarting the API resets in-memory
sandbox state.

## Verification

```bash
npm run verify
```

## PostgreSQL infrastructure

The runnable demo deliberately uses an in-memory adapter. The authoritative
production persistence model is in `packages/database/migrations`. Start local
dependencies and apply it with:

```bash
docker compose up -d postgres redis redpanda clickhouse minio
npm run migrate -w @kynorix/database
```

Do not connect payment, custody or real-money providers until every go-live gate
in `docs/compliance/GO_LIVE_GATES.md` has independent written approval.
# kynorix
