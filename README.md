# Zoryqon

Zoryqon is an English-language event exchange for web, iOS, Android, and protected operations. Supabase is the canonical platform for PostgreSQL, Auth, Storage, and Realtime. The application does not require Docker, Redis, Kafka, Redpanda, or MinIO.

PostgreSQL remains authoritative for identity mappings, markets, orders, fills, positions, payment state, double-entry journals, resolution evidence, audit records, and transactional outbox events. The worker copies committed outbox records into `public.event_stream`, which is published through Supabase Realtime.

## Applications

- `apps/web`: public market catalogue and authenticated customer account.
- `apps/admin`: separately deployed operations console.
- `apps/mobile`: Expo application using Supabase Auth and native secure token storage.
- `apps/api`: Fastify REST and WebSocket API.
- `apps/worker`: price ingestion, scheduled jobs, durable event publication, notification delivery, and reconciliation.

Shared contracts, deterministic matching rules, financial invariants, and the canonical PostgreSQL schema live under `packages/`.

## Prerequisites

- Node.js 22 or later
- npm 10 or later
- A Supabase project
- The Supabase project URL, publishable key, secret key, and a port-5432 database connection string

Do not use the transaction-pooler connection on port `6543` for migrations. Use the direct connection or the session pooler on port `5432`.

## Environment setup

Install dependencies and generate the repository-root `.env` file:

```bash
npm ci
npm run env:init
```

Open `.env` and replace the Supabase placeholders:

```env
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY=YOUR_SUPABASE_SECRET_KEY
SUPABASE_DB_URL=postgresql://postgres.YOUR_PROJECT_REF:YOUR_PASSWORD@YOUR_SESSION_POOLER_HOST:5432/postgres?sslmode=require
SUPABASE_DB_SSL=require
SUPABASE_JWT_AUDIENCE=authenticated
SUPABASE_STORAGE_BUCKET=zoryqon-private
SESSION_MAX_AGE_SECONDS=2592000

EXPO_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

The secret key and database URL are server-only. Never expose them through `NEXT_PUBLIC_*` or `EXPO_PUBLIC_*` variables.

Validate the environment and apply migrations to the remote Supabase database:

```bash
npm run env:check
npm run dev:setup
```

`dev:setup` does not start Docker. It validates `.env` and applies the checked-in SQL migrations directly to Supabase.

Start the system:

```bash
npm run dev
```

Endpoints:

- Customer web: `http://localhost:3000`
- Operations: `http://localhost:3001`
- API liveness: `http://localhost:4000/health/live`
- API readiness: `http://localhost:4000/health/ready`

API, worker, database, web, operations, and mobile commands all load environment values from the repository root. No duplicate `apps/*/.env` files are required.

## Authentication

Enable Email authentication in Supabase Auth. The web and operations applications use the Zoryqon API for sign-in and sign-up. The mobile application signs in directly against Supabase Auth with the publishable key and stores user tokens in secure device storage. Supabase access tokens are verified by the API through the project JWKS endpoint, with the Auth user endpoint as a compatibility fallback.

## Optional external providers

Payment, custody, price, compliance, and notification adapters are optional in development. Features that depend on an unconfigured provider return an explicit `PROVIDER_NOT_CONFIGURED` error or are skipped by the worker. All production provider pairs are mandatory and validated at startup.

## First administrator

Create the administrator in Supabase Auth first, copy the Auth user UUID, then run:

```bash
export OPERATOR_REF='initial-bootstrap'
export TENANT_REF='zoryqon'
export TENANT_LEGAL_NAME='Zoryqon'
export TENANT_COUNTRY='SE'
export TENANT_TIMEZONE='Europe/Stockholm'
export ADMIN_SUPABASE_USER_ID='SUPABASE_AUTH_USER_UUID'
export ADMIN_USER_REF='usr_initial_admin'
export ADMIN_EMAIL='admin@example.com'
export ADMIN_DISPLAY_NAME='Zoryqon Administrator'
export ADMIN_PERMISSIONS='*'
npm run db:bootstrap -- first-admin
```

Clear the exported values after the command completes.

## Release policy

Passing builds do not authorize a launch. Follow `docs/PRODUCTION_READINESS_REPORT.md` and `docs/compliance/GO_LIVE_GATES.md`. Production activation also requires applicable licences, approved product and jurisdiction policies, configured provider accounts, key management, backup/restore evidence, penetration testing, and operational sign-off.
