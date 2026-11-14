-- 0347: a record keeps the client and studio it was created for.
-- TRIGGER ONLY: five BEFORE UPDATE OF triggers attach the existing 0160 lineage guards to four record tables. No table, column, grant, policy,
-- function or data is created, changed or read, and no existing row is validated.
-- NOT APPLIED. Number 0347 claimed by OPS. Hosted apply needs the owner's per-change approval.
--
-- THE RULE. A record keeps the client and studio it was created for. Once the row exists, an UPDATE that changes either one is refused, for every
-- role including service_role, exactly as 0160 does for sessions and entries and 0340 does for intakes. A record filed on the wrong client is
-- corrected by removing it and filing it on the right one, which keeps an attributable trail.
--
-- WHAT THIS CHANGES (guards from 0160: guard_immutable_clinical_lineage, guard_clearable_clinical_lineage)
--   client_personal_notes   client_id, studio_id fixed          client_personal_notes_lineage_fixed
--   treatment_goals         client_id, studio_id fixed          treatment_goals_lineage_fixed
--   client_tags             client_id, studio_id fixed          client_tags_lineage_fixed
--   photos                  client_id, studio_id fixed          photos_lineage_fixed
--   photos                  session_id may be CLEARED, never re-pointed   photos_session_lineage_clearable
-- The photos session link is clearable because its foreign key is ON DELETE SET NULL; a fixed guard would refuse that cascade (the 0160 treatment
-- of electrolysis_entries.block_id). Each guard fires only when a named column is in the UPDATE's SET list and compares old with new, so an upsert
-- that re-writes the same values passes.
--
-- UNCHANGED ON PURPOSE
--   * Every policy, grant and existing row, and the 0035 trigger that derives studio_id from the client on insert.
--   * Composite same-studio foreign keys are a separate change (they stop a mismatched pair at insert; this stops re-pointing after insert).
--   * A future legitimate re-parent (for example a client merge) would need a recorded, owner-authorized procedure that disables the trigger for
--     one transaction; none exists today and none is created here.
-- Rollback: supabase/rollbacks/0347_record_lineage_fixed.down.sql (an operator file, never run by supabase).

begin;
set local lock_timeout = '5s';

drop trigger if exists client_personal_notes_lineage_fixed on public.client_personal_notes;
create trigger client_personal_notes_lineage_fixed
  before update of client_id, studio_id on public.client_personal_notes
  for each row execute function public.guard_immutable_clinical_lineage('client_id', 'studio_id');

drop trigger if exists treatment_goals_lineage_fixed on public.treatment_goals;
create trigger treatment_goals_lineage_fixed
  before update of client_id, studio_id on public.treatment_goals
  for each row execute function public.guard_immutable_clinical_lineage('client_id', 'studio_id');

drop trigger if exists client_tags_lineage_fixed on public.client_tags;
create trigger client_tags_lineage_fixed
  before update of client_id, studio_id on public.client_tags
  for each row execute function public.guard_immutable_clinical_lineage('client_id', 'studio_id');

drop trigger if exists photos_lineage_fixed on public.photos;
create trigger photos_lineage_fixed
  before update of client_id, studio_id on public.photos
  for each row execute function public.guard_immutable_clinical_lineage('client_id', 'studio_id');

drop trigger if exists photos_session_lineage_clearable on public.photos;
create trigger photos_session_lineage_clearable
  before update of session_id on public.photos
  for each row execute function public.guard_clearable_clinical_lineage('session_id');

do $$
declare
  v_expect record;
  v_cols text[];
begin
  for v_expect in
    select * from (values
      ('public.client_personal_notes', 'client_personal_notes_lineage_fixed', 'public.guard_immutable_clinical_lineage', array['client_id', 'studio_id']),
      ('public.treatment_goals',       'treatment_goals_lineage_fixed',       'public.guard_immutable_clinical_lineage', array['client_id', 'studio_id']),
      ('public.client_tags',           'client_tags_lineage_fixed',           'public.guard_immutable_clinical_lineage', array['client_id', 'studio_id']),
      ('public.photos',                'photos_lineage_fixed',                'public.guard_immutable_clinical_lineage', array['client_id', 'studio_id']),
      ('public.photos',                'photos_session_lineage_clearable',    'public.guard_clearable_clinical_lineage', array['session_id'])
    ) as e(tbl, trg, fn, cols)
  loop
    select pg_catalog.array_agg(a.attname::text order by a.attname::text) into v_cols
      from pg_catalog.pg_trigger t
      join pg_catalog.pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])
     where t.tgrelid = v_expect.tbl::regclass and t.tgname = v_expect.trg
       and t.tgenabled = 'O' and not t.tgisinternal
       and t.tgfoid = v_expect.fn::regproc
       and (t.tgtype & 19) = 19   -- ROW (1) + BEFORE (2) + UPDATE (16)
       and t.tgnargs = pg_catalog.cardinality(v_expect.cols);
    if v_cols is distinct from (select pg_catalog.array_agg(c order by c) from pg_catalog.unnest(v_expect.cols) c) then
      raise exception '0347: trigger % on % is missing, disabled, or guards the wrong columns', v_expect.trg, v_expect.tbl;
    end if;
  end loop;
end $$;

commit;
