-- ===========================================================================
-- GATE G11 (class split): 0244 legacy-type census by class and key, T-0244-4
-- (S0a window read; owner Machines). Companion to g11-0244-legacy-laser-types.sql,
-- which stays the package's G11 count unchanged.
-- Source: photos/G11-DISPOSITION-DESIGN.md section 4 (classes H1, H2, X1, X2, N),
-- with the predicates re-verified at #1035 cdf8ae21 (see the END record
-- machines/G11-CLASS-SPLIT-END.json for where this differs from Photos):
--   - 0244:68-89 capture_treatment_reading_change() raises 23514 when the OLD or
--     NEW value of a CHANGED equipment_params.{fluence,pulse_width,spot_size}
--     leaf is non-null and not a JSON string; leaves are read with #>, so a
--     non-object blob yields "absent" and refuses nothing.
--   - 0119:406-408 + 0159:428-446 guard_finalized_clinical_write (BEFORE
--     INSERT/UPDATE/DELETE on laser_entries) refuses any write, every role, when
--     the parent session's record_status is 'finalized' or 'void'.
--     sessions.record_status is NOT NULL default 'draft' (0119:49, check 0119:69-70).
--   - laser_entries.deleted_at (0114) and sessions.deleted_at (0013) are soft deletes.
--   - 0164:103-152 create_laser_entry never checks leaf types, so the population
--     can grow on draft sessions after this read (snapshot, not a closed set).
--
-- CLASSES (each non-conforming leaf is in exactly one; precedence top-down):
--   N   equipment_params not null and not a JSON object (row-level property; the
--       per-key rows repeat it for each key). 0244 refuses nothing for it.
--   X1  non-conforming leaf on a finalized/void session: read-only for everyone
--       under 0159, before and after 0244.
--   X2  non-conforming leaf, session draft, entry OR its session soft-deleted.
--   H1  non-conforming leaf, active draft row, JSON number (losslessly renderable
--       as the stored text).
--   H2  non-conforming leaf, active draft row, JSON boolean, object or array
--       (no lossless string form; owner instruction needed).
--   The six JSON types are a closed set, so per key X1+X2+H1+H2 is every
--   non-conforming leaf on an object blob.
--
-- OUTPUT: counts only, no ids or values. Rows 1-3: one per key (leaf_key).
--   Row 4 (leaf_key 'ALL_ROWS'): distinct entries by row class, where a row takes
--   its highest class (N > X1 > X2 > H2 > H1), so the row columns partition the
--   rows; plus package_g11_rows (the g11 count, recomputed here) and reconciles.
--
-- RUN ONLY VIA: run-window-read.sh g11b-0244-legacy-laser-classes.sql
-- One SELECT. No writes, no side-effecting function.
--
-- EXPECTED PASS: reconciles = true and, as for the package gate, every class
--   count = 0 (then g11's wrong_type_rows = 0 too). at_hosted_0212 = 1.
-- STOP CONDITION (independent of the G11 pass redefinition):
--   - the file errors, or chain_guard raises (history not at 0212): a missing
--     census is not a zero;
--   - reconciles = false: a shape this split does not classify; stop and
--     extend the census.
--   With reconciles = true and a class count > 0, the PACKAGE rule (A5 S0: G11
--   fails, so S1 stops) applies unless OPS/Sam adopt Photos' section 3 class
--   dispositions and Sam records the H1/H2 counts as an R-4 residual. That
--   choice is OPS/Sam's, not this file's.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0212'
                   then 1 else 0 end) as at_hosted_0212
),
e as (
  select l.id,
         jsonb_typeof(l.equipment_params)                        as blob_type,
         l.equipment_params                                       as params,
         s.record_status in ('finalized', 'void')                 as session_locked,
         (l.deleted_at is not null or s.deleted_at is not null)   as soft_deleted,
         (l.deleted_at is null and s.deleted_at is not null)      as session_only_deleted
  from public.laser_entries l
  join public.sessions s on s.id = l.session_id
  where l.equipment_params is not null
),
leaves as (
  select e.id, e.blob_type, e.session_locked, e.soft_deleted, e.session_only_deleted, k.leaf_key,
         case when e.blob_type = 'object' then jsonb_typeof(e.params -> k.leaf_key) end as leaf_type
  from e cross join (values ('fluence'), ('pulse_width'), ('spot_size')) as k(leaf_key)
),
cls as (
  select v.*,
         case
           when v.blob_type <> 'object'                            then 'N'
           when v.leaf_type is null or v.leaf_type in ('string', 'null') then 'OK'
           when v.session_locked                                   then 'X1'
           when v.soft_deleted                                     then 'X2'
           when v.leaf_type = 'number'                             then 'H1'
           else 'H2'
         end as leaf_class
  from leaves v
),
row_cls as (
  select c.id,
         case
           when bool_or(c.leaf_class = 'N')  then 'N'
           when bool_or(c.leaf_class = 'X1') then 'X1'
           when bool_or(c.leaf_class = 'X2') then 'X2'
           when bool_or(c.leaf_class = 'H2') then 'H2'
           when bool_or(c.leaf_class = 'H1') then 'H1'
           else 'OK'
         end as row_class,
         bool_or(c.leaf_class = 'X2' and c.session_only_deleted) as x2_session_only
  from cls c
  group by c.id
),
package_g11 as (
  select count(*) as n from public.laser_entries
   where jsonb_typeof(equipment_params->'fluence') not in ('string','null')
      or jsonb_typeof(equipment_params->'pulse_width') not in ('string','null')
      or jsonb_typeof(equipment_params->'spot_size') not in ('string','null')
),
per_key as (
  select k.leaf_key,
    count(*) filter (where c.leaf_class = 'N')                                   as class_n_non_object_blob,
    count(*) filter (where c.leaf_class = 'X1')                                  as class_x1_finalized_or_void,
    count(*) filter (where c.leaf_class = 'X2')                                  as class_x2_soft_deleted,
    count(*) filter (where c.leaf_class = 'X2' and c.session_only_deleted)       as info_x2_session_deleted_only,
    count(*) filter (where c.leaf_class = 'H1')                                  as class_h1_number,
    count(*) filter (where c.leaf_class = 'H2')                                  as class_h2_total,
    count(*) filter (where c.leaf_class = 'H2' and c.leaf_type = 'boolean')      as class_h2_boolean,
    count(*) filter (where c.leaf_class = 'H2' and c.leaf_type = 'object')       as class_h2_object,
    count(*) filter (where c.leaf_class = 'H2' and c.leaf_type = 'array')        as class_h2_array,
    count(*) filter (where c.leaf_class in ('X1', 'X2', 'H1', 'H2'))             as nonconforming_total
  -- Driven by the key list, so all three keys print even with no laser rows.
  from (values ('fluence'), ('pulse_width'), ('spot_size')) as k(leaf_key)
  left join cls c on c.leaf_key = k.leaf_key
  group by k.leaf_key
),
all_rows as (
  select 'ALL_ROWS'::text as leaf_key,
    count(*) filter (where r.row_class = 'N')                                    as class_n_non_object_blob,
    count(*) filter (where r.row_class = 'X1')                                   as class_x1_finalized_or_void,
    count(*) filter (where r.row_class = 'X2')                                   as class_x2_soft_deleted,
    count(*) filter (where r.row_class = 'X2' and r.x2_session_only)             as info_x2_session_deleted_only,
    count(*) filter (where r.row_class = 'H1')                                   as class_h1_number,
    count(*) filter (where r.row_class = 'H2')                                   as class_h2_total,
    null::bigint                                                                 as class_h2_boolean,
    null::bigint                                                                 as class_h2_object,
    null::bigint                                                                 as class_h2_array,
    count(*) filter (where r.row_class in ('X1', 'X2', 'H1', 'H2'))              as nonconforming_total
  from row_cls r
)
select
  g.at_hosted_0212,
  t.*,
  case when t.leaf_key = 'ALL_ROWS' then (select n from package_g11) end         as package_g11_rows,
  case when t.leaf_key = 'ALL_ROWS'
       then t.nonconforming_total = (select n from package_g11) end              as reconciles
from chain_guard g
cross join (select * from per_key union all select * from all_rows) t
order by (t.leaf_key = 'ALL_ROWS'), t.leaf_key;
