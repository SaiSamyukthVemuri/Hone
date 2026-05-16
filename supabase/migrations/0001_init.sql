-- Hone initial schema.
-- Multi-tenant from day one: every record scoped by studio_id, RLS enforces isolation.

create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

create table public.studios (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  legal_entity_name text,
  owner_email text not null,
  created_at timestamptz not null default now()
);

create table public.practitioners (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  display_name text not null,
  email text not null,
  role text not null default 'practitioner' check (role in ('owner', 'practitioner')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (studio_id, user_id)
);

create index practitioners_user_id_idx on public.practitioners (user_id) where user_id is not null;
create index practitioners_studio_id_idx on public.practitioners (studio_id);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  name text not null,
  pronouns text,
  date_of_birth date,
  phone text,
  email text,
  address text,
  fitzpatrick_type int check (fitzpatrick_type between 1 and 6),
  skin_notes text,
  contraindications jsonb,
  photo_consent boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references public.practitioners(id) on delete set null
);

create index clients_studio_name_idx on public.clients (studio_id, name);

create table public.client_pricing (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  service_name text not null,
  price_cents int not null check (price_cents >= 0),
  notes text,
  effective_from date not null default current_date
);

create index client_pricing_studio_client_idx on public.client_pricing (studio_id, client_id);

create table public.probe_lots (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  probe_size text not null,
  lot_number text,
  expiry_date date,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

create index probe_lots_studio_active_idx on public.probe_lots (studio_id, active);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  practitioner_id uuid not null references public.practitioners(id) on delete restrict,
  modality text not null check (modality in ('electrolysis', 'laser')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  session_notes text,
  created_at timestamptz not null default now()
);

create index sessions_studio_client_started_idx
  on public.sessions (studio_id, client_id, started_at desc);

create table public.electrolysis_entries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  area text not null,
  probe_size text,
  probe_lot_id uuid references public.probe_lots(id) on delete set null,
  mode text check (mode in ('thermo', 'galv', 'blend')),
  intensity numeric,
  duration_seconds numeric,
  comments text,
  created_at timestamptz not null default now()
);

create index electrolysis_entries_session_idx on public.electrolysis_entries (session_id);

create table public.laser_entries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  zone text not null,
  session_number int,
  equipment_params jsonb,
  observation_notes text,
  ejection_results text,
  created_at timestamptz not null default now()
);

create index laser_entries_session_idx on public.laser_entries (session_id);

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete set null,
  area text,
  storage_path text not null,
  photo_type text check (photo_type in ('before', 'after', 'progress')),
  taken_at timestamptz not null default now()
);

create index photos_client_session_idx on public.photos (client_id, session_id);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  actor_id uuid references public.practitioners(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index audit_logs_studio_created_idx on public.audit_logs (studio_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Membership helper
-- ─────────────────────────────────────────────────────────────────────────────

-- Returns true if the current auth user is an active practitioner in the given studio.
-- security definer + stable so it can be called inside RLS policies without recursion.
create or replace function public.is_studio_member(target_studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.practitioners
    where studio_id = target_studio_id
      and user_id = auth.uid()
      and active = true
  );
$$;

create or replace function public.is_studio_owner(target_studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.practitioners
    where studio_id = target_studio_id
      and user_id = auth.uid()
      and active = true
      and role = 'owner'
  );
$$;

revoke all on function public.is_studio_member(uuid) from public;
revoke all on function public.is_studio_owner(uuid) from public;
grant execute on function public.is_studio_member(uuid) to authenticated;
grant execute on function public.is_studio_owner(uuid) to authenticated;

-- Helper for joining through sessions on the per-entry tables.
create or replace function public.session_is_visible(target_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.sessions s
    where s.id = target_session_id
      and public.is_studio_member(s.studio_id)
  );
$$;

revoke all on function public.session_is_visible(uuid) from public;
grant execute on function public.session_is_visible(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.studios               enable row level security;
alter table public.practitioners         enable row level security;
alter table public.clients               enable row level security;
alter table public.client_pricing        enable row level security;
alter table public.probe_lots            enable row level security;
alter table public.sessions              enable row level security;
alter table public.electrolysis_entries  enable row level security;
alter table public.laser_entries         enable row level security;
alter table public.photos                enable row level security;
alter table public.audit_logs            enable row level security;

-- studios: members can read; only owners can update. Creation happens via service role.
create policy "studios: members read"
  on public.studios for select to authenticated
  using (public.is_studio_member(id));

create policy "studios: owners update"
  on public.studios for update to authenticated
  using (public.is_studio_owner(id))
  with check (public.is_studio_owner(id));

-- practitioners: members read their studio's roster; owners manage.
create policy "practitioners: members read"
  on public.practitioners for select to authenticated
  using (public.is_studio_member(studio_id));

create policy "practitioners: owners insert"
  on public.practitioners for insert to authenticated
  with check (public.is_studio_owner(studio_id));

create policy "practitioners: owners update"
  on public.practitioners for update to authenticated
  using (public.is_studio_owner(studio_id))
  with check (public.is_studio_owner(studio_id));

create policy "practitioners: owners delete"
  on public.practitioners for delete to authenticated
  using (public.is_studio_owner(studio_id));

-- clients: any member can read/write within their studio.
create policy "clients: members all"
  on public.clients for all to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

create policy "client_pricing: members all"
  on public.client_pricing for all to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

create policy "probe_lots: members all"
  on public.probe_lots for all to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

create policy "sessions: members all"
  on public.sessions for all to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

create policy "electrolysis_entries: members all"
  on public.electrolysis_entries for all to authenticated
  using (public.session_is_visible(session_id))
  with check (public.session_is_visible(session_id));

create policy "laser_entries: members all"
  on public.laser_entries for all to authenticated
  using (public.session_is_visible(session_id))
  with check (public.session_is_visible(session_id));

create policy "photos: members all"
  on public.photos for all to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- audit_logs: members can read and insert; never update or delete.
create policy "audit_logs: members read"
  on public.audit_logs for select to authenticated
  using (public.is_studio_member(studio_id));

create policy "audit_logs: members insert"
  on public.audit_logs for insert to authenticated
  with check (public.is_studio_member(studio_id));
