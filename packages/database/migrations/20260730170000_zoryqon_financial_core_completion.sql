-- Zoryqon forward-only completion for scheduled markets, provider submission,
-- fully collateralised binary complete sets and exactly-once settlement.

alter table public.withdrawal_requests
  add column confirmation_idempotency_key text,
  add column provider_idempotency_key text,
  add column submission_claimed_at timestamptz,
  add column submission_attempts integer not null default 0
    check (submission_attempts >= 0),
  add column last_submission_error text;

create unique index withdrawal_provider_idempotency_unique
  on public.withdrawal_requests (tenant_id, provider_idempotency_key)
  where provider_idempotency_key is not null;

alter table public.market_template_schedules
  add column last_scheduled_for timestamptz,
  add column last_run_at timestamptz,
  add column last_run_status text
    check (last_run_status in ('processing', 'succeeded', 'failed')),
  add column last_error text,
  add column run_attempt_count integer not null default 0
    check (run_attempt_count >= 0),
  add column locked_at timestamptz,
  add column locked_by text;

create table public.market_schedule_runs (
  id uuid primary key default public.uuid_v7(),
  schedule_id uuid not null references public.market_template_schedules(id),
  tenant_id uuid not null references public.tenants(id),
  scheduled_for timestamptz not null,
  status text not null check (status in ('processing', 'succeeded', 'failed')),
  market_id uuid references public.markets(id),
  worker_ref text not null,
  attempt_count integer not null default 1 check (attempt_count > 0),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  last_error text,
  unique (schedule_id, scheduled_for)
);

create index market_schedule_runs_pending_idx
  on public.market_schedule_runs (status, started_at)
  where status <> 'succeeded';

create table public.complete_set_mints (
  id uuid primary key default public.uuid_v7(),
  tenant_id uuid not null references public.tenants(id),
  mint_ref text not null,
  market_id uuid not null references public.markets(id),
  user_id uuid not null references public.users(id),
  quantity numeric(78,0) not null check (quantity > 0),
  collateral_atoms numeric(78,0) not null check (collateral_atoms > 0),
  ledger_journal_id uuid not null references public.ledger_journals(id),
  idempotency_key text not null,
  request_fingerprint char(64) not null,
  minted_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, mint_ref),
  unique (tenant_id, user_id, idempotency_key)
);

alter table public.position_lots
  alter column trade_id drop not null,
  add column complete_set_mint_id uuid references public.complete_set_mints(id),
  add constraint position_lot_exactly_one_source check (
    (trade_id is not null and complete_set_mint_id is null)
    or (trade_id is null and complete_set_mint_id is not null)
  );

create unique index position_lots_mint_unique
  on public.position_lots (position_id, complete_set_mint_id)
  where complete_set_mint_id is not null;

alter table public.positions
  add column settled_quantity numeric(78,0) not null default 0
    check (settled_quantity >= 0),
  add column settled_at timestamptz,
  add column settlement_item_id uuid;

alter table public.resolution_proposals
  add column dispute_closes_at timestamptz,
  add column finalised_at timestamptz;

alter table public.settlement_runs
  add column locked_at timestamptz,
  add column locked_by text,
  add column attempt_count integer not null default 0 check (attempt_count >= 0),
  add column last_error text;

alter table public.settlement_items
  add column payout_rate_atoms numeric(78,0) not null default 0
    check (payout_rate_atoms >= 0);

alter table public.positions
  add constraint positions_settlement_item_fk
  foreign key (settlement_item_id) references public.settlement_items(id);

create index positions_unsettled_market_idx
  on public.positions (market_id, id)
  where settled_at is null and (available_quantity > 0 or locked_quantity > 0);

create index settlement_runs_worker_idx
  on public.settlement_runs (status, started_at)
  where status <> 'completed';

alter table public.market_schedule_runs enable row level security;
alter table public.complete_set_mints enable row level security;

create policy tenant_market_schedule_runs
  on public.market_schedule_runs
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy owner_complete_set_mints
  on public.complete_set_mints
  using (
    tenant_id = public.current_tenant_id()
    and user_id = public.current_user_id()
  )
  with check (
    tenant_id = public.current_tenant_id()
    and user_id = public.current_user_id()
  );

create or replace function public.assert_binary_complete_set_market(
  p_market_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_outcomes integer;
  v_status public.market_status;
begin
  select m.status, count(mo.id)::integer
  into v_status, v_outcomes
  from public.markets m
  left join public.market_outcomes mo on mo.market_id = m.id
  where m.id = p_market_id
  group by m.status;

  if not found then
    raise exception using errcode = 'P0002', message = 'Market not found.';
  end if;
  if v_status not in ('pre_open', 'open') then
    raise exception using errcode = '23514',
      message = 'Complete sets may only be minted for a pre-open or open market.';
  end if;
  if v_outcomes <> 2 then
    raise exception using errcode = '23514',
      message = 'Complete-set minting currently requires exactly two outcomes.';
  end if;
end;
$$;

comment on table public.complete_set_mints is
  'Immutable evidence that collateral was locked before one token for every binary outcome was issued.';
comment on table public.market_schedule_runs is
  'Durable, idempotent execution record for scheduled market materialisation.';
