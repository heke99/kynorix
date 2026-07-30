# Terraform boundary

Cloud provider, region, legal data residency and account topology must be chosen
before Terraform resources are instantiated. This directory intentionally does
not create financial-production infrastructure from guessed inputs.

The approved implementation must create separate accounts/projects for:

- development and test,
- staging,
- production,
- disaster recovery,
- security logging.

Required managed components are PostgreSQL with PITR, Redis, Kafka-compatible
event streaming, immutable object storage, KMS/HSM, WAF, DDoS controls, secret
management and centralized audit/observability. Production modules must be
pinned to reviewed versions and deployed through a dedicated CI identity.

Each environment must have a separate account or project, database, encryption
keys, provider credentials, secrets, network boundary, and audit sink. Terraform
state must use encrypted remote storage with locking. This repository does not
guess a cloud provider, legal region, network range, or regulated provider;
those inputs must be approved before a concrete root module is applied.
