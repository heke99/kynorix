# Audited bootstrap guide

Run migrations before any bootstrap command. Every command requires
`DATABASE_URL` and `OPERATOR_REF`, rejects missing input, runs in one database
transaction, and appends an audit event. Values shown below are names only;
secrets must be injected by the approved secrets manager.

```bash
npm run migrate -w @zoryqon/database
npm run bootstrap -w @zoryqon/database -- first-admin
npm run bootstrap -w @zoryqon/database -- asset
npm run bootstrap -w @zoryqon/database -- provider
npm run bootstrap -w @zoryqon/database -- fee-schedule
npm run bootstrap -w @zoryqon/database -- market-template
```

`first-admin` requires `TENANT_REF`, `TENANT_LEGAL_NAME`, `TENANT_COUNTRY`,
`TENANT_TIMEZONE`, `ADMIN_OIDC_SUBJECT`, `ADMIN_USER_REF`, `ADMIN_EMAIL`,
`ADMIN_DISPLAY_NAME`, and a comma-separated `ADMIN_PERMISSIONS`.

`asset` requires `ASSET_REF`, `ASSET_SYMBOL`, `ASSET_NAME`, `ASSET_DECIMALS`,
`ASSET_TYPE`, and an explicit `ASSET_ENABLED`.

`provider` requires `PROVIDER_REF`, `PROVIDER_TYPE`, `PROVIDER_LEGAL_NAME`,
`PROVIDER_METADATA_JSON`, and, for a price provider,
`PROVIDER_ADAPTER_TYPE` plus `PROVIDER_ENABLED`. Metadata must not contain API
keys or signing secrets.

`fee-schedule` requires `TENANT_REF`, `APPROVER_USER_REF`,
`FEE_SCHEDULE_REF`, `FEE_SCHEDULE_VERSION`, `FEE_EFFECTIVE_FROM`, and
`FEE_RULE_JSON`.

`market-template` requires `TENANT_REF`, `APPROVER_USER_REF`,
`MARKET_TEMPLATE_REF`, `MARKET_TEMPLATE_VERSION`, `MARKET_TITLE_PATTERN`,
`MARKET_QUESTION_PATTERN`, `MARKET_RULE_DEFINITION_JSON`, `PRODUCT_REF`,
`CATEGORY_REF`, and optionally `PRICE_INDEX_REF`.

Export values only for the lifetime of the command, inspect the resulting audit
event, then clear the shell environment.
