-- Canonical Supabase integration for Zoryqon.
-- Supabase provides Postgres, Auth, Storage and Realtime. No Redis or Kafka is required.


insert into public.tenants
  (tenant_ref, legal_name, status, default_country, default_timezone)
values ('zoryqon', 'Zoryqon', 'active', 'SE', 'Europe/Stockholm')
on conflict (tenant_ref) do update
set legal_name = excluded.legal_name,
    status = case when public.tenants.status = 'closed' then public.tenants.status else 'active' end,
    default_country = excluded.default_country,
    default_timezone = excluded.default_timezone,
    updated_at = clock_timestamp();

insert into public.roles (role_key, staff_role, description)
values
  ('customer', false, 'Authenticated Zoryqon customer'),
  ('platform_super_admin', true, 'Full protected operations administrator')
on conflict (role_key) do update
set staff_role = excluded.staff_role,
    description = excluded.description;

alter table public.users
  add column if not exists supabase_user_id uuid;

update public.users
set supabase_user_id = oidc_subject::uuid
where supabase_user_id is null
  and oidc_subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

create unique index if not exists users_tenant_supabase_user_unique
  on public.users (tenant_id, supabase_user_id);

alter table public.users
  drop constraint if exists users_supabase_user_id_fkey;

alter table public.users
  add constraint users_supabase_user_id_fkey
  foreign key (supabase_user_id) references auth.users(id)
  on update cascade on delete restrict
  not valid;

create table if not exists public.event_stream (
  id bigint generated always as identity primary key,
  event_ref text not null unique,
  event_type text not null,
  channel text not null,
  sequence bigint not null,
  payload_version text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  published_at timestamptz not null default clock_timestamp()
);

create index if not exists event_stream_channel_sequence_idx
  on public.event_stream (channel, sequence desc);
create index if not exists event_stream_occurred_at_idx
  on public.event_stream (occurred_at desc);

alter table public.event_stream enable row level security;

create or replace function public.current_supabase_user_ref()
returns text
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select u.user_ref
  from public.users u
  where u.supabase_user_id = auth.uid()
  limit 1
$$;

revoke all on function public.current_supabase_user_ref() from public;
grant execute on function public.current_supabase_user_ref() to anon, authenticated;

drop policy if exists event_stream_read on public.event_stream;
create policy event_stream_read
on public.event_stream
for select
to anon, authenticated
using (
  channel like 'market.%'
  or channel like 'system.%'
  or (
    auth.uid() is not null
    and channel like 'user.' || coalesce(public.current_supabase_user_ref(), '__no_user__') || '.%'
  )
);

grant select on public.event_stream to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'zoryqon-private',
  'zoryqon-private',
  false,
  52428800,
  array[
    'application/pdf',
    'application/json',
    'image/jpeg',
    'image/png',
    'text/plain'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Direct user access remains denied by default. Server-side operations use the Supabase secret key.
-- Add narrowly scoped storage policies later for any client-direct upload flow.

do $$
begin
  alter publication supabase_realtime add table public.event_stream;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;

comment on table public.event_stream is
  'Durable Supabase Realtime source populated atomically from the transactional outbox.';
comment on column public.users.supabase_user_id is
  'Canonical identity reference to auth.users.id in the connected Supabase project.';
