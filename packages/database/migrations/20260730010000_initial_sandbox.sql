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
  v_variant text := substr('89ab', 1 + (get_byte(gen_random_bytes(1), 0) % 4), 1);
begin
  return (
    substr(v_time, 1, 8) || '-' ||
    substr(v_time, 9, 4) || '-7' ||
    substr(v_random, 1, 3) || '-' ||
    v_variant || substr(v_random, 4, 3) || '-' ||
    substr(v_random, 7, 12)
  )::uuid;
end;
$$;

create type public.tenant_status as enum ('onboarding', 'active', 'restricted', 'suspended', 'closed');
create type public.user_account_status as enum (
  'created',
  'email_pending',
  'phone_pending',
  'kyc_pending',
  'active',
  'restricted',
  'withdrawal_locked',
  'trading_locked',
  'suspended',
  'self_excluded',
  'closed',
  'deceased',
  'under_investigation'
);
create type public.product_status as enum (
  'draft',
  'sandbox_only',
  'legal_review',
  'partner_required',
  'approved',
  'suspended',
  'retired'
);
create type public.market_status as enum (
  'draft',
  'under_review',
  'approved',
  'scheduled',
  'pre_open',
  'open',
  'suspended',
  'closing',
  'closed',
  'resolution_pending',
  'disputed',
  'appealed',
  'resolved',
  'settling',
  'settled',
  'cancelled',
  'voided',
  'archived'
);
create type public.order_side as enum ('buy', 'sell');
create type public.order_status as enum (
  'received',
  'pending_validation',
  'accepted',
  'open',
  'partially_filled',
  'filled',
  'cancel_pending',
  'cancelled',
  'rejected',
  'expired',
  'suspended'
);
create type public.time_in_force as enum ('GTC', 'IOC', 'FOK');
create type public.ledger_normal_side as enum ('debit', 'credit');
create type public.resolution_status as enum ('proposed', 'approved', 'rejected');

create table public.tenants (
  id uuid primary key default public.uuid_v7(),
  tenant_ref text not null unique,
  legal_name text not null,
  status public.tenant_status not null default 'onboarding',
  default_country char(2) not null,
  default_timezone text not null default 'UTC',
  branding jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.product_definitions (
  id uuid primary key default public.uuid_v7(),
  product_ref text not null,
  product_type text not null,
  legal_classification text not null,
  target_customer_type text not null,
  permitted_countries char(2)[] not null default '{}',
  blocked_countries text[] not null default '{}',
  required_licences text[] not null default '{}',
  required_kyc_level text not null,
  required_risk_assessment text not null,
  allowed_order_types text[] not null default '{}',
  settlement_model text not null,
  custody_model text not null,
  fee_model text not null,
  responsible_use_model text not null,
  mobile_store_availability text not null
    check (mobile_store_availability in ('allowed', 'web_only', 'blocked')),
  status public.product_status not null,
  version text not null,
  effective_from timestamptz not null default clock_timestamp(),
  effective_to timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (product_ref, version),
  check (effective_to is null or effective_to > effective_from)
);

create table public.user_accounts (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  user_ref text not null,
  account_status public.user_account_status not null default 'created',
  customer_type text not null check (customer_type in ('consumer', 'business', 'professional')),
  verified_country char(2),
  kyc_level text not null default 'unverified',
  email_ciphertext bytea,
  phone_ciphertext bytea,
  self_excluded_at timestamptz,
  trading_locked_at timestamptz,
  withdrawal_locked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, user_ref)
);

create table public.markets (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  market_ref text not null,
  product_definition_id uuid not null references public.product_definitions(id),
  title text not null,
  question text not null,
  category text not null,
  rules text not null,
  primary_source text not null,
  backup_source text,
  resolution_method text not null,
  display_timezone text not null,
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  resolution_at timestamptz not null,
  status public.market_status not null default 'draft',
  collateral_asset text not null,
  payout_atoms numeric(78, 0) not null check (payout_atoms > 0),
  tick_atoms numeric(78, 0) not null check (tick_atoms > 0),
  minimum_order_quantity numeric(78, 0) not null check (minimum_order_quantity > 0),
  maximum_position_quantity numeric(78, 0) not null check (maximum_position_quantity > 0),
  fee_version text not null,
  immutable_rule_version text not null,
  risk_class text not null,
  allowed_countries char(2)[] not null default '{}',
  blocked_countries text[] not null default '{}',
  created_by uuid references public.user_accounts(id),
  approved_by uuid references public.user_accounts(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, market_ref),
  check (opens_at < closes_at),
  check (closes_at <= resolution_at),
  check (mod(payout_atoms, tick_atoms) = 0)
);

create table public.market_outcomes (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  market_id uuid not null references public.markets(id) on delete cascade,
  outcome_ref text not null,
  label text not null,
  display_order integer not null check (display_order >= 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, outcome_ref),
  unique (market_id, display_order)
);

create table public.fee_rules (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  fee_rule_ref text not null,
  product_type text not null,
  market_id uuid references public.markets(id),
  customer_tier text not null,
  maker_basis_points integer not null check (maker_basis_points between 0 and 10000),
  taker_basis_points integer not null check (taker_basis_points between 0 and 10000),
  minimum_fee_atoms numeric(78, 0) not null default 0 check (minimum_fee_atoms >= 0),
  maximum_fee_atoms numeric(78, 0),
  effective_from timestamptz not null,
  effective_to timestamptz,
  version text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, fee_rule_ref, version),
  check (maximum_fee_atoms is null or maximum_fee_atoms >= minimum_fee_atoms),
  check (effective_to is null or effective_to > effective_from)
);

create table public.orders (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  order_ref text not null,
  user_id uuid not null references public.user_accounts(id),
  market_id uuid not null references public.markets(id),
  outcome_id uuid not null references public.market_outcomes(id),
  side public.order_side not null,
  order_type text not null check (order_type in ('limit', 'marketable_limit')),
  price_atoms numeric(78, 0) not null check (price_atoms > 0),
  quantity numeric(78, 0) not null check (quantity > 0),
  remaining_quantity numeric(78, 0) not null check (remaining_quantity >= 0),
  time_in_force public.time_in_force not null,
  post_only boolean not null default false,
  status public.order_status not null,
  idempotency_key text not null,
  request_fingerprint char(64) not null,
  fee_rule_id uuid not null references public.fee_rules(id),
  book_sequence numeric(78, 0) not null check (book_sequence > 0),
  received_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, order_ref),
  unique (tenant_id, user_id, idempotency_key),
  check (remaining_quantity <= quantity)
);

create table public.trades (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  trade_ref text not null,
  market_id uuid not null references public.markets(id),
  outcome_id uuid not null references public.market_outcomes(id),
  maker_order_id uuid not null references public.orders(id),
  taker_order_id uuid not null references public.orders(id),
  buyer_user_id uuid not null references public.user_accounts(id),
  seller_user_id uuid not null references public.user_accounts(id),
  price_atoms numeric(78, 0) not null check (price_atoms > 0),
  quantity numeric(78, 0) not null check (quantity > 0),
  buyer_fee_atoms numeric(78, 0) not null check (buyer_fee_atoms >= 0),
  seller_fee_atoms numeric(78, 0) not null check (seller_fee_atoms >= 0),
  book_sequence numeric(78, 0) not null check (book_sequence > 0),
  executed_at timestamptz not null,
  ledger_journal_id uuid,
  unique (tenant_id, trade_ref),
  unique (market_id, outcome_id, book_sequence),
  check (buyer_user_id <> seller_user_id)
);

create table public.positions (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references public.user_accounts(id),
  market_id uuid not null references public.markets(id),
  outcome_id uuid not null references public.market_outcomes(id),
  available_quantity numeric(78, 0) not null default 0 check (available_quantity >= 0),
  locked_quantity numeric(78, 0) not null default 0 check (locked_quantity >= 0),
  acquired_quantity numeric(78, 0) not null default 0 check (acquired_quantity >= 0),
  total_cost_atoms numeric(78, 0) not null default 0 check (total_cost_atoms >= 0),
  realized_pnl_atoms numeric(78, 0) not null default 0,
  fees_paid_atoms numeric(78, 0) not null default 0 check (fees_paid_atoms >= 0),
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, user_id, market_id, outcome_id)
);

create table public.ledger_accounts (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  account_ref text not null,
  owner_user_id uuid references public.user_accounts(id),
  asset text not null,
  account_type text not null,
  normal_side public.ledger_normal_side not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, account_ref),
  unique nulls not distinct (tenant_id, owner_user_id, asset, account_type)
);

create table public.ledger_journals (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  journal_ref text not null,
  transaction_type text not null,
  asset text not null,
  reference_type text not null,
  reference_ref text not null,
  idempotency_key text not null,
  status text not null default 'pending' check (status in ('pending', 'posted', 'reversed')),
  created_at timestamptz not null default clock_timestamp(),
  effective_at timestamptz not null,
  posted_at timestamptz,
  unique (tenant_id, journal_ref),
  unique (tenant_id, idempotency_key)
);

create table public.ledger_entries (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  journal_id uuid not null references public.ledger_journals(id),
  account_id uuid not null references public.ledger_accounts(id),
  debit_atoms numeric(78, 0) not null default 0 check (debit_atoms >= 0),
  credit_atoms numeric(78, 0) not null default 0 check (credit_atoms >= 0),
  created_at timestamptz not null default clock_timestamp(),
  check ((debit_atoms > 0 and credit_atoms = 0) or (credit_atoms > 0 and debit_atoms = 0))
);

alter table public.trades
  add constraint trades_ledger_journal_fk
  foreign key (ledger_journal_id) references public.ledger_journals(id)
  deferrable initially deferred;

alter table public.user_accounts add constraint user_accounts_id_tenant_unique unique (id, tenant_id);
alter table public.markets add constraint markets_id_tenant_unique unique (id, tenant_id);
alter table public.market_outcomes add constraint market_outcomes_id_tenant_unique unique (id, tenant_id);
alter table public.fee_rules add constraint fee_rules_id_tenant_unique unique (id, tenant_id);
alter table public.orders add constraint orders_id_tenant_unique unique (id, tenant_id);
alter table public.ledger_accounts add constraint ledger_accounts_id_tenant_unique unique (id, tenant_id);
alter table public.ledger_journals add constraint ledger_journals_id_tenant_unique unique (id, tenant_id);
alter table public.resolution_proposals add constraint resolution_proposals_id_tenant_unique unique (id, tenant_id);

alter table public.markets
  add constraint markets_created_by_same_tenant_fk
  foreign key (created_by, tenant_id) references public.user_accounts(id, tenant_id),
  add constraint markets_approved_by_same_tenant_fk
  foreign key (approved_by, tenant_id) references public.user_accounts(id, tenant_id);
alter table public.market_outcomes
  add constraint market_outcomes_market_same_tenant_fk
  foreign key (market_id, tenant_id) references public.markets(id, tenant_id);
alter table public.fee_rules
  add constraint fee_rules_market_same_tenant_fk
  foreign key (market_id, tenant_id) references public.markets(id, tenant_id);
alter table public.orders
  add constraint orders_user_same_tenant_fk
  foreign key (user_id, tenant_id) references public.user_accounts(id, tenant_id),
  add constraint orders_market_same_tenant_fk
  foreign key (market_id, tenant_id) references public.markets(id, tenant_id),
  add constraint orders_outcome_same_tenant_fk
  foreign key (outcome_id, tenant_id) references public.market_outcomes(id, tenant_id),
  add constraint orders_fee_rule_same_tenant_fk
  foreign key (fee_rule_id, tenant_id) references public.fee_rules(id, tenant_id);
alter table public.trades
  add constraint trades_market_same_tenant_fk
  foreign key (market_id, tenant_id) references public.markets(id, tenant_id),
  add constraint trades_outcome_same_tenant_fk
  foreign key (outcome_id, tenant_id) references public.market_outcomes(id, tenant_id),
  add constraint trades_maker_order_same_tenant_fk
  foreign key (maker_order_id, tenant_id) references public.orders(id, tenant_id),
  add constraint trades_taker_order_same_tenant_fk
  foreign key (taker_order_id, tenant_id) references public.orders(id, tenant_id),
  add constraint trades_buyer_same_tenant_fk
  foreign key (buyer_user_id, tenant_id) references public.user_accounts(id, tenant_id),
  add constraint trades_seller_same_tenant_fk
  foreign key (seller_user_id, tenant_id) references public.user_accounts(id, tenant_id),
  add constraint trades_ledger_same_tenant_fk
  foreign key (ledger_journal_id, tenant_id) references public.ledger_journals(id, tenant_id)
  deferrable initially deferred;
alter table public.positions
  add constraint positions_user_same_tenant_fk
  foreign key (user_id, tenant_id) references public.user_accounts(id, tenant_id),
  add constraint positions_market_same_tenant_fk
  foreign key (market_id, tenant_id) references public.markets(id, tenant_id),
  add constraint positions_outcome_same_tenant_fk
  foreign key (outcome_id, tenant_id) references public.market_outcomes(id, tenant_id);
alter table public.ledger_accounts
  add constraint ledger_accounts_owner_same_tenant_fk
  foreign key (owner_user_id, tenant_id) references public.user_accounts(id, tenant_id);
alter table public.ledger_entries
  add constraint ledger_entries_journal_same_tenant_fk
  foreign key (journal_id, tenant_id) references public.ledger_journals(id, tenant_id),
  add constraint ledger_entries_account_same_tenant_fk
  foreign key (account_id, tenant_id) references public.ledger_accounts(id, tenant_id);
alter table public.resolution_proposals
  add constraint resolution_market_same_tenant_fk
  foreign key (market_id, tenant_id) references public.markets(id, tenant_id),
  add constraint resolution_outcome_same_tenant_fk
  foreign key (outcome_id, tenant_id) references public.market_outcomes(id, tenant_id),
  add constraint resolution_proposer_same_tenant_fk
  foreign key (proposed_by, tenant_id) references public.user_accounts(id, tenant_id);
alter table public.resolution_approvals
  add constraint resolution_approval_proposal_same_tenant_fk
  foreign key (proposal_id, tenant_id) references public.resolution_proposals(id, tenant_id),
  add constraint resolution_approval_officer_same_tenant_fk
  foreign key (officer_id, tenant_id) references public.user_accounts(id, tenant_id);

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

create table public.resolution_proposals (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  proposal_ref text not null,
  market_id uuid not null references public.markets(id),
  outcome_id uuid references public.market_outcomes(id),
  proposed_by uuid not null references public.user_accounts(id),
  reason text not null,
  evidence jsonb not null,
  evidence_hash char(64) not null,
  algorithm_version text,
  status public.resolution_status not null default 'proposed',
  proposed_at timestamptz not null default clock_timestamp(),
  approved_at timestamptz,
  unique (tenant_id, proposal_ref)
);

create table public.resolution_approvals (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  proposal_id uuid not null references public.resolution_proposals(id),
  officer_id uuid not null references public.user_accounts(id),
  decision text not null check (decision in ('approve', 'reject')),
  reason text not null,
  decided_at timestamptz not null default clock_timestamp(),
  unique (proposal_id, officer_id)
);

create table public.audit_log (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid references public.tenants(id),
  event_ref text not null unique,
  actor_ref text not null,
  actor_role text not null,
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
  payload_version text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  published_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, event_ref)
);

create index orders_open_book_idx
  on public.orders (market_id, outcome_id, side, price_atoms, book_sequence)
  where status in ('open', 'partially_filled');
create index trades_market_sequence_idx on public.trades (market_id, book_sequence desc);
create index ledger_entries_journal_idx on public.ledger_entries (journal_id);
create index ledger_entries_account_idx on public.ledger_entries (account_id, created_at);
create index outbox_unpublished_idx on public.outbox_events (next_attempt_at)
  where published_at is null;
create index audit_log_resource_idx on public.audit_log (resource_type, resource_ref, occurred_at);

create or replace function public.assert_market_immutable()
returns trigger
language plpgsql
as $$
begin
  if old.status not in ('draft', 'under_review') and (
    new.question is distinct from old.question or
    new.rules is distinct from old.rules or
    new.primary_source is distinct from old.primary_source or
    new.backup_source is distinct from old.backup_source or
    new.resolution_method is distinct from old.resolution_method or
    new.opens_at is distinct from old.opens_at or
    new.closes_at is distinct from old.closes_at or
    new.resolution_at is distinct from old.resolution_at or
    new.tick_atoms is distinct from old.tick_atoms or
    new.payout_atoms is distinct from old.payout_atoms or
    new.fee_version is distinct from old.fee_version or
    new.product_definition_id is distinct from old.product_definition_id or
    new.immutable_rule_version is distinct from old.immutable_rule_version
  ) then
    raise exception using
      errcode = '23514',
      message = 'market immutable fields cannot change after review';
  end if;
  if new.status is distinct from old.status
    and current_setting('app.market_transition_authorized', true) is distinct from 'on'
  then
    raise exception using
      errcode = '42501',
      message = 'market status must change through transition_market';
  end if;
  return new;
end;
$$;

create trigger markets_immutable_guard
before update on public.markets
for each row execute function public.assert_market_immutable();

create or replace function public.transition_market(
  p_tenant_id uuid,
  p_market_ref text,
  p_target public.market_status,
  p_actor_ref text,
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
  v_allowed boolean := false;
begin
  select * into v_market
  from public.markets
  where tenant_id = p_tenant_id and market_ref = p_market_ref
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'market not found';
  end if;
  v_from := v_market.status;

  v_allowed := (v_market.status, p_target) in (
    ('draft', 'under_review'),
    ('draft', 'cancelled'),
    ('under_review', 'approved'),
    ('under_review', 'draft'),
    ('under_review', 'cancelled'),
    ('approved', 'scheduled'),
    ('approved', 'cancelled'),
    ('scheduled', 'pre_open'),
    ('scheduled', 'cancelled'),
    ('pre_open', 'open'),
    ('pre_open', 'suspended'),
    ('pre_open', 'cancelled'),
    ('open', 'suspended'),
    ('open', 'closing'),
    ('suspended', 'open'),
    ('suspended', 'closing'),
    ('suspended', 'cancelled'),
    ('closing', 'closed'),
    ('closed', 'resolution_pending'),
    ('resolution_pending', 'resolved'),
    ('resolution_pending', 'disputed'),
    ('resolution_pending', 'voided'),
    ('disputed', 'appealed'),
    ('disputed', 'resolved'),
    ('disputed', 'voided'),
    ('appealed', 'resolved'),
    ('appealed', 'voided'),
    ('resolved', 'settling'),
    ('settling', 'settled'),
    ('settled', 'archived'),
    ('cancelled', 'archived'),
    ('voided', 'settling')
  );
  if not v_allowed then
    raise exception using
      errcode = '23514',
      message = format('invalid market transition: %s -> %s', v_market.status, p_target);
  end if;
  perform set_config('app.market_transition_authorized', 'on', true);
  update public.markets
  set status = p_target, updated_at = clock_timestamp()
  where id = v_market.id
  returning * into v_market;

  insert into public.audit_log (
    tenant_id, event_ref, actor_ref, actor_role, action,
    resource_type, resource_ref, previous_value, new_value, reason
  ) values (
    p_tenant_id, 'aud_' || replace(public.uuid_v7()::text, '-', ''), p_actor_ref,
    'service', 'market.transition', 'market', p_market_ref,
    jsonb_build_object('status', v_from),
    jsonb_build_object('status', p_target), p_reason
  );
  return v_market;
end;
$$;

create or replace function public.assert_ledger_journal_balanced()
returns trigger
language plpgsql
as $$
declare
  v_journal_id uuid := coalesce(new.journal_id, old.journal_id);
  v_debit numeric(78, 0);
  v_credit numeric(78, 0);
begin
  select coalesce(sum(debit_atoms), 0), coalesce(sum(credit_atoms), 0)
  into v_debit, v_credit
  from public.ledger_entries
  where journal_id = v_journal_id;
  if v_debit <> v_credit then
    raise exception using
      errcode = '23514',
      message = format('unbalanced ledger journal %s: debit %s credit %s', v_journal_id, v_debit, v_credit);
  end if;
  return coalesce(new, old);
end;
$$;

create constraint trigger ledger_journal_balance_guard
after insert or update or delete on public.ledger_entries
deferrable initially deferred
for each row execute function public.assert_ledger_journal_balanced();

create or replace function public.deny_immutable_row_change()
returns trigger
language plpgsql
as $$
begin
  raise exception using errcode = '42501', message = format('%s is append-only', tg_table_name);
end;
$$;

create trigger ledger_entries_append_only
before update or delete on public.ledger_entries
for each row execute function public.deny_immutable_row_change();
create trigger audit_log_append_only
before update or delete on public.audit_log
for each row execute function public.deny_immutable_row_change();

alter table public.user_accounts enable row level security;
alter table public.markets enable row level security;
alter table public.market_outcomes enable row level security;
alter table public.fee_rules enable row level security;
alter table public.orders enable row level security;
alter table public.trades enable row level security;
alter table public.positions enable row level security;
alter table public.ledger_accounts enable row level security;
alter table public.ledger_journals enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.idempotency_records enable row level security;
alter table public.resolution_proposals enable row level security;
alter table public.resolution_approvals enable row level security;
alter table public.outbox_events enable row level security;

create or replace function public.current_tenant_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'user_accounts', 'markets', 'market_outcomes', 'fee_rules', 'orders',
    'trades', 'positions', 'ledger_accounts', 'ledger_journals',
    'ledger_entries', 'idempotency_records', 'resolution_proposals',
    'resolution_approvals', 'outbox_events'
  ]
  loop
    execute format(
      'create policy tenant_isolation on public.%I using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id())',
      v_table
    );
  end loop;
end;
$$;

insert into public.product_definitions (
  product_ref,
  product_type,
  legal_classification,
  target_customer_type,
  permitted_countries,
  blocked_countries,
  required_licences,
  required_kyc_level,
  required_risk_assessment,
  allowed_order_types,
  settlement_model,
  custody_model,
  fee_model,
  responsible_use_model,
  mobile_store_availability,
  status,
  version
) values
(
  'prd_virtual_prediction_v1',
  'virtual_prediction',
  'virtual no-cash-value forecasting sandbox',
  'any',
  array[]::char(2)[],
  array[]::text[],
  array[]::text[],
  'unverified',
  'basic_abuse',
  array['limit', 'marketable_limit'],
  'fully_collateralised_virtual',
  'none',
  'virtual_fee_v1',
  'sandbox_limits_v1',
  'allowed',
  'sandbox_only',
  '2026-07-30.1'
),
(
  'prd_five_minute_up_down_v1',
  'five_minute_up_down',
  'potential binary option — written classification required',
  'any',
  array[]::char(2)[],
  array['*'],
  array['written_legal_approval'],
  'enhanced_due_diligence',
  'manual',
  array[]::text[],
  'disabled',
  'disabled',
  'disabled',
  'blocked',
  'blocked',
  'legal_review',
  '2026-07-30.1'
),
(
  'prd_spot_crypto_v1',
  'spot_crypto',
  'MiCA-authorised CASP or licensed partner required',
  'any',
  array[]::char(2)[],
  array['*'],
  array['MiCA_CASP_or_partner'],
  'enhanced_due_diligence',
  'manual',
  array[]::text[],
  'disabled',
  'disabled',
  'disabled',
  'blocked',
  'web_only',
  'partner_required',
  '2026-07-30.1'
),
(
  'prd_b2b_private_prediction_v1',
  'b2b_private_prediction',
  'private enterprise forecasting without redeemable value',
  'business',
  array[]::char(2)[],
  array[]::text[],
  array[]::text[],
  'institution_verified',
  'enterprise_access',
  array['limit', 'marketable_limit'],
  'virtual_enterprise',
  'none',
  'subscription',
  'enterprise_policy',
  'allowed',
  'approved',
  '2026-07-30.1'
),
(
  'prd_real_money_prediction_v1',
  'real_money_prediction',
  'wager or event-contract legal classification required',
  'any',
  array[]::char(2)[],
  array['*'],
  array['written_legal_approval'],
  'enhanced_due_diligence',
  'manual',
  array[]::text[],
  'disabled',
  'disabled',
  'disabled',
  'blocked',
  'web_only',
  'legal_review',
  '2026-07-30.1'
),
(
  'prd_binary_option_v1',
  'binary_option',
  'not distributable in Kynorix mobile applications',
  'any',
  array[]::char(2)[],
  array['*'],
  array['written_legal_approval'],
  'enhanced_due_diligence',
  'manual',
  array[]::text[],
  'disabled',
  'disabled',
  'disabled',
  'blocked',
  'blocked',
  'suspended',
  '2026-07-30.1'
),
(
  'prd_gold_price_display_v1',
  'gold_price_display',
  'display-only market data licensing required',
  'any',
  array[]::char(2)[],
  array['*'],
  array['market_data_licence'],
  'unverified',
  'basic_abuse',
  array[]::text[],
  'disabled',
  'none',
  'disabled',
  'blocked',
  'allowed',
  'partner_required',
  '2026-07-30.1'
),
(
  'prd_gold_event_contract_v1',
  'gold_event_contract',
  'event-contract legal classification required',
  'any',
  array[]::char(2)[],
  array['*'],
  array['written_legal_approval', 'market_data_licence'],
  'enhanced_due_diligence',
  'manual',
  array[]::text[],
  'disabled',
  'disabled',
  'disabled',
  'blocked',
  'web_only',
  'legal_review',
  '2026-07-30.1'
),
(
  'prd_gold_exposure_v1',
  'gold_exposure',
  'financial-instrument and custody classification required',
  'any',
  array[]::char(2)[],
  array['*'],
  array['written_legal_approval', 'custody_partner'],
  'enhanced_due_diligence',
  'manual',
  array[]::text[],
  'disabled',
  'disabled',
  'disabled',
  'blocked',
  'web_only',
  'legal_review',
  '2026-07-30.1'
);
