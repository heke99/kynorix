# ADR-001: Production modular monolith

Status: accepted

Zoryqon uses one transactional API boundary for orders, matching, positions,
double-entry journals, and the outbox. PostgreSQL is the financial source of
truth. This keeps the commit boundary explicit while the product is operated by
one team and prevents partial economic state across network services.

The worker is a separate process because price ingestion, notification delivery,
event publication, scheduling, and reconciliation have different retry and
scaling characteristics. Web, operations, and mobile clients consume the same
versioned contracts and never implement financial state transitions locally.

The following boundaries remain explicit modules even when deployed together:
identity, compliance, jurisdiction, markets, orders, matching, positions,
ledger, payments, custody, pricing, resolution, settlement, risk,
reconciliation, notifications, administration, and audit.

A module may move to an independent service only when independent scaling,
failure isolation, or regulatory separation outweighs the cost of a distributed
transaction. Money, fills, positions, and settlement may not use Redis or an
event stream as their authoritative store.

Provider integrations are required adapters. Missing credentials or unhealthy
mandatory providers keep readiness closed; there is no success fallback.
