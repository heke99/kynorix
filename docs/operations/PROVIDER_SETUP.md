# Provider setup guide

Zoryqon requires contracted adapters for identity, payment, custody, compliance,
price data, notifications, object storage, and event transport. For each
provider, record the legal entity, contracted product, data locations,
sub-processors, licences, service levels, rate limits, retention, incident
contacts, webhook signing method, idempotency behavior, and reconciliation
source.

Store API keys and signing secrets only in the approved secrets manager. Verify
provider TLS, allowlists, signature rotation, webhook replay behavior, timeout
semantics, and recovery from an accepted request whose response was lost.

The provider must pass certification scenarios before production credentials
are enabled. Missing or unhealthy mandatory providers keep readiness closed and
the affected customer action unavailable.
