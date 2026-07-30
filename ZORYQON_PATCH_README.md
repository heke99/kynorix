# Zoryqon financial-core patch

This archive contains only files that were changed or added relative to the
provided project.

## Main changes

- Product and infrastructure identity changed from the previous name to
  **Zoryqon**.
- Scheduled markets are materialised through durable, tenant-scoped worker
  runs; failures are persisted and do not stop the queue.
- Binary complete-set minting locks full collateral, posts a balanced journal
  and creates one position lot per outcome atomically.
- Withdrawal submission is claimed before the provider call and reuses a stable
  provider idempotency key.
- Resolution dispute windows and replay-safe settlement are orchestrated by the
  worker.
- Production provider configuration rejects local, private, credential-bearing
  or unencrypted endpoints.
- The unused ClickHouse compose service was removed.

## Apply

Run from any shell, replacing `TARGET` with the project root:

```bash
PATCH="/path/to/zoryqon-financial-core-patch-2026-07-30.zip"
TARGET="/path/to/zoryqon"
STAGE="$(mktemp -d)"
unzip -q "$PATCH" -d "$STAGE"
rsync -av "$STAGE/" "$TARGET/"
cd "$TARGET"
npm ci
npm run verify
```

Apply the new forward migration using the project's existing deployment process.
Do not rewrite an already-applied baseline migration; reconcile its recorded
checksum first if an older branded baseline exists in a persistent environment.

## Release status

The code delivery remains **NO-GO** for production customer funds until the
external, regulatory, provider, infrastructure and test gates in
`DELIVERY_REPORT.md` and `docs/PRODUCTION_READINESS_REPORT.md` have dated
evidence.
