-- ===========================================================================
-- GATE G11: 0244 legacy-type census, T-0244-4 (S0a window read; owner Machines)
-- Source: decision package A1 "G11", A7.1 T-0244-4, R-4(vii).
-- Why: 0244's capture_treatment_reading_change() (#1035 cdf8ae21, 0244:68-89)
-- tracks laser_entries equipment_params.fluence / .pulse_width / .spot_size and
-- raises 23514 "Unsupported routine reading value." when either the OLD or the
-- NEW value of a CHANGED key is non-null and not a JSON string. Typed columns
-- (session_blocks, electrolysis_entries, laser_entries.session_number) cannot
-- violate it; only these three JSON keys can. A correction that leaves a
-- wrong-type key unchanged is not refused, so the count is reported per key.
--
-- RUN ONLY VIA: run-window-read.sh g11-0244-legacy-laser-types.sql
-- One SELECT, counts only. No entry, session, client or studio id is returned.
--
-- EXPECTED PASS: wrong_type_rows = 0 (so every per-key column is 0),
--   at_hosted_0212 = 1. info_* are information only.
-- STOP CONDITION: wrong_type_rows > 0. Those rows' corrections of the affected
--   key are refused after 0244. S1 does not start until a disposition for them
--   is recorded under R-4(vii) (Machines prepares it; Sam accepts it). Never
--   rewrite clinical values to make this pass. chain_guard error: history not
--   at 0212; run G2 and stop.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0212'
                   then 1 else 0 end) as at_hosted_0212
)
select
  g.at_hosted_0212,
  (select count(*) from public.laser_entries
    where jsonb_typeof(equipment_params->'fluence') not in ('string','null')
       or jsonb_typeof(equipment_params->'pulse_width') not in ('string','null')
       or jsonb_typeof(equipment_params->'spot_size') not in ('string','null'))         as wrong_type_rows,
  (select count(*) from public.laser_entries
    where jsonb_typeof(equipment_params->'fluence') not in ('string','null'))           as wrong_type_fluence,
  (select count(*) from public.laser_entries
    where jsonb_typeof(equipment_params->'pulse_width') not in ('string','null'))       as wrong_type_pulse_width,
  (select count(*) from public.laser_entries
    where jsonb_typeof(equipment_params->'spot_size') not in ('string','null'))         as wrong_type_spot_size,
  (select count(*) from public.laser_entries)                                           as info_laser_entries_total,
  (select count(*) from public.laser_entries
    where equipment_params is not null and jsonb_typeof(equipment_params) <> 'object')  as info_equipment_params_not_object
from chain_guard g;
