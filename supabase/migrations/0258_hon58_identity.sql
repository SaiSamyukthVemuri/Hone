-- ===========================================================================
-- HON-58 identity: preferred name on the client + a separate legal identity.
-- MIGRATION PROPOSAL. UNNUMBERED. NOT A MIGRATION. NOT IN supabase/migrations.
--
-- It lives under docs/proposals/ so no migration tooling, db reset or deploy
-- can pick it up. OPS allocates the number (`npm run migration:state`; 0247 to
-- 0256 belong to the staged workstream, so none is chosen here) and, only
-- then, it is copied to supabase/migrations/<number>_hon58_identity.sql
-- UNCHANGED, with its tests renamed. Hosted application needs its own per-change
-- authorization. This file edits no frozen SQL and nothing it creates exists yet.
--
-- OPS decisions recorded for this proposal (2026-10-27):
--   * one client identity: no second client row is ever created for an
--     alternate name;
--   * preferred name on ordinary surfaces, legal identity only where
--     authorized and needed;
--   * no inferred legal identity, no backfill (no UPDATE/INSERT of existing
--     rows anywhere in this file);
--   * Q2 insurer/claim output legal only; internal clinical packet legal +
--     (preferred): an application rule, nothing in this file;
--   * Q3 no preferred-name field on public booking: no booking function or
--     public grant here touches the new column;
--   * Q4 no search index now: none created;
--   * Q1 UNRESOLVED and GATED: receptionists are DENIED. Legal identity is
--     readable and writable by an active OWNER or PRACTITIONER only.
--
-- How receptionists are denied, and how that is changed later. A receptionist
-- is not a `practitioners` row (0216). Every authorization below goes through
-- ONE predicate, public.can_use_client_legal_identity(studio_id), which today
-- is exactly public.is_studio_member(studio_id): an active practitioners row
-- (owner or practitioner), never a studio_receptionists row, never
-- service_role, never anon. Enabling receptionists later is therefore ONE
-- reviewed `create or replace function` of that predicate in its own
-- migration, with its own tests, and no policy or grant has to change.
-- ===========================================================================

begin;
set local lock_timeout = '5s';

-- 1. Preferred name: additive and nullable (no table rewrite), no default, no backfill.
alter table public.clients
  add column preferred_name text;

alter table public.clients
  add constraint clients_preferred_name_shape
  check (preferred_name is null
         or (length(preferred_name) between 1 and 200 and preferred_name = btrim(preferred_name)))
  not valid;
-- Every existing row has preferred_name null, so validation is trivially true.
alter table public.clients validate constraint clients_preferred_name_shape;

comment on column public.clients.preferred_name is
  'HON-58: the name the client goes by. Ordinary display = coalesce(nullif(btrim(preferred_name), ''''), name). Staff-entered; never inferred; no backfill.';

-- 2. The single authorization predicate for legal identity (see the header).
create function public.can_use_client_legal_identity(target_studio_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select public.is_studio_member(target_studio_id);
$$;

-- Supabase's default privileges grant EXECUTE to anon, authenticated and
-- service_role at create time: revoke from all three by name, then grant back
-- only what the policies need.
revoke all on function public.can_use_client_legal_identity(uuid) from public, anon, authenticated, service_role;
grant execute on function public.can_use_client_legal_identity(uuid) to authenticated;

comment on function public.can_use_client_legal_identity(uuid) is
  'HON-58 Q1 gate. Today: active owner or practitioner of the studio (receptionists, anon and service_role are denied). Widening it is a separate reviewed change.';

-- 3. Legal identity: one row per client, in a table of its own so it can carry
-- stricter access than clients without column grants (which would break every
-- select("*") on clients).
create table public.client_legal_identities (
  client_id         uuid primary key,
  studio_id         uuid not null,
  legal_given_name  text,
  legal_middle_name text,
  legal_family_name text,
  -- Provenance: staff entry is the only allowed source, never an insurer response.
  source            text not null default 'staff_entry' check (source = 'staff_entry'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  updated_by        uuid references public.practitioners(id) on delete set null,
  constraint client_legal_identities_client_studio_fk
    foreign key (client_id, studio_id)
    references public.clients (id, studio_id) on delete cascade,
  constraint client_legal_identities_some_name
    check (coalesce(nullif(btrim(legal_given_name), ''), nullif(btrim(legal_family_name), '')) is not null),
  constraint client_legal_identities_given_len
    check (legal_given_name is null or length(legal_given_name) between 1 and 200),
  constraint client_legal_identities_middle_len
    check (legal_middle_name is null or length(legal_middle_name) between 1 and 200),
  constraint client_legal_identities_family_len
    check (legal_family_name is null or length(legal_family_name) between 1 and 200)
);

alter table public.client_legal_identities enable row level security;

-- Select, insert and update only. There is no delete policy and no delete
-- grant: a legal identity leaves only when its client does (the cascade).
create policy client_legal_identities_select
  on public.client_legal_identities for select to authenticated
  using (public.can_use_client_legal_identity(studio_id));

create policy client_legal_identities_insert
  on public.client_legal_identities for insert to authenticated
  with check (public.can_use_client_legal_identity(studio_id));

create policy client_legal_identities_update
  on public.client_legal_identities for update to authenticated
  using (public.can_use_client_legal_identity(studio_id))
  with check (public.can_use_client_legal_identity(studio_id));

revoke all on public.client_legal_identities from public, anon, authenticated, service_role;
grant select, insert, update on public.client_legal_identities to authenticated;
-- service_role: NO grant. No server path needs legal identity without a signed-in
-- practitioner, and a receptionist's server paths use the service role.

-- 4. A legal identity cannot be re-pointed at another client or studio, and
-- records its own update time.
create function public.client_legal_identities_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.client_id is distinct from old.client_id or new.studio_id is distinct from old.studio_id then
    raise exception 'client_legal_identities: client and studio are immutable' using errcode = '23514';
  end if;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.client_legal_identities_guard() from public, anon, authenticated, service_role;

create trigger client_legal_identities_guard
  before update on public.client_legal_identities
  for each row execute function public.client_legal_identities_guard();

comment on table public.client_legal_identities is
  'HON-58: legal identity for clinical and insurer output. Staff-entered only (never inferred from an insurer), owner and practitioner only (receptionists denied, Q1 gated), never logged, no service_role grant.';

commit;
