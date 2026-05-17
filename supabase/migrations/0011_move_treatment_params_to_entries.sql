-- Migration 0011: Move treatment parameters from session level to entry level.
-- Per-practitioner feedback: modality/intensity/duration/EL/etc actually change
-- per hair area within a single session, not per session.
-- Pre-launch state: any existing session-level values are discarded, not migrated.
--
-- Existing electrolysis_entries already had mode, intensity, duration_seconds,
-- and pulse_count. We reuse those. The five columns added here are net-new on
-- the entries table. The session-level versions are then dropped.
--
-- Safe to re-run: every alter table add constraint is preceded by drop
-- constraint if exists; every add/drop column uses if not exists / if exists.

-- ---------------------------------------------------------------------------
-- Add five new columns to electrolysis_entries.
-- ---------------------------------------------------------------------------

alter table public.electrolysis_entries
  add column if not exists apilus_modality text,
  add column if not exists energy_level integer,
  add column if not exists minutes_performed integer,
  add column if not exists probe_type text,
  add column if not exists machine_frequency text;

-- ---------------------------------------------------------------------------
-- CHECK constraints on the new entry-level columns.
-- ---------------------------------------------------------------------------

alter table public.electrolysis_entries
  drop constraint if exists entries_apilus_modality_check;
alter table public.electrolysis_entries
  add constraint entries_apilus_modality_check
  check (
    apilus_modality is null
    or apilus_modality in (
      'Multiplex','Microflash','Picoflash','Synchro','Thermoflash','Meloflash',
      'Evolublend','Omniblend','Picoblend','Synchroblend','Multiblend'
    )
  );

alter table public.electrolysis_entries
  drop constraint if exists entries_probe_type_check;
alter table public.electrolysis_entries
  add constraint entries_probe_type_check
  check (
    probe_type is null
    or probe_type in ('Regular','IBL','ITH')
  );

alter table public.electrolysis_entries
  drop constraint if exists entries_machine_frequency_check;
alter table public.electrolysis_entries
  add constraint entries_machine_frequency_check
  check (
    machine_frequency is null
    or machine_frequency in ('13.5 MHz','27.12 MHz')
  );

-- ---------------------------------------------------------------------------
-- Drop the session-level constraints and columns moved in 0009.
-- Constraints first so the column drops aren't blocked.
-- ---------------------------------------------------------------------------

alter table public.sessions
  drop constraint if exists sessions_electrolysis_mode_check;
alter table public.sessions
  drop constraint if exists sessions_apilus_modality_check;
alter table public.sessions
  drop constraint if exists sessions_probe_type_check;
alter table public.sessions
  drop constraint if exists sessions_machine_frequency_check;
alter table public.sessions
  drop constraint if exists sessions_intensity_pct_range_check;

alter table public.sessions
  drop column if exists electrolysis_mode,
  drop column if exists apilus_modality,
  drop column if exists intensity_pct,
  drop column if exists duration_seconds,
  drop column if exists pulses,
  drop column if exists minutes_performed,
  drop column if exists energy_level,
  drop column if exists probe_type,
  drop column if exists machine_frequency;
