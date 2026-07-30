# Implementation status

This table is the canonical boundary between working code and future regulated
work. “Gated” means the product is deliberately unavailable, not silently
unfinished.

| Capability                                     | Status                          | Evidence                                       |
| ---------------------------------------------- | ------------------------------- | ---------------------------------------------- |
| Virtual accounts and seeded balances           | Working sandbox                 | API store + ledger                             |
| Market catalogue and immutable rule version    | Working sandbox                 | API + SQL guard                                |
| Limit, GTC, IOC, FOK and post-only             | Working sandbox                 | matching core                                  |
| Price/time priority and self-trade prevention  | Working sandbox                 | matching tests                                 |
| Atomic virtual reservation and release         | Working sandbox                 | ledger/store                                   |
| Maker/taker fee postings                       | Working sandbox                 | trade journal                                  |
| Positions and virtual settlement               | Working sandbox                 | position/resolution modules                    |
| Two-person manual resolution                   | Working sandbox                 | operations portal + API                        |
| REST and sequenced WebSocket envelope          | Working sandbox                 | API                                            |
| Web, operations and React Native clients       | Working sandbox                 | apps                                           |
| PostgreSQL schema, RLS and migration integrity | Ready for adapter integration   | database package                               |
| Password/passkey/OIDC production identity      | Integration boundary            | requires IdP selection                         |
| KYC/AML/sanctions/Travel Rule                  | Gated                           | licensed providers and MLRO policy required    |
| Fiat or crypto deposit/withdrawal              | Gated                           | licensed partners required                     |
| Custody and wallet signing                     | Gated                           | CASP/custody partner and key ceremony required |
| Real-money prediction markets                  | Gated                           | written jurisdiction classification/license    |
| Spot crypto                                    | Gated                           | MiCA-authorised entity/partner                 |
| Five-minute UP/DOWN                            | Permanently off in this release | potential binary-option classification         |
| Binary options in iOS/Android                  | Permanently blocked             | distribution policy                            |
| Production go-live                             | NO-GO                           | all gates in compliance document must pass     |
