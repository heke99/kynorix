# Operations guide

The operations application is separately deployed and requires a staff Supabase Auth
session, current-session MFA, a scoped role, and an explicit permission for
every API action. Staff identity is never supplied by the browser.

Market creation starts in `draft`. A different authorized officer must approve
the market before scheduling. Once open, rules and economic configuration are
immutable. Closing cancels remaining orders and releases reservations inside the
same transaction before the market enters resolution review.

Manual resolution requires retained evidence from the configured source and a
different authorized approver. Payment, custody, ledger, fee, market-void,
account-unfreeze, and high-value withdrawal exceptions require the applicable
two-person procedure and complete audit evidence.

Never interpret a blank dashboard, a provider timeout, or a missing metric as a
healthy zero. Follow the reconciliation, resolution, incident, and provider
runbooks and keep the relevant capability blocked until evidence supports
recovery.
