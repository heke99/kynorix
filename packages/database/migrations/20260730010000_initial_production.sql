create extension if not exists pgcrypto;

create or replace function public.uuid_v7()
returns uuid
language plpgsql
volatile
as $$
declare
  v_millis bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  v_time text := lpad(to_hex(v_millis), 12, '0');
  v_random text := encode(gen_random_bytes(10), 'hex');
begin
  return (
    substr(v_time, 1, 8) || '-' || substr(v_time, 9, 4) || '-7' ||
    substr(v_random, 1, 3) || '-8' || substr(v_random, 4, 3) || '-' ||
    substr(v_random, 7, 12)
  )::uuid;
end;
$$;

create type public.tenant_status as enum ('onboarding', 'active', 'restricted', 'suspended', 'closed');
create type public.user_account_status as enum (
  'created', 'email_pending', 'kyc_pending', 'active', 'restricted',
  'withdrawal_locked', 'trading_locked', 'suspended', 'self_excluded',
  'closed', 'deceased', 'under_investigation'
);
create type public.product_status as enum (
  'draft', 'legal_review', 'partner_required', 'approved', 'suspended', 'retired'
);
create type public.market_status as enum (
  'draft', 'under_review', 'approved', 'scheduled', 'pre_open', 'open',
  'suspended', 'closing', 'closed', 'resolution_pending', 'proposed',
  'disputed', 'appealed', 'resolved', 'settling', 'settled', 'cancelled',
  'voided', 'archived'
);
create type public.order_side as enum ('buy', 'sell');
create type public.order_status as enum (
  'received', 'pending_validation', 'accepted', 'open', 'partially_filled',
  'filled', 'cancel_pending', 'cancelled', 'rejected', 'expired', 'suspended'
);
create type public.time_in_force as enum ('GTC', 'IOC', 'FOK');
create type public.ledger_normal_side as enum ('debit', 'credit');
create type public.deposit_status as enum (
  'created', 'awaiting_payment', 'provider_pending', 'received', 'confirming',
  'compliance_review', 'credited', 'rejected', 'reversed', 'chargeback', 'failed'
);
create type public.withdrawal_status as enum (
  'requested', 'authentication_required', 'risk_review', 'compliance_review',
  'approval_required', 'approved', 'signing', 'submitted', 'confirming',
  'completed', 'rejected', 'cancelled', 'failed', 'reversed'
);
create type public.feed_status as enum (
  'healthy', 'degraded', 'stale', 'outlier', 'excluded', 'disconnected', 'recovering'
);

create table public.tenants (
  id uuid primary key default public.uuid_v7(),
  tenant_ref text not null unique,
  legal_name text not null,
  status public.tenant_status not null default 'onboarding',
  default_country char(2) not null,
  default_timezone text not null default 'UTC',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.users (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  user_ref text not null,
  oidc_subject text not null,
  account_status public.user_account_status not null default 'created',
  customer_type text not null default 'customer',
  kyc_level text not null default 'unverified',
  country char(2),
  mfa_verified_at timestamptz,
  password_changed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, user_ref),
  unique (tenant_id, oidc_subject),
  unique (id, tenant_id)
);

create table public.user_profiles (
  user_id uuid primary key references public.users(id),
  display_name text not null,
  given_name text,
  family_name text,
  date_of_birth date,
  address jsonb,
  preferred_locale text not null default 'en-US',
  updated_at timestamptz not null default clock_timestamp()
);
create table public.user_emails (
  id uuid primary key default public.uuid_v7(),
  user_id uuid not null references public.users(id),
  email text not null,
  verified_at timestamptz,
  is_primary boolean not null default false
);
create unique index user_emails_email_unique on public.user_emails (lower(email));
create unique index user_emails_one_primary on public.user_emails (user_id) where is_primary;
create table public.user_phones (
  id uuid primary key default public.uuid_v7(),
  user_id uuid not null references public.users(id),
  phone_e164 text not null unique,
  verified_at timestamptz,
  is_primary boolean not null default false
);
create table public.user_sessions (
  id uuid primary key default public.uuid_v7(),
  user_id uuid not null references public.users(id),
  session_ref text not null unique,
  oidc_session_id text,
  refresh_token_ciphertext bytea,
  refresh_token_hash char(64),
  ip inet,
  user_agent text,
  device_ref text,
  mfa_verified boolean not null default false,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create table public.auth_flows (
  state_hash char(64) primary key,
  nonce_hash char(64) not null,
  verifier_ciphertext bytea not null,
  return_to text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create table public.user_security_methods (
  id uuid primary key default public.uuid_v7(),
  user_id uuid not null references public.users(id),
  method_type text not null check (method_type in ('totp', 'passkey', 'recovery_code')),
  credential_ref text not null,
  encrypted_secret bytea,
  enabled_at timestamptz not null default clock_timestamp(),
  disabled_at timestamptz,
  unique (user_id, credential_ref)
);
create table public.user_devices (
  id uuid primary key default public.uuid_v7(),
  user_id uuid not null references public.users(id),
  device_ref text not null,
  platform text not null,
  push_token_ciphertext bytea,
  trust_state text not null default 'new',
  last_seen_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  unique (user_id, device_ref)
);
create table public.user_consents (
  id uuid primary key default public.uuid_v7(),
  user_id uuid not null references public.users(id),
  document_type text not null,
  document_version text not null,
  accepted_at timestamptz not null,
  ip inet,
  unique (user_id, document_type, document_version)
);
create table public.notification_preferences (
  user_id uuid primary key references public.users(id),
  email_enabled boolean not null default true,
  push_enabled boolean not null default true,
  in_app_enabled boolean not null default true,
  security_sms_enabled boolean not null default false,
  market_closing_enabled boolean not null default true,
  updated_at timestamptz not null default clock_timestamp()
);
create table public.account_restrictions (
  id uuid primary key default public.uuid_v7(),
  user_id uuid not null references public.users(id),
  restriction_type text not null,
  reason_code text not null,
  effective_at timestamptz not null,
  expires_at timestamptz,
  lifted_at timestamptz,
  created_by uuid references public.users(id)
);

create table public.roles (
  role_key text primary key,
  staff_role boolean not null,
  description text not null
);
create table public.role_permissions (
  role_key text not null references public.roles(role_key),
  permission_key text not null,
  primary key (role_key, permission_key)
);
create table public.user_roles (
  user_id uuid not null references public.users(id),
  role_key text not null references public.roles(role_key),
  granted_by uuid references public.users(id),
  granted_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  primary key (user_id, role_key)
);

create table public.kyc_cases (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  case_ref text not null,
  user_id uuid not null references public.users(id),
  provider_ref text,
  action_url text,
  status text not null,
  required_level text not null,
  idempotency_key text not null,
  request_fingerprint char(64) not null,
  decision_reason text,
  opened_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz,
  unique (tenant_id, case_ref),
  unique (tenant_id, user_id, idempotency_key)
);
create table public.kyc_documents (
  id uuid primary key default public.uuid_v7(),
  kyc_case_id uuid not null references public.kyc_cases(id),
  object_ref text not null,
  document_type text not null,
  content_hash char(64) not null,
  retention_until date,
  created_at timestamptz not null default clock_timestamp()
);
create table public.kyc_provider_events (
  id uuid primary key default public.uuid_v7(),
  kyc_case_id uuid not null references public.kyc_cases(id),
  provider_event_ref text not null unique,
  payload_hash char(64) not null,
  received_at timestamptz not null default clock_timestamp()
);
create table public.aml_cases (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  case_ref text not null,
  user_id uuid not null references public.users(id),
  status text not null,
  risk_level text not null,
  opened_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz,
  unique (tenant_id, case_ref)
);
create table public.aml_alerts (
  id uuid primary key default public.uuid_v7(),
  aml_case_id uuid not null references public.aml_cases(id),
  alert_type text not null,
  severity text not null,
  evidence jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create table public.sanctions_checks (
  id uuid primary key default public.uuid_v7(),
  user_id uuid not null references public.users(id),
  provider_ref text not null,
  result text not null,
  evidence_hash char(64) not null,
  checked_at timestamptz not null
);
create table public.pep_checks (like public.sanctions_checks including defaults including constraints);
alter table public.pep_checks add primary key (id);
create table public.source_of_funds_reviews (
  id uuid primary key default public.uuid_v7(),
  user_id uuid not null references public.users(id),
  status text not null,
  evidence jsonb not null,
  reviewed_by uuid references public.users(id),
  reviewed_at timestamptz
);
create table public.jurisdiction_decisions (
  id uuid primary key default public.uuid_v7(),
  user_id uuid not null references public.users(id),
  product_ref text not null,
  decision text not null,
  reason_code text not null,
  policy_version integer not null,
  evaluated_at timestamptz not null
);
create table public.responsible_use_limits (
  id uuid primary key default public.uuid_v7(),
  user_id uuid not null references public.users(id),
  limit_type text not null,
  amount_atoms numeric(78,0),
  period_seconds integer,
  effective_at timestamptz not null,
  unique (user_id, limit_type, effective_at)
);
create table public.self_exclusions (
  id uuid primary key default public.uuid_v7(),
  user_id uuid not null references public.users(id),
  starts_at timestamptz not null,
  ends_at timestamptz,
  irreversible_until timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);

create table public.assets (
  id uuid primary key default public.uuid_v7(),
  asset_ref text not null unique,
  symbol text not null unique,
  display_name text not null,
  decimals smallint not null check (decimals between 0 and 30),
  asset_type text not null,
  enabled boolean not null default false,
  created_at timestamptz not null default clock_timestamp()
);
create table public.asset_networks (
  id uuid primary key default public.uuid_v7(),
  asset_id uuid not null references public.assets(id),
  network_ref text not null,
  confirmation_target integer not null check (confirmation_target > 0),
  enabled boolean not null default false,
  unique (asset_id, network_ref)
);
create table public.wallet_accounts (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  wallet_ref text not null,
  user_id uuid not null references public.users(id),
  asset_id uuid not null references public.assets(id),
  status text not null,
  unique (tenant_id, wallet_ref),
  unique (user_id, asset_id)
);
create table public.wallet_addresses (
  id uuid primary key default public.uuid_v7(),
  wallet_account_id uuid not null references public.wallet_accounts(id),
  asset_network_id uuid not null references public.asset_networks(id),
  address_ciphertext bytea not null,
  address_hash char(64) not null,
  destination_tag_ciphertext bytea,
  status text not null,
  unique (asset_network_id, address_hash)
);
create table public.wallet_balances (
  wallet_account_id uuid primary key references public.wallet_accounts(id),
  available_atoms numeric(78,0) not null default 0 check (available_atoms >= 0),
  locked_atoms numeric(78,0) not null default 0 check (locked_atoms >= 0),
  pending_deposit_atoms numeric(78,0) not null default 0 check (pending_deposit_atoms >= 0),
  pending_withdrawal_atoms numeric(78,0) not null default 0 check (pending_withdrawal_atoms >= 0),
  ledger_sequence bigint not null default 0,
  updated_at timestamptz not null default clock_timestamp()
);
create table public.custody_accounts (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  provider_ref text not null,
  external_account_ref text not null,
  asset_id uuid not null references public.assets(id),
  status text not null,
  unique (provider_ref, external_account_ref, asset_id)
);
create table public.custody_transactions (
  id uuid primary key default public.uuid_v7(),
  custody_account_id uuid not null references public.custody_accounts(id),
  provider_transaction_ref text not null unique,
  direction text not null,
  amount_atoms numeric(78,0) not null check (amount_atoms > 0),
  status text not null,
  occurred_at timestamptz not null
);

create table public.payment_accounts (
  id uuid primary key default public.uuid_v7(),
  user_id uuid not null references public.users(id),
  provider_ref text not null,
  external_account_ref_ciphertext bytea not null,
  external_account_hash char(64) not null,
  method text not null,
  status text not null,
  unique (user_id, provider_ref, external_account_hash)
);
create table public.deposit_intents (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  intent_ref text not null,
  user_id uuid not null references public.users(id),
  asset_id uuid not null references public.assets(id),
  method text not null,
  amount_atoms numeric(78,0) not null check (amount_atoms > 0),
  fee_atoms numeric(78,0) not null default 0 check (fee_atoms >= 0),
  provider_ref text not null,
  provider_intent_ref text,
  status public.deposit_status not null default 'created',
  idempotency_key text not null,
  request_fingerprint char(64) not null,
  expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, intent_ref),
  unique (tenant_id, user_id, idempotency_key)
);
create table public.deposits (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  deposit_ref text not null,
  deposit_intent_id uuid references public.deposit_intents(id),
  user_id uuid not null references public.users(id),
  asset_id uuid not null references public.assets(id),
  method text not null,
  amount_atoms numeric(78,0) not null check (amount_atoms > 0),
  fee_atoms numeric(78,0) not null default 0 check (fee_atoms >= 0),
  provider_ref text not null,
  provider_transaction_ref text,
  status public.deposit_status not null,
  ledger_journal_id uuid,
  received_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, deposit_ref),
  unique nulls not distinct (provider_ref, provider_transaction_ref)
);
create table public.withdrawal_requests (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  withdrawal_ref text not null,
  user_id uuid not null references public.users(id),
  asset_id uuid not null references public.assets(id),
  method text not null,
  destination_ref text not null,
  amount_atoms numeric(78,0) not null check (amount_atoms > 0),
  fee_atoms numeric(78,0) not null default 0 check (fee_atoms >= 0),
  status public.withdrawal_status not null default 'requested',
  idempotency_key text not null,
  request_fingerprint char(64) not null,
  requested_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, withdrawal_ref),
  unique (tenant_id, user_id, idempotency_key)
);
create table public.withdrawals (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  withdrawal_request_id uuid not null unique references public.withdrawal_requests(id),
  provider_ref text not null,
  provider_transaction_ref text,
  status public.withdrawal_status not null,
  reserved_journal_id uuid,
  completion_journal_id uuid,
  submitted_at timestamptz,
  completed_at timestamptz,
  unique nulls not distinct (provider_ref, provider_transaction_ref)
);
create table public.payment_provider_events (
  id uuid primary key default public.uuid_v7(),
  provider_ref text not null,
  provider_event_ref text not null,
  event_type text not null,
  payload_hash char(64) not null,
  payload jsonb not null,
  signature_valid boolean not null,
  received_at timestamptz not null default clock_timestamp(),
  processed_at timestamptz,
  processing_error text,
  unique (provider_ref, provider_event_ref)
);
create table public.refunds (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  refund_ref text not null,
  deposit_id uuid references public.deposits(id),
  amount_atoms numeric(78,0) not null check (amount_atoms > 0),
  status text not null,
  unique (tenant_id, refund_ref)
);
create table public.chargebacks (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  chargeback_ref text not null,
  deposit_id uuid not null references public.deposits(id),
  amount_atoms numeric(78,0) not null check (amount_atoms > 0),
  status text not null,
  unique (tenant_id, chargeback_ref)
);

create table public.market_categories (
  id uuid primary key default public.uuid_v7(),
  category_ref text not null unique,
  name text not null unique,
  display_order integer not null default 0,
  enabled boolean not null default true
);
create table public.product_definitions (
  id uuid primary key default public.uuid_v7(),
  product_ref text not null,
  version integer not null,
  product_type text not null check (product_type in ('event_contract', 'price_event_contract', 'spot_asset')),
  status public.product_status not null,
  legal_classification text not null,
  target_customer_types text[] not null,
  required_licences text[] not null,
  required_kyc_level text not null,
  allowed_channels text[] not null,
  settlement_model text not null,
  custody_model text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  unique (product_ref, version)
);
create table public.jurisdiction_policies (
  id uuid primary key default public.uuid_v7(),
  policy_ref text not null,
  version integer not null,
  product_definition_id uuid not null references public.product_definitions(id),
  permitted_countries text[] not null,
  blocked_countries text[] not null,
  position_limit_atoms numeric(78,0) not null check (position_limit_atoms >= 0),
  deposit_limit_atoms numeric(78,0),
  withdrawal_limit_atoms numeric(78,0),
  status text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  unique (policy_ref, version)
);
create table public.market_templates (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  template_ref text not null,
  version integer not null,
  product_definition_id uuid not null references public.product_definitions(id),
  category_id uuid not null references public.market_categories(id),
  title_pattern text not null,
  question_pattern text not null,
  rule_definition jsonb not null,
  price_index_ref text,
  status text not null,
  approved_by uuid references public.users(id),
  approved_at timestamptz,
  unique (tenant_id, template_ref, version)
);
create table public.market_template_schedules (
  id uuid primary key default public.uuid_v7(),
  market_template_id uuid not null references public.market_templates(id),
  schedule_expression text not null,
  display_timezone text not null,
  enabled boolean not null default false,
  next_run_at timestamptz
);
create table public.fee_schedules (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  fee_schedule_ref text not null,
  version integer not null,
  status text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  approved_by uuid references public.users(id),
  unique (tenant_id, fee_schedule_ref, version)
);
create table public.fee_rules (
  id uuid primary key default public.uuid_v7(),
  fee_schedule_id uuid not null references public.fee_schedules(id),
  fee_type text not null,
  maker_basis_points integer not null default 0 check (maker_basis_points between 0 and 10000),
  taker_basis_points integer not null default 0 check (taker_basis_points between 0 and 10000),
  flat_atoms numeric(78,0) not null default 0 check (flat_atoms >= 0),
  product_ref text,
  market_ref text,
  customer_tier text,
  country char(2),
  asset_symbol text,
  volume_from_atoms numeric(78,0)
);
create table public.markets (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  market_ref text not null,
  product_definition_id uuid not null references public.product_definitions(id),
  category_id uuid not null references public.market_categories(id),
  template_id uuid references public.market_templates(id),
  jurisdiction_policy_id uuid not null references public.jurisdiction_policies(id),
  fee_schedule_id uuid not null references public.fee_schedules(id),
  title text not null,
  question text not null,
  image_url text,
  display_timezone text not null,
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  resolution_at timestamptz not null,
  collateral_asset_id uuid not null references public.assets(id),
  payout_atoms numeric(78,0) not null check (payout_atoms > 0),
  tick_atoms numeric(78,0) not null check (tick_atoms > 0),
  minimum_order_quantity numeric(78,0) not null check (minimum_order_quantity > 0),
  maximum_position_quantity numeric(78,0) not null check (maximum_position_quantity > 0),
  risk_class text not null,
  status public.market_status not null default 'draft',
  trading_suspended boolean not null default false,
  featured boolean not null default false,
  immutable_rule_version text not null,
  approval_state text not null default 'pending',
  created_by uuid not null references public.users(id),
  approved_by uuid references public.users(id),
  approved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (opens_at < closes_at and closes_at <= resolution_at),
  check (tick_atoms <= payout_atoms),
  check (approved_by is null or approved_by <> created_by),
  unique (tenant_id, market_ref),
  unique (id, tenant_id)
);
create table public.market_versions (
  id uuid primary key default public.uuid_v7(),
  market_id uuid not null references public.markets(id),
  version integer not null,
  snapshot jsonb not null,
  content_hash char(64) not null,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default clock_timestamp(),
  unique (market_id, version)
);
create table public.market_outcomes (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  market_id uuid not null references public.markets(id),
  outcome_ref text not null,
  label text not null,
  display_order integer not null check (display_order >= 0),
  unique (market_id, outcome_ref),
  unique (market_id, display_order),
  unique (id, tenant_id)
);
create table public.market_rules (
  id uuid primary key default public.uuid_v7(),
  market_id uuid not null references public.markets(id),
  version integer not null,
  rules text not null,
  tie_behavior text not null,
  cancellation_behavior text not null,
  void_behavior text not null,
  calculation_rule jsonb,
  content_hash char(64) not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (market_id, version)
);
create table public.market_sources (
  id uuid primary key default public.uuid_v7(),
  market_id uuid not null references public.markets(id),
  source_type text not null check (source_type in ('primary', 'backup', 'price_index')),
  source_uri text not null,
  source_name text not null,
  priority integer not null,
  unique (market_id, source_type, priority)
);
create table public.market_status_events (
  id uuid primary key default public.uuid_v7(),
  market_id uuid not null references public.markets(id),
  from_status public.market_status,
  to_status public.market_status not null,
  actor_id uuid not null references public.users(id),
  reason text not null,
  occurred_at timestamptz not null default clock_timestamp()
);

create table public.price_providers (
  id uuid primary key default public.uuid_v7(),
  provider_ref text not null unique,
  name text not null,
  adapter_type text not null,
  licensing_metadata jsonb not null,
  enabled boolean not null default false
);
create table public.service_providers (
  id uuid primary key default public.uuid_v7(),
  provider_ref text not null unique,
  provider_type text not null check (
    provider_type in ('payment', 'custody', 'compliance', 'notification', 'object_storage', 'identity')
  ),
  legal_name text not null,
  configuration_metadata jsonb not null,
  status text not null check (status in ('registered', 'approved', 'suspended', 'retired')),
  approved_by uuid references public.users(id),
  approved_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create table public.price_instruments (
  id uuid primary key default public.uuid_v7(),
  instrument_ref text not null unique,
  normalized_symbol text not null unique,
  base_asset_id uuid not null references public.assets(id),
  quote_asset_id uuid not null references public.assets(id),
  precision smallint not null check (precision between 0 and 30)
);
create table public.price_observations (
  id uuid primary key default public.uuid_v7(),
  provider_id uuid not null references public.price_providers(id),
  instrument_id uuid not null references public.price_instruments(id),
  source_symbol text not null,
  bid_atoms numeric(78,0),
  ask_atoms numeric(78,0),
  last_atoms numeric(78,0),
  volume_atoms numeric(78,0),
  source_timestamp timestamptz not null,
  received_timestamp timestamptz not null default clock_timestamp(),
  provider_sequence text,
  status public.feed_status not null,
  unique nulls not distinct (provider_id, instrument_id, provider_sequence, source_timestamp)
);
create table public.price_feed_health (
  provider_id uuid not null references public.price_providers(id),
  instrument_id uuid not null references public.price_instruments(id),
  status public.feed_status not null,
  last_observation_at timestamptz,
  delay_milliseconds bigint,
  consecutive_failures integer not null default 0,
  reason text,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (provider_id, instrument_id)
);
create table public.price_indexes (
  id uuid primary key default public.uuid_v7(),
  index_ref text not null,
  version integer not null,
  instrument_id uuid not null references public.price_instruments(id),
  calculation_method text not null,
  minimum_healthy_sources integer not null check (minimum_healthy_sources > 0),
  outlier_basis_points integer not null check (outlier_basis_points >= 0),
  immutable_after timestamptz,
  status text not null,
  unique (index_ref, version)
);
create table public.price_index_components (
  price_index_id uuid not null references public.price_indexes(id),
  provider_id uuid not null references public.price_providers(id),
  weight numeric(12,8) not null check (weight > 0),
  primary key (price_index_id, provider_id)
);
create table public.price_index_values (
  id uuid primary key default public.uuid_v7(),
  price_index_id uuid not null references public.price_indexes(id),
  value_atoms numeric(78,0) not null,
  observed_at timestamptz not null,
  component_observation_ids uuid[] not null,
  evidence_hash char(64) not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (price_index_id, observed_at)
);
create table public.market_price_snapshots (
  market_id uuid not null references public.markets(id),
  outcome_id uuid not null references public.market_outcomes(id),
  best_bid_atoms numeric(78,0),
  best_ask_atoms numeric(78,0),
  last_price_atoms numeric(78,0),
  volume_atoms numeric(78,0) not null default 0,
  liquidity_atoms numeric(78,0) not null default 0,
  open_interest_atoms numeric(78,0) not null default 0,
  book_sequence bigint not null default 0,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (market_id, outcome_id)
);
create table public.market_price_history (
  id uuid primary key default public.uuid_v7(),
  market_id uuid not null references public.markets(id),
  outcome_id uuid not null references public.market_outcomes(id),
  price_atoms numeric(78,0) not null,
  volume_atoms numeric(78,0) not null default 0,
  source text not null,
  observed_at timestamptz not null,
  unique (market_id, outcome_id, observed_at, source)
);

create table public.orders (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  order_ref text not null,
  user_id uuid not null references public.users(id),
  market_id uuid not null references public.markets(id),
  outcome_id uuid not null references public.market_outcomes(id),
  side public.order_side not null,
  order_type text not null check (order_type in ('limit', 'marketable_limit')),
  price_atoms numeric(78,0) not null check (price_atoms > 0),
  quantity numeric(78,0) not null check (quantity > 0),
  remaining_quantity numeric(78,0) not null check (remaining_quantity >= 0),
  time_in_force public.time_in_force not null,
  post_only boolean not null,
  status public.order_status not null,
  fee_schedule_id uuid not null references public.fee_schedules(id),
  fee_schedule_version integer not null,
  estimated_fee_atoms numeric(78,0) not null check (estimated_fee_atoms >= 0),
  actual_fee_atoms numeric(78,0) not null default 0 check (actual_fee_atoms >= 0),
  idempotency_key text not null,
  request_fingerprint char(64) not null,
  book_sequence bigint not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (remaining_quantity <= quantity),
  unique (tenant_id, order_ref),
  unique (tenant_id, user_id, idempotency_key),
  unique (market_id, outcome_id, book_sequence),
  unique (id, tenant_id)
);
create table public.order_events (
  id uuid primary key default public.uuid_v7(),
  order_id uuid not null references public.orders(id),
  event_type text not null,
  sequence bigint not null,
  payload jsonb not null,
  occurred_at timestamptz not null default clock_timestamp(),
  unique (order_id, sequence)
);
create table public.trades (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  trade_ref text not null,
  market_id uuid not null references public.markets(id),
  outcome_id uuid not null references public.market_outcomes(id),
  maker_order_id uuid not null references public.orders(id),
  taker_order_id uuid not null references public.orders(id),
  buyer_user_id uuid not null references public.users(id),
  seller_user_id uuid not null references public.users(id),
  price_atoms numeric(78,0) not null check (price_atoms > 0),
  quantity numeric(78,0) not null check (quantity > 0),
  buyer_fee_atoms numeric(78,0) not null check (buyer_fee_atoms >= 0),
  seller_fee_atoms numeric(78,0) not null check (seller_fee_atoms >= 0),
  book_sequence bigint not null,
  ledger_journal_id uuid,
  executed_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, trade_ref),
  unique (market_id, outcome_id, book_sequence),
  unique (maker_order_id, taker_order_id, book_sequence)
);
create table public.positions (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references public.users(id),
  market_id uuid not null references public.markets(id),
  outcome_id uuid not null references public.market_outcomes(id),
  available_quantity numeric(78,0) not null default 0 check (available_quantity >= 0),
  locked_quantity numeric(78,0) not null default 0 check (locked_quantity >= 0),
  cost_atoms numeric(78,0) not null default 0,
  realized_pnl_atoms numeric(78,0) not null default 0,
  fees_paid_atoms numeric(78,0) not null default 0,
  updated_at timestamptz not null default clock_timestamp(),
  unique (user_id, market_id, outcome_id)
);
create table public.position_lots (
  id uuid primary key default public.uuid_v7(),
  position_id uuid not null references public.positions(id),
  trade_id uuid not null references public.trades(id),
  quantity numeric(78,0) not null check (quantity > 0),
  remaining_quantity numeric(78,0) not null check (remaining_quantity >= 0),
  cost_atoms numeric(78,0) not null check (cost_atoms >= 0),
  unique (position_id, trade_id)
);
create table public.collateral_reservations (
  id uuid primary key default public.uuid_v7(),
  order_id uuid not null unique references public.orders(id),
  asset_id uuid not null references public.assets(id),
  amount_atoms numeric(78,0) not null default 0 check (amount_atoms >= 0),
  quantity numeric(78,0) not null default 0 check (quantity >= 0),
  status text not null,
  ledger_journal_id uuid,
  released_at timestamptz
);
create table public.market_book_sequences (
  market_id uuid not null references public.markets(id),
  outcome_id uuid not null references public.market_outcomes(id),
  last_sequence bigint not null default 0,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (market_id, outcome_id)
);

create table public.ledger_accounts (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  account_ref text not null,
  owner_user_id uuid references public.users(id),
  asset_id uuid not null references public.assets(id),
  account_type text not null,
  normal_side public.ledger_normal_side not null,
  status text not null default 'active',
  unique (tenant_id, account_ref),
  unique nulls not distinct (tenant_id, owner_user_id, asset_id, account_type),
  unique (id, tenant_id)
);
create table public.ledger_journals (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  journal_ref text not null,
  transaction_type text not null,
  asset_id uuid not null references public.assets(id),
  reference_type text not null,
  reference_ref text not null,
  idempotency_key text not null,
  status text not null default 'posted' check (status in ('posted', 'reversed')),
  effective_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, journal_ref),
  unique (tenant_id, idempotency_key),
  unique (id, tenant_id)
);
create table public.ledger_entries (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  journal_id uuid not null references public.ledger_journals(id),
  account_id uuid not null references public.ledger_accounts(id),
  debit_atoms numeric(78,0) not null default 0 check (debit_atoms >= 0),
  credit_atoms numeric(78,0) not null default 0 check (credit_atoms >= 0),
  created_at timestamptz not null default clock_timestamp(),
  check ((debit_atoms > 0 and credit_atoms = 0) or (credit_atoms > 0 and debit_atoms = 0))
);
create table public.ledger_reversals (
  id uuid primary key default public.uuid_v7(),
  original_journal_id uuid not null unique references public.ledger_journals(id),
  reversal_journal_id uuid not null unique references public.ledger_journals(id),
  reason text not null,
  approved_by uuid not null references public.users(id),
  created_at timestamptz not null default clock_timestamp()
);
create table public.reconciliation_runs (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  run_ref text not null,
  scope text not null,
  status text not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  unique (tenant_id, run_ref)
);
create table public.reconciliation_items (
  id uuid primary key default public.uuid_v7(),
  reconciliation_run_id uuid not null references public.reconciliation_runs(id),
  provider_ref text,
  asset_id uuid not null references public.assets(id),
  expected_atoms numeric(78,0) not null,
  actual_atoms numeric(78,0) not null,
  difference_atoms numeric(78,0) generated always as (actual_atoms - expected_atoms) stored,
  severity text not null,
  state text not null
);
create table public.reconciliation_cases (
  id uuid primary key default public.uuid_v7(),
  reconciliation_item_id uuid not null references public.reconciliation_items(id),
  case_ref text not null unique,
  status text not null,
  blocks_withdrawals boolean not null default false,
  blocks_settlement boolean not null default false,
  blocks_publication boolean not null default false,
  assigned_to uuid references public.users(id),
  resolution text
);

create table public.fee_quotes (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  quote_ref text not null,
  user_id uuid not null references public.users(id),
  market_id uuid not null references public.markets(id),
  outcome_id uuid not null references public.market_outcomes(id),
  fee_schedule_id uuid not null references public.fee_schedules(id),
  fee_schedule_version integer not null,
  request_fingerprint char(64) not null,
  order_value_atoms numeric(78,0) not null,
  fee_atoms numeric(78,0) not null,
  total_debit_atoms numeric(78,0) not null,
  potential_payout_atoms numeric(78,0) not null,
  price_impact_basis_points integer not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  unique (tenant_id, quote_ref)
);
create table public.fee_charges (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  fee_charge_ref text not null,
  user_id uuid not null references public.users(id),
  fee_rule_id uuid not null references public.fee_rules(id),
  amount_atoms numeric(78,0) not null check (amount_atoms >= 0),
  asset_id uuid not null references public.assets(id),
  ledger_journal_id uuid not null,
  source_type text not null,
  source_ref text not null,
  charged_at timestamptz not null,
  unique (tenant_id, fee_charge_ref),
  unique (source_type, source_ref, fee_rule_id)
);
create table public.partner_fee_allocations (
  id uuid primary key default public.uuid_v7(),
  fee_charge_id uuid not null references public.fee_charges(id),
  partner_ref text not null,
  amount_atoms numeric(78,0) not null check (amount_atoms >= 0),
  ledger_journal_id uuid not null
);

create table public.resolution_proposals (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  proposal_ref text not null,
  market_id uuid not null references public.markets(id),
  outcome_id uuid references public.market_outcomes(id),
  proposed_by uuid not null references public.users(id),
  reason text not null,
  evidence_hash char(64) not null,
  calculation_version text,
  index_version integer,
  start_value_atoms numeric(78,0),
  end_value_atoms numeric(78,0),
  result text not null,
  status text not null default 'proposed',
  proposed_at timestamptz not null default clock_timestamp(),
  approved_at timestamptz,
  unique (tenant_id, proposal_ref),
  unique (market_id, status) deferrable initially immediate
);
create table public.resolution_evidence (
  id uuid primary key default public.uuid_v7(),
  proposal_id uuid not null references public.resolution_proposals(id),
  source_uri text not null,
  object_ref text,
  content_hash char(64) not null,
  captured_at timestamptz not null,
  notes text not null,
  raw_observations jsonb,
  excluded_observations jsonb
);
create table public.resolution_approvals (
  id uuid primary key default public.uuid_v7(),
  proposal_id uuid not null references public.resolution_proposals(id),
  officer_id uuid not null references public.users(id),
  decision text not null check (decision in ('approve', 'reject')),
  reason text not null,
  decided_at timestamptz not null default clock_timestamp(),
  unique (proposal_id, officer_id)
);
create table public.resolution_disputes (
  id uuid primary key default public.uuid_v7(),
  proposal_id uuid not null references public.resolution_proposals(id),
  dispute_ref text not null unique,
  user_id uuid references public.users(id),
  reason text not null,
  evidence jsonb not null,
  status text not null,
  opened_at timestamptz not null
);
create table public.resolution_appeals (
  id uuid primary key default public.uuid_v7(),
  dispute_id uuid not null references public.resolution_disputes(id),
  appeal_ref text not null unique,
  reason text not null,
  status text not null,
  created_at timestamptz not null default clock_timestamp()
);
create table public.settlement_runs (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  settlement_ref text not null,
  market_id uuid not null unique references public.markets(id),
  proposal_id uuid not null references public.resolution_proposals(id),
  status text not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  totals jsonb,
  unique (tenant_id, settlement_ref)
);
create table public.settlement_items (
  id uuid primary key default public.uuid_v7(),
  settlement_run_id uuid not null references public.settlement_runs(id),
  position_id uuid not null references public.positions(id),
  user_id uuid not null references public.users(id),
  payout_atoms numeric(78,0) not null check (payout_atoms >= 0),
  ledger_journal_id uuid not null,
  settled_at timestamptz not null,
  unique (settlement_run_id, position_id)
);

create table public.notifications (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  notification_ref text not null,
  user_id uuid not null references public.users(id),
  notification_type text not null,
  title text not null,
  body text not null,
  data jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, notification_ref)
);
create table public.notification_deliveries (
  id uuid primary key default public.uuid_v7(),
  notification_id uuid not null references public.notifications(id),
  channel text not null,
  provider_ref text,
  provider_message_ref text,
  status text not null,
  attempt_count integer not null default 0,
  delivered_at timestamptz,
  last_error text,
  locked_at timestamptz,
  locked_by text,
  unique (notification_id, channel)
);
create table public.audit_log (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid references public.tenants(id),
  event_ref text not null unique,
  actor_ref text not null,
  actor_roles text[] not null,
  action text not null,
  resource_type text not null,
  resource_ref text not null,
  previous_value jsonb,
  new_value jsonb,
  ip inet,
  device_ref text,
  reason text,
  approver_ref text,
  occurred_at timestamptz not null default clock_timestamp()
);
create table public.outbox_events (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  event_ref text not null,
  aggregate_type text not null,
  aggregate_ref text not null,
  event_type text not null,
  channel text not null,
  sequence bigint not null,
  payload_version text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  published_at timestamptz,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default clock_timestamp(),
  locked_at timestamptz,
  locked_by text,
  unique (tenant_id, event_ref),
  unique (channel, sequence)
);
create table public.idempotency_records (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  actor_ref text not null,
  operation text not null,
  idempotency_key text not null,
  request_fingerprint char(64) not null,
  response_status integer,
  response_body jsonb,
  locked_until timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, actor_ref, operation, idempotency_key)
);
create table public.provider_webhook_events (
  id uuid primary key default public.uuid_v7(),
  provider_ref text not null,
  provider_event_ref text not null,
  event_type text not null,
  payload_hash char(64) not null,
  signature_valid boolean not null,
  received_at timestamptz not null default clock_timestamp(),
  processed_at timestamptz,
  processing_error text,
  unique (provider_ref, provider_event_ref)
);
create table public.system_incidents (
  id uuid primary key default public.uuid_v7(),
  incident_ref text not null unique,
  severity text not null,
  title text not null,
  status text not null,
  started_at timestamptz not null,
  resolved_at timestamptz,
  commander_id uuid references public.users(id),
  summary text
);

alter table public.deposits
  add constraint deposits_ledger_journal_fk foreign key (ledger_journal_id) references public.ledger_journals(id);
alter table public.withdrawals
  add constraint withdrawals_reserved_journal_fk foreign key (reserved_journal_id) references public.ledger_journals(id),
  add constraint withdrawals_completion_journal_fk foreign key (completion_journal_id) references public.ledger_journals(id);
alter table public.trades
  add constraint trades_ledger_journal_fk foreign key (ledger_journal_id) references public.ledger_journals(id);
alter table public.collateral_reservations
  add constraint collateral_reservations_ledger_fk foreign key (ledger_journal_id) references public.ledger_journals(id);
alter table public.fee_charges
  add constraint fee_charges_ledger_fk foreign key (ledger_journal_id) references public.ledger_journals(id);
alter table public.partner_fee_allocations
  add constraint partner_fee_allocations_ledger_fk foreign key (ledger_journal_id) references public.ledger_journals(id);
alter table public.settlement_items
  add constraint settlement_items_ledger_fk foreign key (ledger_journal_id) references public.ledger_journals(id);

create index markets_catalogue_idx on public.markets (status, featured desc, closes_at);
create index markets_search_idx on public.markets using gin (to_tsvector('english', title || ' ' || question));
create index orders_open_book_idx on public.orders (market_id, outcome_id, side, price_atoms, book_sequence)
  where status in ('open', 'partially_filled');
create index orders_user_idx on public.orders (user_id, created_at desc);
create index trades_market_idx on public.trades (market_id, book_sequence desc);
create index price_history_lookup_idx on public.market_price_history (market_id, outcome_id, observed_at);
create index price_observations_lookup_idx on public.price_observations (instrument_id, received_timestamp desc);
create index price_index_values_lookup_idx on public.price_index_values (price_index_id, observed_at desc);
create index ledger_entries_journal_idx on public.ledger_entries (journal_id);
create index ledger_entries_account_idx on public.ledger_entries (account_id, created_at);
create index outbox_pending_idx on public.outbox_events (next_attempt_at) where published_at is null;
create index audit_resource_idx on public.audit_log (resource_type, resource_ref, occurred_at desc);
create index reconciliation_open_idx on public.reconciliation_cases (status) where status <> 'resolved';

create or replace function public.current_tenant_id()
returns uuid language sql stable
as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;
create or replace function public.current_user_id()
returns uuid language sql stable
as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create or replace function public.deny_immutable_row_change()
returns trigger language plpgsql
as $$
begin
  raise exception using errcode = '42501', message = format('%s is append-only', tg_table_name);
end;
$$;
create trigger ledger_entries_append_only before update or delete on public.ledger_entries
for each row execute function public.deny_immutable_row_change();
create trigger audit_log_append_only before update or delete on public.audit_log
for each row execute function public.deny_immutable_row_change();
create trigger market_status_events_append_only before update or delete on public.market_status_events
for each row execute function public.deny_immutable_row_change();
create trigger trades_append_only before update or delete on public.trades
for each row execute function public.deny_immutable_row_change();
create trigger resolution_evidence_append_only before update or delete on public.resolution_evidence
for each row execute function public.deny_immutable_row_change();

create or replace function public.protect_open_market_configuration()
returns trigger language plpgsql
as $$
declare
  v_market_id uuid := coalesce(new.market_id, old.market_id);
  v_status public.market_status;
begin
  select status into v_status from public.markets where id = v_market_id;
  if v_status not in ('draft','under_review') then
    raise exception using errcode = '42501', message = 'Open market configuration is immutable.';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger market_rules_immutable
before insert or update or delete on public.market_rules
for each row execute function public.protect_open_market_configuration();
create trigger market_sources_immutable
before insert or update or delete on public.market_sources
for each row execute function public.protect_open_market_configuration();
create trigger market_outcomes_immutable
before insert or update or delete on public.market_outcomes
for each row execute function public.protect_open_market_configuration();

create or replace function public.protect_completed_provider_record()
returns trigger language plpgsql
as $$
begin
  if old.status::text in ('credited','completed','reversed','chargeback') then
    raise exception using errcode = '42501', message = 'Completed provider records are immutable.';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger deposits_completed_immutable before update or delete on public.deposits
for each row execute function public.protect_completed_provider_record();
create trigger withdrawals_completed_immutable before update or delete on public.withdrawals
for each row execute function public.protect_completed_provider_record();

create or replace function public.assert_ledger_journal_balanced()
returns trigger language plpgsql
as $$
declare
  v_journal_id uuid := coalesce(new.journal_id, old.journal_id);
  v_debit numeric(78,0);
  v_credit numeric(78,0);
begin
  select coalesce(sum(debit_atoms), 0), coalesce(sum(credit_atoms), 0)
  into v_debit, v_credit from public.ledger_entries where journal_id = v_journal_id;
  if v_debit <> v_credit then
    raise exception using errcode = '23514', message = 'Ledger journal is not balanced.';
  end if;
  return coalesce(new, old);
end;
$$;
create constraint trigger ledger_balance_guard
after insert or update or delete on public.ledger_entries
deferrable initially deferred for each row execute function public.assert_ledger_journal_balanced();

create or replace function public.assert_market_immutable()
returns trigger language plpgsql
as $$
begin
  if old.status not in ('draft', 'under_review') and (
    new.title is distinct from old.title or
    new.question is distinct from old.question or
    new.opens_at is distinct from old.opens_at or
    new.closes_at is distinct from old.closes_at or
    new.resolution_at is distinct from old.resolution_at or
    new.payout_atoms is distinct from old.payout_atoms or
    new.tick_atoms is distinct from old.tick_atoms or
    new.product_definition_id is distinct from old.product_definition_id or
    new.jurisdiction_policy_id is distinct from old.jurisdiction_policy_id or
    new.fee_schedule_id is distinct from old.fee_schedule_id or
    new.immutable_rule_version is distinct from old.immutable_rule_version
  ) then
    raise exception using errcode = '23514', message = 'Market terms are immutable after review.';
  end if;
  if new.status is distinct from old.status
    and current_setting('app.market_transition_authorized', true) is distinct from 'on' then
    raise exception using errcode = '42501', message = 'Market status must change through the transition function.';
  end if;
  return new;
end;
$$;
create trigger markets_immutable_guard before update on public.markets
for each row execute function public.assert_market_immutable();

create or replace function public.transition_market(
  p_tenant_id uuid,
  p_market_ref text,
  p_target public.market_status,
  p_actor_id uuid,
  p_reason text
)
returns public.markets
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_market public.markets;
  v_from public.market_status;
  v_allowed boolean;
begin
  select * into v_market from public.markets
  where tenant_id = p_tenant_id and market_ref = p_market_ref for update;
  if not found then raise exception using errcode = 'P0002', message = 'Market not found.'; end if;
  v_from := v_market.status;
  v_allowed := (v_from, p_target) in (
    ('draft','under_review'), ('draft','cancelled'), ('under_review','approved'),
    ('under_review','draft'), ('under_review','cancelled'), ('approved','scheduled'),
    ('approved','cancelled'), ('scheduled','pre_open'), ('scheduled','cancelled'),
    ('pre_open','open'), ('pre_open','suspended'), ('pre_open','cancelled'),
    ('open','suspended'), ('open','closing'), ('suspended','open'),
    ('suspended','closing'), ('suspended','cancelled'), ('closing','closed'),
    ('closed','resolution_pending'), ('resolution_pending','proposed'),
    ('resolution_pending','disputed'), ('resolution_pending','voided'),
    ('proposed','resolved'), ('proposed','disputed'), ('proposed','voided'),
    ('disputed','appealed'), ('disputed','proposed'), ('disputed','voided'),
    ('appealed','proposed'), ('appealed','voided'), ('resolved','settling'),
    ('settling','settled'), ('settled','archived'), ('cancelled','archived'),
    ('voided','settling')
  );
  if not v_allowed then
    raise exception using errcode = '23514', message = format('Invalid market transition: %s to %s.', v_from, p_target);
  end if;
  if p_target = 'approved' and v_market.created_by = p_actor_id then
    raise exception using errcode = '42501', message = 'A different officer must approve the market.';
  end if;
  if p_target = 'scheduled' and v_market.approved_by is null then
    raise exception using errcode = '23514', message = 'The market must have an independent approval.';
  end if;
  if p_target = 'open' and clock_timestamp() not between v_market.opens_at and v_market.closes_at then
    raise exception using errcode = '23514', message = 'The market is outside its trading window.';
  end if;
  perform set_config('app.market_transition_authorized', 'on', true);
  update public.markets set status = p_target,
    approved_by = case when p_target = 'approved' then p_actor_id else approved_by end,
    approved_at = case when p_target = 'approved' then clock_timestamp() else approved_at end,
    approval_state = case when p_target = 'approved' then 'approved' else approval_state end,
    trading_suspended = case
      when p_target = 'suspended' then true
      when p_target = 'open' then false
      else trading_suspended
    end,
    updated_at = clock_timestamp()
  where id = v_market.id returning * into v_market;
  insert into public.market_status_events (market_id, from_status, to_status, actor_id, reason)
  values (v_market.id, v_from, p_target, p_actor_id, p_reason);
  return v_market;
end;
$$;

create view public.ledger_account_balances as
select
  a.id as account_id,
  a.tenant_id,
  a.owner_user_id,
  a.asset_id,
  a.account_type,
  case when a.normal_side = 'debit'
    then coalesce(sum(e.debit_atoms - e.credit_atoms), 0)
    else coalesce(sum(e.credit_atoms - e.debit_atoms), 0)
  end as balance_atoms
from public.ledger_accounts a
left join public.ledger_entries e on e.account_id = a.id
group by a.id;

alter table public.users enable row level security;
alter table public.wallet_accounts enable row level security;
alter table public.deposit_intents enable row level security;
alter table public.deposits enable row level security;
alter table public.withdrawal_requests enable row level security;
alter table public.withdrawals enable row level security;
alter table public.markets enable row level security;
alter table public.orders enable row level security;
alter table public.trades enable row level security;
alter table public.positions enable row level security;
alter table public.ledger_accounts enable row level security;
alter table public.ledger_journals enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.notifications enable row level security;
alter table public.idempotency_records enable row level security;

create policy tenant_users on public.users using (tenant_id = public.current_tenant_id());
create policy tenant_wallets on public.wallet_accounts using (tenant_id = public.current_tenant_id());
create policy tenant_deposit_intents on public.deposit_intents using (tenant_id = public.current_tenant_id());
create policy tenant_deposits on public.deposits using (tenant_id = public.current_tenant_id());
create policy tenant_withdrawal_requests on public.withdrawal_requests using (tenant_id = public.current_tenant_id());
create policy tenant_withdrawals on public.withdrawals using (tenant_id = public.current_tenant_id());
create policy public_market_read on public.markets for select using (status in ('open','suspended','closing','closed','resolution_pending','proposed','disputed','resolved','settling','settled','voided'));
create policy tenant_market_write on public.markets for all using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
create policy owner_orders on public.orders using (tenant_id = public.current_tenant_id() and user_id = public.current_user_id());
create policy public_trade_read on public.trades for select using (true);
create policy owner_positions on public.positions using (tenant_id = public.current_tenant_id() and user_id = public.current_user_id());
create policy owner_ledger_accounts on public.ledger_accounts using (tenant_id = public.current_tenant_id() and (owner_user_id is null or owner_user_id = public.current_user_id()));
create policy tenant_ledger_journals on public.ledger_journals using (tenant_id = public.current_tenant_id());
create policy tenant_ledger_entries on public.ledger_entries using (tenant_id = public.current_tenant_id());
create policy owner_notifications on public.notifications using (tenant_id = public.current_tenant_id() and user_id = public.current_user_id());
create policy tenant_idempotency on public.idempotency_records using (tenant_id = public.current_tenant_id());

comment on schema public is 'Zoryqon authoritative production schema. Bootstrap data is created only through explicit audited operator commands.';
