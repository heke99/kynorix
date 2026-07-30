# Deployment guide

1. Build immutable API, worker, web, operations, and mobile artifacts from a
   reviewed commit. Generate an SBOM, scan dependencies and images, sign every
   deployed digest, and retain provenance.
2. Provision separate development, test, staging, production, and
   disaster-recovery accounts with private PostgreSQL, Redis, event broker,
   object storage, secret management, encryption keys, monitoring, and audit
   sinks.
3. Inject the complete environment contract from `.env.example`. Never place
   credentials in source, an image, a mobile bundle, or Terraform state.
4. Run the migration job once. `schema_migrations` checks the filename and
   SHA-256 checksum and rejects drift.
5. Run explicit audited bootstrap commands only where required.
6. Deploy the worker, API, operations client, and customer web client by signed
   digest. Keep traffic disabled while readiness is closed.
7. Verify liveness, readiness, migration version, ledger balance, provider
   health, event publication, notification delivery, audit logging, and
   reconciliation.
8. Run the release smoke suite and obtain independent legal, compliance,
   finance, security, and operations approvals before enabling customer traffic.
9. Roll back application images when needed. Database changes are forward-only;
   use a reviewed corrective migration rather than rewriting applied history.
