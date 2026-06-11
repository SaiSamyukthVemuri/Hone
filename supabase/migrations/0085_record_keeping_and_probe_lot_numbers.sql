-- Migration 0085: health-inspection record keeping + probe lot numbers
-- (PR #205, from Chloe's BodySafe / health-inspection sample forms).
--
-- Adds:
--   1. record_keeping_sterile_items      ("Commercially Purchased
--      Prepackaged and Sterile Items Records" form)
--   2. record_keeping_disinfectants      ("Disinfectant Records" form)
--   3. record_keeping_exposure_incidents ("Accidental Blood/Body Fluid
--      Exposure Records" form; SENSITIVE: personal/health info)
--   4. session_blocks.probe_lot_number   (text; the lot/batch number of
--      the probe used on a treatment area, required by the "Client
--      Record for Invasive Procedures" form). The legacy 0001
--      probe_lots table + entries.probe_lot_id remain untouched and
--      dormant; charting captures the lot as plain text per treatment
--      area, which matches how Chloe reads it off the box.
--   5. sessions.aftercare_and_risks_explained_at / _by (explicit,
--      practitioner-marked "explanation of procedure/risks and
--      aftercare information provided" stamp for the client record).
--
-- All additive; nullable everywhere except identity/audit defaults;
-- no backfill; no payment/auth tables; no public grants. RLS uses the
-- project-standard is_studio_member() for-all policy (same shape as
-- client_personal_notes / session_blocks). Re-runnable throughout.
-- The "Client Record for Invasive Procedures" view is generated from
-- existing clients/sessions/session_blocks data; it needs no table.

-- 1. Sterile items -----------------------------------------------------------

create table if not exists public.record_keeping_sterile_items (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null
    references public.studios(id) on delete cascade,
  date_purchased date not null,
  item_description text not null,
  manufacturer_name text not null default '',
  amount_purchased text not null default '',
  lot_number text not null default '',
  expiry_date date,
  notes text,
  created_by_practitioner_id uuid
    references public.practitioners(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists record_keeping_sterile_items_studio_idx
  on public.record_keeping_sterile_items (studio_id, date_purchased desc);

drop trigger if exists record_keeping_sterile_items_set_updated_at
  on public.record_keeping_sterile_items;
create trigger record_keeping_sterile_items_set_updated_at
  before update on public.record_keeping_sterile_items
  for each row execute function public.set_updated_at();

alter table public.record_keeping_sterile_items enable row level security;
drop policy if exists "record_keeping_sterile_items: members all"
  on public.record_keeping_sterile_items;
create policy "record_keeping_sterile_items: members all"
  on public.record_keeping_sterile_items for all to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- 2. Disinfectants ------------------------------------------------------------

create table if not exists public.record_keeping_disinfectants (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null
    references public.studios(id) on delete cascade,
  date_prepared date not null,
  disinfectant_name text not null,
  concentration text not null default '',
  date_discarded date,
  operator_practitioner_id uuid
    references public.practitioners(id) on delete set null,
  operator_name text not null default '',
  notes text,
  created_by_practitioner_id uuid
    references public.practitioners(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists record_keeping_disinfectants_studio_idx
  on public.record_keeping_disinfectants (studio_id, date_prepared desc);

drop trigger if exists record_keeping_disinfectants_set_updated_at
  on public.record_keeping_disinfectants;
create trigger record_keeping_disinfectants_set_updated_at
  before update on public.record_keeping_disinfectants
  for each row execute function public.set_updated_at();

alter table public.record_keeping_disinfectants enable row level security;
drop policy if exists "record_keeping_disinfectants: members all"
  on public.record_keeping_disinfectants;
create policy "record_keeping_disinfectants: members all"
  on public.record_keeping_disinfectants for all to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- 3. Exposure incidents (SENSITIVE) -------------------------------------------

create table if not exists public.record_keeping_exposure_incidents (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null
    references public.studios(id) on delete cascade,
  incident_date date not null,
  exposed_person_full_name text not null,
  exposed_person_address text not null default '',
  exposed_person_phone text not null default '',
  exposure_details text not null default '',
  action_taken text not null default '',
  staff_involved_name text not null default '',
  notes text,
  created_by_practitioner_id uuid
    references public.practitioners(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists record_keeping_exposure_incidents_studio_idx
  on public.record_keeping_exposure_incidents (studio_id, incident_date desc);

drop trigger if exists record_keeping_exposure_incidents_set_updated_at
  on public.record_keeping_exposure_incidents;
create trigger record_keeping_exposure_incidents_set_updated_at
  before update on public.record_keeping_exposure_incidents
  for each row execute function public.set_updated_at();

alter table public.record_keeping_exposure_incidents enable row level security;
drop policy if exists "record_keeping_exposure_incidents: members all"
  on public.record_keeping_exposure_incidents;
create policy "record_keeping_exposure_incidents: members all"
  on public.record_keeping_exposure_incidents for all to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- 4. Probe lot/batch number on treatment areas --------------------------------

alter table public.session_blocks
  add column if not exists probe_lot_number text;

alter table public.session_blocks
  drop constraint if exists session_blocks_probe_lot_number_length_check;
alter table public.session_blocks
  add constraint session_blocks_probe_lot_number_length_check
  check (
    probe_lot_number is null
    or length(probe_lot_number) <= 120
  );

-- 5. Aftercare / risks explained stamp on sessions -----------------------------

alter table public.sessions
  add column if not exists aftercare_and_risks_explained_at timestamptz;

alter table public.sessions
  add column if not exists aftercare_and_risks_explained_by uuid
    references public.practitioners(id) on delete set null;
