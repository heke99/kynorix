# Mobile release guide

The production identifiers are `com.zoryqon.app` for iOS and Android. Configure
the OIDC mobile client for PKCE, the `zoryqon://auth` redirect, universal links,
token rotation, remote revocation, and the exact production signing identities.

Before submission:

- Confirm server-driven country, customer, and product eligibility.
- Verify secure storage, biometric unlock, deep links, notification privacy,
  device registration, remote logout, minimum-version enforcement, and
  compromised-device risk handling on physical devices.
- Confirm no private order, balance, KYC, or withdrawal data appears in push
  notification bodies, screenshots, analytics, or crash reports.
- Complete Apple and Google review for the exact enabled financial products,
  legal entity, countries, disclosures, support process, and account deletion
  flow.
- Retain signed build provenance, store metadata, review correspondence, rollout
  decision, and rollback plan.
