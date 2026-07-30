# Implementation status

This document separates implemented code from release evidence and external
activation requirements.

| Capability                                                           | Code status | Release evidence                                           |
| -------------------------------------------------------------------- | ----------- | ---------------------------------------------------------- |
| PostgreSQL repositories and canonical schema                         | Implemented | Empty-database migration must pass in the target image     |
| Supabase Auth, verified tokens, secure web cookies, revocation, CSRF     | Implemented | IdP tenant and MFA policy must be approved                 |
| Market catalogue, history, book, trades, search and pagination       | Implemented | Approved market bootstrap data is required                 |
| Limit orders, GTC, IOC, FOK, post-only and self-trade prevention     | Implemented | Concurrency and performance evidence required              |
| Double-entry reservations, trade journals and immutable entries      | Implemented | Independent chart-of-accounts review required              |
| Persistent positions and FIFO realized-cost accounting               | Implemented | Database integration evidence required                     |
| Idempotent payment intent, webhook and withdrawal boundaries         | Implemented | Contracted provider credentials and certification required |
| KYC integration boundary and API enforcement                         | Implemented | Contracted provider and MLRO policies required             |
| Price observation ingestion and health state                         | Implemented | Licensed price source and index configuration required     |
| Manual resolution with independent approval                          | Implemented | Dispute and legal procedures required                      |
| Web customer routes and protected operations application             | Implemented | Browser end-to-end evidence required                       |
| Mobile Supabase Auth, secure token storage, markets, trading and account tabs | Implemented | Store review, device testing and release signing required  |
| Supabase event stream, notifications and ledger alarm worker         | Implemented | Realtime and notification-provider certification required  |
| Automated template materialization and full settlement orchestration | Incomplete  | Code completion required                                   |
| Production launch                                                    | NO-GO       | See the production readiness report                        |
