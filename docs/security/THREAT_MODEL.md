# Threat model

## Highest-value assets

1. Ledger integrity and journal idempotency
2. Customer identity, KYC and account recovery
3. Order-book ordering and private order information
4. Resolution evidence and approval independence
5. Custody keys and withdrawal policy (future gated capability)
6. Tenant isolation and administrative authority

## Trust boundaries and controls

| Boundary                | Primary threats                        | Required controls                                                    |
| ----------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| Client → API            | tampering, replay, credential theft    | OIDC, short access tokens, nonce/timestamp, idempotency, rate limits |
| API → domain            | authorization bypass, tenant confusion | server policy, tenant context, scoped repository, deny-by-default    |
| Order → matching        | reordering, duplicate fill, self-trade | single writer, sequence, WAL, idempotency, STP                       |
| Matching → ledger       | trade published before money commit    | one transaction/outbox, unique fill and journal references           |
| Admin → resolution      | insider manipulation                   | RBAC, two distinct officers, immutable evidence and audit            |
| Service → data          | cross-tenant read/write                | RLS, separate credentials, integration tests                         |
| Deployment → production | supply-chain compromise                | pinned dependencies, SBOM, signed image/digest, protected promotion  |

## Abuse cases tested in this release

- Reusing an idempotency key with changed content
- Crossing an order with the same user
- Posting an unbalanced journal
- Driving a market through an illegal state transition
- Enabling a blocked product through environment flags
- Accessing protected endpoints without a sandbox identity header

The demo header authentication is not a production identity mechanism. It makes
the sandbox boundary visible and must be replaced by an approved OIDC/passkey
provider before any external pilot with personal data.
