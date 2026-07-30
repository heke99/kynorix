# Infrastructure boundary

Supabase is the canonical managed platform for Zoryqon PostgreSQL, Auth, Storage, and Realtime. Create separate Supabase projects for development/test, staging, production, and disaster recovery. Do not share database passwords, API keys, buckets, signing configuration, or Auth users between environments.

The remaining approved infrastructure must provide KMS/HSM-backed secret management, WAF and DDoS controls, centralized audit/observability, provider connectivity, deployment identities, and encrypted backups. Supabase database backups and point-in-time recovery must be enabled at the plan level appropriate for production.

Terraform in this directory intentionally does not create resources from guessed cloud, region, legal-residency, network, or regulated-provider inputs. Those inputs require approval before concrete modules are added. Terraform state must use encrypted remote storage with locking and a dedicated CI identity.
