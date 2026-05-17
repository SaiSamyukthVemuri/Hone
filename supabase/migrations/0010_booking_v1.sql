-- Migration 0010: Booking & scheduling v1.
-- Adds:
--   studios: timezone, default_appointment_duration_minutes, buffer_minutes, slug
--   studio_availability_default: per day-of-week open/close defaults
--   studio_availability_overrides: per specific date open/close
--   studio_blockouts: vacation / unavailable date ranges
--   services: per-studio service catalog used in booking
--   appointments: confirmed/cancelled/completed/no_show records
--   appointment_audit: per-action audit trail for appointments
--
-- Every alter table add constraint is preceded by drop constraint if exists
-- so the file is safe to paste straight into the Supabase SQL editor and
-- safe to re-run.

-- ---------------------------------------------------------------------------
-- studios: new scheduling columns
-- ---------------------------------------------------------------------------

alter table public.studios
  add column if not exists timezone text default 'America/Toronto',
  add column if not exists default_appointment_duration_minutes integer default 60,
  add column if not exists buffer_minutes integer default 15,
  add column if not exists slug text,
  add column if not exists address text,
  add column if not exists booking_description text;

-- Backfill timezone / defaults on pre-existing rows.
update public.studios
  set timezone = coalesce(timezone, 'America/Toronto'),
      default_appointment_duration_minutes = coalesce(default_appointment_duration_minutes, 60),
      buffer_minutes = coalesce(buffer_minutes, 15);

-- Backfill slug from name; append 6 chars of the studio id to guarantee uniqueness.
update public.studios
  set slug = trim(both '-' from lower(regexp_replace(coalesce(name, 'studio'), '[^a-zA-Z0-9]+', '-', 'g')))
             || '-' || substr(replace(id::text, '-', ''), 1, 6)
  where slug is null;

alter table public.studios
  drop constraint if exists studios_slug_unique;
alter table public.studios
  add constraint studios_slug_unique unique (slug);

alter table public.studios
  drop constraint if exists studios_buffer_minutes_check;
alter table public.studios
  add constraint studios_buffer_minutes_check
  check (buffer_minutes is null or buffer_minutes between 0 and 240);

alter table public.studios
  drop constraint if exists studios_default_duration_check;
alter table public.studios
  add constraint studios_default_duration_check
  check (default_appointment_duration_minutes is null
         or default_appointment_duration_minutes between 5 and 480);

-- ---------------------------------------------------------------------------
-- studio_availability_default
-- One row per (studio, day_of_week). day_of_week 0=Sunday ... 6=Saturday.
-- ---------------------------------------------------------------------------

create table if not exists public.studio_availability_default (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid references public.studios(id) on delete cascade not null,
  day_of_week integer not null check (day_of_week between 0 and 6),
  is_open boolean not null default false,
  open_time time,
  close_time time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (studio_id, day_of_week)
);

alter table public.studio_availability_default
  drop constraint if exists studio_availability_default_times_check;
alter table public.studio_availability_default
  add constraint studio_availability_default_times_check
  check (
    (is_open = false)
    or (open_time is not null and close_time is not null and open_time < close_time)
  );

create index if not exists studio_availability_default_studio_idx
  on public.studio_availability_default (studio_id);

-- ---------------------------------------------------------------------------
-- studio_availability_overrides
-- One row per (studio, effective_date). Wins over the weekly default.
-- ---------------------------------------------------------------------------

create table if not exists public.studio_availability_overrides (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid references public.studios(id) on delete cascade not null,
  effective_date date not null,
  is_open boolean not null default false,
  open_time time,
  close_time time,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (studio_id, effective_date)
);

alter table public.studio_availability_overrides
  drop constraint if exists studio_availability_overrides_times_check;
alter table public.studio_availability_overrides
  add constraint studio_availability_overrides_times_check
  check (
    (is_open = false)
    or (open_time is not null and close_time is not null and open_time < close_time)
  );

create index if not exists studio_availability_overrides_studio_date_idx
  on public.studio_availability_overrides (studio_id, effective_date);

-- ---------------------------------------------------------------------------
-- studio_blockouts
-- Date ranges (inclusive) blocking all bookings.
-- ---------------------------------------------------------------------------

create table if not exists public.studio_blockouts (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid references public.studios(id) on delete cascade not null,
  starts_on date not null,
  ends_on date not null,
  reason text,
  created_at timestamptz not null default now()
);

alter table public.studio_blockouts
  drop constraint if exists studio_blockouts_range_check;
alter table public.studio_blockouts
  add constraint studio_blockouts_range_check
  check (ends_on >= starts_on);

create index if not exists studio_blockouts_studio_range_idx
  on public.studio_blockouts (studio_id, starts_on, ends_on);

-- ---------------------------------------------------------------------------
-- services
-- ---------------------------------------------------------------------------

create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid references public.studios(id) on delete cascade not null,
  name text not null,
  description text,
  default_duration_minutes integer not null default 60,
  price_cents integer,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.services
  drop constraint if exists services_duration_check;
alter table public.services
  add constraint services_duration_check
  check (default_duration_minutes between 5 and 480);

alter table public.services
  drop constraint if exists services_price_check;
alter table public.services
  add constraint services_price_check
  check (price_cents is null or price_cents >= 0);

create index if not exists services_studio_active_idx
  on public.services (studio_id, active);

-- ---------------------------------------------------------------------------
-- appointments
-- ---------------------------------------------------------------------------

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid references public.studios(id) on delete cascade not null,
  practitioner_id uuid references public.practitioners(id) on delete set null,
  client_id uuid references public.clients(id) on delete cascade not null,
  service_id uuid references public.services(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  duration_minutes integer not null,
  status text not null default 'confirmed' check (status in ('confirmed','cancelled','completed','no_show')),
  notes text,
  cancellation_reason text,
  cancelled_at timestamptz,
  cancelled_by text check (cancelled_by in ('client','practitioner','owner') or cancelled_by is null),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.appointments
  drop constraint if exists appointments_range_check;
alter table public.appointments
  add constraint appointments_range_check
  check (ends_at > starts_at);

alter table public.appointments
  drop constraint if exists appointments_duration_check;
alter table public.appointments
  add constraint appointments_duration_check
  check (duration_minutes between 5 and 480);

create index if not exists appointments_studio_starts_idx
  on public.appointments (studio_id, starts_at);
create index if not exists appointments_practitioner_starts_idx
  on public.appointments (practitioner_id, starts_at);
create index if not exists appointments_client_starts_idx
  on public.appointments (client_id, starts_at);
create index if not exists appointments_status_starts_idx
  on public.appointments (studio_id, status, starts_at);

-- ---------------------------------------------------------------------------
-- appointment_audit
-- ---------------------------------------------------------------------------

create table if not exists public.appointment_audit (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid references public.appointments(id) on delete cascade not null,
  actor_type text not null check (actor_type in ('practitioner','client','system')),
  actor_id uuid,
  action text not null,
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists appointment_audit_appointment_idx
  on public.appointment_audit (appointment_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS
-- All new tables: studio members read/write. Public booking & cancellation
-- write paths bypass RLS via the service-role client (auth happens via the
-- signed URL slug or token).
-- ---------------------------------------------------------------------------

alter table public.studio_availability_default enable row level security;
alter table public.studio_availability_overrides enable row level security;
alter table public.studio_blockouts enable row level security;
alter table public.services enable row level security;
alter table public.appointments enable row level security;
alter table public.appointment_audit enable row level security;

drop policy if exists "studio_availability_default_member_all" on public.studio_availability_default;
create policy "studio_availability_default_member_all"
  on public.studio_availability_default
  for all
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

drop policy if exists "studio_availability_overrides_member_all" on public.studio_availability_overrides;
create policy "studio_availability_overrides_member_all"
  on public.studio_availability_overrides
  for all
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

drop policy if exists "studio_blockouts_member_all" on public.studio_blockouts;
create policy "studio_blockouts_member_all"
  on public.studio_blockouts
  for all
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

drop policy if exists "services_member_all" on public.services;
create policy "services_member_all"
  on public.services
  for all
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

drop policy if exists "appointments_member_all" on public.appointments;
create policy "appointments_member_all"
  on public.appointments
  for all
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

drop policy if exists "appointment_audit_member_read" on public.appointment_audit;
create policy "appointment_audit_member_read"
  on public.appointment_audit
  for select
  using (
    appointment_id in (
      select id from public.appointments
      where public.is_studio_member(studio_id)
    )
  );

drop policy if exists "appointment_audit_member_insert" on public.appointment_audit;
create policy "appointment_audit_member_insert"
  on public.appointment_audit
  for insert
  with check (
    appointment_id in (
      select id from public.appointments
      where public.is_studio_member(studio_id)
    )
  );
