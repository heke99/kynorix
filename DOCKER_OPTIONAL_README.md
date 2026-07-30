# Zoryqon development startup

Docker is optional. It is only one way to provide local PostgreSQL, Redis,
Redpanda and MinIO services.

## Standard startup without Docker

Configure real reachable services in the repository-root `.env`, then run the
database migrations once when the schema changes:

```bash
npm run dev:setup
npm run dev
```

`npm run dev` never starts Docker and never runs migrations. It only completes
missing environment keys, builds the shared packages and starts API, worker,
web and admin.

The following `.env` values must point to services that are actually reachable:

- `DATABASE_URL`
- `REDIS_URL`
- `EVENT_BROKER_URL`
- `OBJECT_STORAGE_ENDPOINT`
- `OBJECT_STORAGE_BUCKET`
- OIDC configuration
- payment, custody, price, compliance and notification provider configuration

Do not leave `example.com`, `replace-with-*` or localhost values unless the
corresponding local service is genuinely running.

## Optional Docker-based local infrastructure

```bash
npm run dev:local
```

This explicitly starts Docker Compose, applies migrations and starts all
applications. Stop only the local infrastructure with:

```bash
npm run dev:infra:stop
```

## Frontend-only work

```bash
npm run dev:web
```

This starts web and admin without API or worker. Pages that require API data
will correctly show the backend as unavailable.
