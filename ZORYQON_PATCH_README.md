# Zoryqon Supabase integration patch

This version makes Supabase the canonical platform for PostgreSQL, Auth, Storage, and Realtime.

## Main changes

- Removes Docker, Redis, Kafka, Redpanda, and MinIO from the required runtime.
- Uses `SUPABASE_DB_URL` for API, worker, migrations, and bootstrap commands.
- Uses Supabase Auth for web, operations, and mobile sessions.
- Creates the private Storage bucket, canonical tenant, roles, user identity mapping, and Realtime event stream through a forward SQL migration.
- Publishes the transactional outbox into `public.event_stream` instead of Kafka.
- Makes external payment, custody, price, compliance, and notification providers optional in development and mandatory where required in production.
- Loads the repository-root `.env` consistently for every workspace.
- Uses Webpack for local Next.js development to avoid the observed Turbopack panic/reload loop.

## Apply

Overlay the patch onto the project, remove the obsolete `docker-compose.yml`, then run:

```bash
npm ci
npm run env:init
```

Paste the real Supabase values into `.env`, then run:

```bash
npm run env:check
npm run dev:setup
npm run dev
```

`dev:setup` applies migrations directly to the configured remote Supabase database. It never starts Docker.

## Release status

The technical Supabase integration does not by itself authorize production trading or customer funds. Close the external provider, security, legal, regulatory, operational, backup, and testing gates documented in the production readiness report before launch.
