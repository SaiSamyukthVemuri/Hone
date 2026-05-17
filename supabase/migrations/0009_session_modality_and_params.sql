-- Migration 0009: Add Apilus modality parameters, probe type,
-- machine frequency, and minutes-performed to sessions.
--
-- NOTE on naming: sessions.modality already exists since migration 0001
-- with values 'electrolysis' | 'laser'. The new Apilus sub-modality
-- (Multiplex, Microflash, ...) lives in a separate column named
-- apilus_modality so the existing column and its check constraint stay
-- intact. electrolysis_mode persists the session-level mode selection
-- (thermo / blend / galv) that drives which apilus_modality options apply.
-- All new fields are nullable; existing sessions remain valid.

alter table public.sessions
  add column if not exists electrolysis_mode text,
  add column if not exists apilus_modality text,
  add column if not exists intensity_pct numeric(5,2),
  add column if not exists duration_seconds numeric(7,3),
  add column if not exists pulses integer,
  add column if not exists minutes_performed integer,
  add column if not exists energy_level integer,
  add column if not exists probe_type text,
  add column if not exists machine_frequency text;

-- Drop-and-recreate the check constraints so this migration is idempotent.
-- Postgres has no "add constraint if not exists" yet.

alter table public.sessions
  drop constraint if exists sessions_electrolysis_mode_check;
alter table public.sessions
  add constraint sessions_electrolysis_mode_check
  check (
    electrolysis_mode is null
    or electrolysis_mode in ('thermo','blend','galv')
  );

alter table public.sessions
  drop constraint if exists sessions_apilus_modality_check;
alter table public.sessions
  add constraint sessions_apilus_modality_check
  check (
    apilus_modality is null
    or apilus_modality in (
      'Multiplex','Microflash','Picoflash','Synchro','Thermoflash','Meloflash',
      'Evolublend','Omniblend','Picoblend','Synchroblend','Multiblend'
    )
  );

alter table public.sessions
  drop constraint if exists sessions_probe_type_check;
alter table public.sessions
  add constraint sessions_probe_type_check
  check (
    probe_type is null
    or probe_type in ('Regular','IBL','ITH')
  );

alter table public.sessions
  drop constraint if exists sessions_machine_frequency_check;
alter table public.sessions
  add constraint sessions_machine_frequency_check
  check (
    machine_frequency is null
    or machine_frequency in ('13.5 MHz','27.12 MHz')
  );

alter table public.sessions
  drop constraint if exists sessions_intensity_pct_range_check;
alter table public.sessions
  add constraint sessions_intensity_pct_range_check
  check (intensity_pct is null or (intensity_pct >= 0 and intensity_pct <= 100));
