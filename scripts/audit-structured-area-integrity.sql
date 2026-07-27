-- ---------------------------------------------------------------------------
-- scripts/audit-structured-area-integrity.sql
--
-- Operator-run, READ-ONLY evidence report for the P0 contained by migration
-- 0158: "finalized structured treatment areas are mutable, unsigned and outside
-- the correction lineage" (public.session_block_areas, introduced by 0128).
--
-- It answers three questions, in this order:
--   (a) is the containment actually in place RIGHT NOW (migration, privileges,
--       policies, trigger, functions)?
--   (b) is there any DETECTABLE evidence that a finalized/void record's
--       structured areas diverged from its legacy projection or from its signed
--       snapshot?
--   (c) what could have happened that this report CANNOT see? (check 9 — read it
--       before quoting any zero from checks 6 or 7 as an all-clear.)
--
-- RUN (from the production-linked Mac, repo root):
--   supabase db query --linked -o csv -f scripts/audit-structured-area-integrity.sql
--
-- STRICTLY READ-ONLY (hard rule). This file is a SINGLE `select` statement. It
-- contains NO insert / update / delete / truncate / merge / copy, NO create /
-- alter / drop / grant / revoke / comment, NO set / set_config / reset, NO
-- transaction control, NO advisory or row locks, and it calls only catalog
-- introspection functions plus the `stable` builder public.build_session_snapshot
-- (0119). Nothing it does can change a byte. It is safe to run against
-- production at any time, before or after 0158 is applied.
--
-- NO PHI (hard rule). Every column it emits is a SCALAR (count, boolean, date,
-- hash-comparison verdict) or an OBJECT NAME (table, role, privilege, policy,
-- trigger, function, column) or an opaque internal UUID. Session ids are emitted
-- for every session carrying a snapshot (check 8.50, so each verdict is traceable);
-- block ids only on a check-7 mismatch row, so an incident can be scoped. It NEVER emits a
-- client name, an area value, a laterality value, a note, a snapshot body, a
-- content hash, or any other clinical content. Do not add such a column.
--
-- FAIL-CLOSED. A check that cannot be evaluated (missing object, missing role,
-- no EXECUTE privilege) reports FAIL or "NOT COMPARABLE" — never a silent PASS.
-- Statuses used in the `status` column:
--   PASS       matches the post-0158 target posture
--   FAIL       deviates from it in the unsafe direction, or could not be evaluated
--   REVIEW     not a defect by itself, but a human must look before proceeding
--   INFO       reported for context; not a gate
--   LIMITATION an explicit statement of what this report does NOT prove
-- Before 0158 is applied, the FAILs in checks 1-4 ARE the P0. That is expected.
--
-- ASSUMPTIONS. Migrations 0119 / 0120 / 0128 are applied (they are, in every
-- environment this is meant for), pgcrypto lives in the `extensions` schema (the
-- 0119 convention), and the connection role can EXECUTE
-- public.build_session_snapshot (the linked/owner role can; `authenticated`
-- deliberately cannot — check 8 degrades to NOT COMPARABLE rather than erroring).
--
-- Checks: 1 migration state | 2 privilege matrix | 3 RLS + policies |
-- 4 triggers | 5 containment functions | 6 population counts |
-- 7 legacy-vs-structured projection drift on frozen records |
-- 8 snapshot content_hash re-derivation | 9 audit-evidence limitations.
-- ---------------------------------------------------------------------------

with
-- ===========================================================================
-- Shared building blocks (catalog introspection only).
-- ===========================================================================
tgt as (
  -- NULL when the table is absent; every downstream check then reports FAIL
  -- rather than silently returning nothing.
  select to_regclass('public.session_block_areas') as rel
),

mig as (
  select max(m.version)                                as max_version,
         count(*) filter (where m.version = '0158')    as applied_0158,
         count(*) filter (where m.version = '0128')    as applied_0128,
         count(*) filter (where m.version = '0119')    as applied_0119,
         count(*) filter (where m.version = '0120')    as applied_0120
    from supabase_migrations.schema_migrations m
),

target_roles (rsort, role_name) as (
  values (1, 'public'), (2, 'anon'), (3, 'authenticated'), (4, 'service_role')
),
target_privs (psort, priv) as (
  values (1, 'SELECT'), (2, 'INSERT'), (3, 'UPDATE'), (4, 'DELETE'),
         (5, 'TRUNCATE'), (6, 'REFERENCES'), (7, 'TRIGGER')
),

-- PUBLIC is not a real role, so has_table_privilege() cannot be asked about it;
-- read the grantee-0 entries straight out of the relation ACL instead.
public_acl as (
  select upper(a.privilege_type) as priv
    from pg_catalog.pg_class c
    -- coalesce: a NULL relacl means "default privileges only", i.e. no explicit
    -- grant to PUBLIC — an empty ACL, not an unknown one.
    cross join lateral aclexplode(coalesce(c.relacl, '{}'::aclitem[])) as a
   where c.oid = (select rel from tgt)
     and a.grantee = 0::oid
),

priv_matrix as (
  select r.rsort, p.psort, r.role_name, p.priv,
         case
           when r.role_name = 'public'
             then exists (select 1 from public_acl pa where pa.priv = p.priv)
           when to_regrole(r.role_name) is null then null
           else has_table_privilege(
                  to_regrole(r.role_name)::oid, (select rel from tgt)::oid, p.priv)
         end as holds,
         -- The posture migration 0158 prescribes. NULL = 0158 says nothing about
         -- this cell, so it is reported as INFO rather than gated.
         case
           when r.role_name in ('public', 'anon') then false
           when r.role_name = 'authenticated' then (p.priv = 'SELECT')
           when r.role_name = 'service_role'
                and p.priv in ('SELECT', 'INSERT', 'UPDATE', 'DELETE') then true
           else null
         end as expected
    from target_roles r
   cross join target_privs p
),
priv_summary as (
  select count(*) filter (
           where role_name in ('public', 'anon', 'authenticated')
             and priv <> 'SELECT' and holds) as browser_write_privs,
         count(*) filter (
           where role_name = 'service_role'
             and priv in ('TRUNCATE', 'REFERENCES', 'TRIGGER') and holds)
           as service_role_statement_privs,
         count(*) filter (where holds is null) as unevaluable_cells
    from priv_matrix
),

pol as (
  select p.polname,
         p.polcmd,
         case p.polcmd
           when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE'
           when 'd' then 'DELETE' when '*' then 'ALL'    else p.polcmd::text
         end as cmd,
         case when p.polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end as kind,
         coalesce((
           select string_agg(
                    case when o = 0::oid then 'PUBLIC'
                         else pg_catalog.pg_get_userbyid(o)::text end,
                    '+' order by o)
             from unnest(p.polroles) as o
         ), 'PUBLIC') as role_list
    from pg_catalog.pg_policy p
   where p.polrelid = (select rel from tgt)
),
pol_summary as (
  select count(*)                             as n_policies,
         count(*) filter (where polcmd <> 'r') as n_write_policies
    from pol
),

rls as (
  select count(*)                        as n_rel,
         bool_or(c.relrowsecurity)       as rls_enabled,
         bool_or(c.relforcerowsecurity)  as rls_forced
    from pg_catalog.pg_class c
   where c.oid = (select rel from tgt)
),

trg as (
  select t.tgname,
         t.tgenabled,
         t.tgtype::int as tgtype,
         f.proname,
         f.prosecdef
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_proc f on f.oid = t.tgfoid
   where t.tgrelid = (select rel from tgt)
     and not t.tgisinternal
),
-- tgtype bits: 1=ROW, 2=BEFORE, 4=INSERT, 8=DELETE, 16=UPDATE, 32=TRUNCATE.
guard_trg as (
  select count(*)                                        as n_present,
         count(*) filter (where tgenabled in ('O', 'A')) as n_enabled,
         count(*) filter (
           where (tgtype & 1) <> 0 and (tgtype & 2) <> 0 and (tgtype & 4) <> 0
             and (tgtype & 8) <> 0 and (tgtype & 16) <> 0)  as n_full_coverage,
         count(*) filter (where prosecdef)               as n_security_definer
    from trg
   where tgname = 'session_block_areas_guard_finalized'
),

-- The containment surface, with the ONE body token that carries each function's
-- guarantee (the encounter lock, or the delegation to the lifecycle assertion).
fn_spec (fsort, fn_sig, required_token, token_label) as (
  values
    (1, 'public.assert_session_chartable(uuid,uuid)',
        'for update', 'takes the sessions FOR UPDATE lock'),
    (2, 'public.assert_structured_area_parent_mutable(uuid,boolean)',
        'for update', 'takes the sessions FOR UPDATE lock'),
    (3, 'public.guard_finalized_structured_area_write()',
        'assert_structured_area_parent_mutable', 'delegates to the lifecycle assertion'),
    (4, 'public.create_session_block_with_areas(uuid,uuid,jsonb,jsonb)',
        'assert_session_chartable', 'calls the chartable gate first'),
    (5, 'public.update_session_block_with_areas(uuid,uuid,uuid,jsonb,jsonb,timestamptz)',
        'assert_session_chartable', 'calls the chartable gate first')
),
fn_state as (
  select s.fsort, s.fn_sig, s.required_token, s.token_label,
         p.oid is not null as present,
         p.prosecdef,
         coalesce(array_to_string(p.proconfig, ' '), '(none)') as proconfig,
         case when p.oid is null then null
              else position(s.required_token in lower(pg_catalog.pg_get_functiondef(p.oid))) > 0
         end as has_token
    from fn_spec s
    left join pg_catalog.pg_proc p on p.oid = to_regprocedure(s.fn_sig)::oid
),

-- ===========================================================================
-- Population + lineage (counts only).
-- ===========================================================================
area_totals as (
  select count(*)                             as n_rows,
         count(distinct a.session_block_id)   as n_blocks,
         count(distinct a.studio_id)          as n_studios,
         min(a.created_at)::date              as first_created_on,
         max(a.created_at)::date              as last_created_on
    from public.session_block_areas a
),
area_lineage as (
  select count(*) filter (where b.id is null)                                  as orphan_rows,
         count(*) filter (where b.id is not null and s.id is null)             as rows_with_sessionless_block,
         count(*) filter (where b.id is not null and a.studio_id is distinct from b.studio_id)
                                                                               as studio_derivation_mismatches,
         count(*) filter (where s.id is not null and s.record_status is distinct from 'draft')
                                                                               as rows_on_frozen_records,
         count(distinct s.id) filter (where s.record_status is distinct from 'draft')
                                                                               as frozen_sessions_with_areas,
         count(*) filter (where s.finalized_at is not null and a.created_at > s.finalized_at)
                                                                               as rows_created_after_finalization
    from public.session_block_areas a
    left join public.session_blocks b on b.id = a.session_block_id
    left join public.sessions s       on s.id = b.session_id
),
sess_totals as (
  select count(*)                                                as n_sessions,
         count(*) filter (where record_status = 'draft')          as n_draft,
         count(*) filter (where record_status = 'finalized')      as n_finalized,
         count(*) filter (where record_status = 'void')           as n_void,
         count(*) filter (where record_status <> 'draft')         as n_frozen,
         count(*) filter (where record_status <> 'draft'
                            and current_snapshot_id is null)      as n_frozen_without_snapshot
    from public.sessions
),

-- ===========================================================================
-- Check 7 — divergence between the legacy block projection and the structured
-- rows. Mirrors deriveLegacyProjection() in lib/sessions/block-areas.ts:
--   primary_area := the FIRST structured area in (display_order, created_at, id)
--   side         := the shared laterality, mapped to the 0039 vocabulary, and
--                   ONLY when every structured area shares one laterality;
--                   otherwise side must be NULL.
-- ===========================================================================
block_area_agg as (
  select a.session_block_id,
         count(*)                          as n_areas,
         count(distinct a.laterality)      as n_lateralities,
         min(a.laterality)                 as uniform_laterality,
         (array_agg(nullif(btrim(a.area), '')
                    order by a.display_order, a.created_at, a.id))[1] as first_area
    from public.session_block_areas a
   group by a.session_block_id
),
projection_drift as (
  select s.id                       as session_id,
         b.id                       as block_id,
         s.record_status,
         b.deleted_at is null       as block_live,
         g.n_areas,
         (nullif(btrim(b.primary_area), '') is distinct from g.first_area) as area_drift,
         (b.side is distinct from (
            case when g.n_lateralities = 1 then
              case g.uniform_laterality
                when 'left'           then 'left'
                when 'right'          then 'right'
                when 'bilateral'      then 'bilateral'
                when 'midline'        then 'center'
                when 'not_applicable' then 'n/a'
                else null
              end
            else null end)) as side_drift
    from block_area_agg g
    join public.session_blocks b on b.id = g.session_block_id
    join public.sessions s       on s.id = b.session_id
),
frozen_drift as (
  select count(*) filter (where area_drift)                as n_area_drift,
         count(*) filter (where side_drift)                as n_side_drift,
         count(*) filter (where area_drift or side_drift)  as n_any_drift,
         count(*)                                          as n_blocks_examined
    from projection_drift
   where record_status <> 'draft' and block_live
),
draft_drift as (
  select count(*) filter (where area_drift or side_drift) as n_any_drift,
         count(*)                                         as n_blocks_examined
    from projection_drift
   where record_status = 'draft'
),
frozen_deleted_blocks as (
  select count(*) as n
    from projection_drift
   where record_status <> 'draft' and not block_live
),

-- ===========================================================================
-- Check 8 — re-derive each session's LATEST signed snapshot and compare hashes.
-- Superseded versions are excluded by design: build_session_snapshot() renders
-- CURRENT relational state, so only the newest version can legitimately match.
-- ===========================================================================
snap_latest as (
  select distinct on (cs.session_id)
         cs.id           as snapshot_id,
         cs.session_id,
         cs.version_no,
         cs.version_type,
         cs.content_hash,
         cs.hash_algorithm,
         cs.canonicalization_version
    from public.clinical_record_snapshots cs
   order by cs.session_id, cs.version_no desc
),
snap_verdict as (
  select l.session_id, l.version_no, l.version_type,
         case
           when l.hash_algorithm <> 'sha256' or l.canonicalization_version <> 1
             then 'NOT COMPARABLE (hash algorithm / canonicalization version is not sha256/v1)'
           when to_regprocedure('public.build_session_snapshot(uuid)') is null
             then 'NOT COMPARABLE (public.build_session_snapshot is absent)'
           when not has_function_privilege(
                  to_regprocedure('public.build_session_snapshot(uuid)')::oid, 'EXECUTE')
             then 'NOT COMPARABLE (this role has no EXECUTE on public.build_session_snapshot)'
           when encode(extensions.digest(
                  public.build_session_snapshot(l.session_id)::text, 'sha256'), 'hex')
                = l.content_hash
             then 'MATCH'
           else 'MISMATCH'
         end as verdict
    from snap_latest l
),
snap_totals as (
  select (select count(*) from public.clinical_record_snapshots)                  as n_snapshots,
         (select count(distinct session_id) from public.clinical_record_snapshots) as n_sessions_with_snapshots,
         count(*) filter (where verdict = 'MATCH')                 as n_match,
         count(*) filter (where verdict = 'MISMATCH')              as n_mismatch,
         count(*) filter (where verdict like 'NOT COMPARABLE%')    as n_not_comparable
    from snap_verdict
),

-- ===========================================================================
-- Check 9 — what evidence exists, and what provably does not.
-- ===========================================================================
col_inv as (
  select count(*)                                                    as n_cols,
         string_agg(column_name::text, ' ' order by ordinal_position) as col_list,
         count(*) filter (where column_name = 'updated_at')          as has_updated_at,
         count(*) filter (where column_name = 'deleted_at')          as has_deleted_at,
         count(*) filter (where column_name = 'created_at')          as has_created_at
    from information_schema.columns
   where table_schema = 'public' and table_name = 'session_block_areas'
),
hist_probe as (
  select count(*) as n_candidates
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and c.relname <> 'session_block_areas'
     and (c.relname like '%session_block_area%'
          or c.relname like '%area%history%'
          or c.relname like '%area%audit%')
),
cover_probe as (
  select case when to_regprocedure('public.build_session_snapshot(uuid)') is null then null
              else position('session_block_areas' in pg_catalog.pg_get_functiondef(
                     to_regprocedure('public.build_session_snapshot(uuid)')::oid)) > 0
         end as snapshot_covers_areas,
         case when to_regprocedure('public.correct_finalized_session(uuid,integer,text,jsonb)') is null then null
              else position('session_block_areas' in pg_catalog.pg_get_functiondef(
                     to_regprocedure('public.correct_finalized_session(uuid,integer,text,jsonb)')::oid)) > 0
         end as corrections_cover_areas
),
audit_totals as (
  select (select count(*) from public.clinical_audit_events)      as n_audit_events,
         (select count(*) from public.clinical_record_amendments) as n_amendments
),
flag_state as (
  select count(*)                                                as n_studios,
         count(*) filter (where clinical_finalization_enabled)    as n_finalization_on,
         count(*) filter (where clinical_corrections_enabled)     as n_corrections_on
    from public.studios
)

select r.seq, r.check_id, r.check_name, r.subject, r.status, r.detail
from (

  -- =========================================================================
  -- 1. Migration state.
  -- =========================================================================
  select 1.00::numeric as seq,
         '1'::text as check_id,
         'Migration state'::text as check_name,
         'supabase_migrations.schema_migrations'::text as subject,
         (case when m.applied_0158 > 0 then 'PASS' else 'FAIL' end)::text as status,
         format('max_version=%s, 0158_applied=%s, 0128_applied=%s, 0119_applied=%s, 0120_applied=%s%s',
                coalesce(m.max_version, '(none)'),
                (m.applied_0158 > 0)::text, (m.applied_0128 > 0)::text,
                (m.applied_0119 > 0)::text, (m.applied_0120 > 0)::text,
                case when m.applied_0158 = 0
                     then ' — 0158 is NOT applied: structured-area containment is absent and every FAIL in checks 2-5 below is the P0 itself'
                     else '' end)::text as detail
    from mig m

  -- =========================================================================
  -- 2. Table privilege matrix.
  -- =========================================================================
  union all
  select 2.00::numeric,
         '2',
         'Privilege matrix — summary',
         'public.session_block_areas',
         case when (select rel from tgt) is null then 'FAIL'
              when ps.unevaluable_cells > 0 then 'FAIL'
              when ps.browser_write_privs > 0 then 'FAIL'
              when ps.service_role_statement_privs > 0 then 'FAIL'
              else 'PASS' end,
         format('table_present=%s, browser-role (public/anon/authenticated) write privileges held=%s, service_role statement-level privileges (TRUNCATE/REFERENCES/TRIGGER) held=%s, cells that could not be evaluated=%s',
                ((select rel from tgt) is not null)::text,
                ps.browser_write_privs, ps.service_role_statement_privs,
                ps.unevaluable_cells)
    from priv_summary ps

  union all
  select 2 + (pm.rsort * 10 + pm.psort)::numeric / 1000,
         '2',
         'Privilege matrix — cell',
         format('%s / %s', pm.role_name, pm.priv),
         case
           when pm.holds is null then 'FAIL'
           when pm.expected is null then 'INFO'
           when pm.holds = pm.expected then 'PASS'
           else 'FAIL'
         end,
         format('holds=%s, expected_by_0158=%s',
                coalesce(pm.holds::text, 'UNKNOWN (role or table absent)'),
                coalesce(pm.expected::text, 'not prescribed'))
         || case
              when pm.role_name = 'service_role' and pm.priv = 'TRUNCATE'
                then ' — TRUNCATE is statement-level: it fires no BEFORE ROW trigger and consults no policy, so 0158 REVOKES it from service_role rather than relying on the guard. A true here means one statement can empty a finalized record''s authoritative areas with every signed field byte-identical. The table OWNER retains it; that residual is owner-only and no migration can close it.'
              when pm.role_name = 'authenticated' and pm.priv <> 'SELECT' and pm.holds
                then ' — a studio member browser JWT can perform this operation directly through PostgREST.'
              else '' end
    from priv_matrix pm

  -- =========================================================================
  -- 3. Row-level security and policies.
  -- =========================================================================
  union all
  select 3.00::numeric,
         '3',
         'Row-level security',
         'public.session_block_areas',
         case when coalesce(rls.rls_enabled, false) then 'PASS' else 'FAIL' end,
         format('table_present=%s, rls_enabled=%s, rls_forced=%s',
                (rls.n_rel = 1)::text,
                coalesce(rls.rls_enabled::text, 'UNKNOWN'),
                coalesce(rls.rls_forced::text, 'UNKNOWN'))
    from rls

  union all
  select 3.05::numeric,
         '3',
         'Policies — summary',
         'public.session_block_areas',
         case when p.n_write_policies = 0 then 'PASS' else 'FAIL' end,
         format('policies=%s, policies permitting INSERT/UPDATE/DELETE/ALL=%s (0158 target: 1 SELECT-only policy, 0 write policies)',
                p.n_policies, p.n_write_policies)
    from pol_summary p

  union all
  select 3.10 + (row_number() over (order by pol.polname))::numeric / 1000,
         '3',
         'Policies — policy',
         pol.polname,
         case when pol.polcmd = 'r' then 'PASS' else 'FAIL' end,
         format('command=%s, kind=%s, roles=%s', pol.cmd, pol.kind, pol.role_list)
    from pol

  -- =========================================================================
  -- 4. Triggers.
  -- =========================================================================
  union all
  select 4.00::numeric,
         '4',
         'Finalized-parent guard trigger',
         'session_block_areas_guard_finalized',
         case when g.n_present = 1 and g.n_enabled = 1
                   and g.n_full_coverage = 1 and g.n_security_definer = 1
              then 'PASS' else 'FAIL' end,
         format('present=%s, enabled=%s, covers BEFORE ROW INSERT+UPDATE+DELETE=%s, function is SECURITY DEFINER=%s',
                (g.n_present = 1)::text, (g.n_enabled = 1)::text,
                (g.n_full_coverage = 1)::text, (g.n_security_definer = 1)::text)
    from guard_trg g

  union all
  select 4.10 + (row_number() over (order by t.tgname))::numeric / 1000,
         '4',
         'Triggers — non-internal trigger',
         t.tgname,
         case when t.tgenabled in ('O', 'A') then 'INFO' else 'FAIL' end,
         format('%s, enabled_state=%s, function=%s, security_definer=%s',
                concat_ws(' ',
                  case when (t.tgtype & 2) <> 0 then 'BEFORE'
                       when (t.tgtype & 64) <> 0 then 'INSTEAD OF'
                       else 'AFTER' end,
                  case when (t.tgtype & 1) <> 0 then 'ROW' else 'STATEMENT' end,
                  nullif(concat_ws('/',
                    case when (t.tgtype & 4)  <> 0 then 'INSERT' end,
                    case when (t.tgtype & 8)  <> 0 then 'DELETE' end,
                    case when (t.tgtype & 16) <> 0 then 'UPDATE' end,
                    case when (t.tgtype & 32) <> 0 then 'TRUNCATE' end), '')),
                t.tgenabled, t.proname, t.prosecdef::text)
    from trg t

  -- =========================================================================
  -- 5. Containment functions.
  -- =========================================================================
  union all
  select 5 + f.fsort::numeric / 100,
         '5',
         'Containment functions',
         f.fn_sig,
         case when f.present and coalesce(f.prosecdef, false) and coalesce(f.has_token, false)
              then 'PASS' else 'FAIL' end,
         format('present=%s, security_definer=%s, %s=%s, search_path=%s',
                f.present::text,
                coalesce(f.prosecdef::text, 'n/a'),
                f.token_label,
                coalesce(f.has_token::text, 'n/a'),
                f.proconfig)
    from fn_state f

  -- =========================================================================
  -- 6. Population counts.
  -- =========================================================================
  union all
  select 6.01::numeric,
         '6',
         'Structured-area population',
         'public.session_block_areas',
         'INFO',
         format('rows=%s, distinct blocks=%s, distinct studios=%s, created between %s and %s',
                a.n_rows, a.n_blocks, a.n_studios,
                coalesce(a.first_created_on::text, 'n/a'),
                coalesce(a.last_created_on::text, 'n/a'))
    from area_totals a

  union all
  select 6.02::numeric,
         '6',
         'Structured-area lineage integrity',
         'session_block_areas -> session_blocks -> sessions',
         case when l.orphan_rows = 0 and l.rows_with_sessionless_block = 0
                   and l.studio_derivation_mismatches = 0
              then 'PASS' else 'FAIL' end,
         format('orphan rows (no parent block)=%s, blocks with no parent session=%s, studio_id not equal to parent block studio_id=%s',
                l.orphan_rows, l.rows_with_sessionless_block, l.studio_derivation_mismatches)
    from area_lineage l

  union all
  select 6.03::numeric,
         '6',
         'Session lifecycle census',
         'public.sessions',
         'INFO',
         format('sessions=%s, draft=%s, finalized=%s, void=%s, finalized-or-void=%s',
                s.n_sessions, s.n_draft, s.n_finalized, s.n_void, s.n_frozen)
    from sess_totals s

  union all
  select 6.04::numeric,
         '6',
         'Frozen records carrying structured areas',
         'finalized/void sessions with session_block_areas rows',
         case when l.frozen_sessions_with_areas = 0 then 'PASS' else 'REVIEW' end,
         format('finalized-or-void sessions with structured-area rows=%s, structured-area rows on those records=%s — these are the records whose AUTHORITATIVE areas are not covered by the signed snapshot (see checks 8 and 9)',
                l.frozen_sessions_with_areas, l.rows_on_frozen_records)
    from area_lineage l

  union all
  select 6.05::numeric,
         '6',
         'Structured areas created after finalization',
         'session_block_areas.created_at > sessions.finalized_at',
         case when l.rows_created_after_finalization = 0 then 'PASS' else 'FAIL' end,
         format('rows=%s — a non-zero value is a confirmed post-finalization INSERT. Zero proves nothing about UPDATE or DELETE (see check 9).',
                l.rows_created_after_finalization)
    from area_lineage l

  -- =========================================================================
  -- 7. Legacy-projection vs structured-row drift on frozen records.
  -- =========================================================================
  union all
  select 7.01::numeric,
         '7',
         'Projection drift — frozen records, primary_area',
         'session_blocks.primary_area vs first structured area',
         case when d.n_area_drift = 0 then 'PASS' else 'FAIL' end,
         format('live blocks examined on finalized/void sessions=%s, primary_area disagrees with the first structured area (display_order, created_at, id)=%s',
                d.n_blocks_examined, d.n_area_drift)
    from frozen_drift d

  union all
  select 7.02::numeric,
         '7',
         'Projection drift — frozen records, side',
         'session_blocks.side vs structured laterality set',
         case when d.n_side_drift = 0 then 'PASS' else 'FAIL' end,
         format('live blocks examined on finalized/void sessions=%s, side disagrees=%s (rule: side is set only when every structured area shares one laterality — left/right/bilateral/midline->center/not_applicable->n/a — and is NULL for mixed laterality)',
                d.n_blocks_examined, d.n_side_drift)
    from frozen_drift d

  union all
  select 7.03::numeric,
         '7',
         'Projection drift — frozen records, combined',
         'blocks with any drift on finalized/void sessions',
         case when d.n_any_drift = 0 then 'PASS' else 'FAIL' end,
         format('blocks with primary_area and/or side drift=%s', d.n_any_drift)
    from frozen_drift d

  union all
  select 7.04::numeric,
         '7',
         'Projection drift — draft records (context only)',
         'blocks with any drift on draft sessions',
         'INFO',
         format('draft blocks examined=%s, with drift=%s — drift in a DRAFT is ordinary editing, not an integrity breach; reported only to calibrate the frozen-record numbers above',
                d.n_blocks_examined, d.n_any_drift)
    from draft_drift d

  union all
  select 7.05::numeric,
         '7',
         'Projection drift — excluded soft-deleted blocks',
         'soft-deleted blocks on finalized/void sessions with structured areas',
         case when f.n = 0 then 'PASS' else 'REVIEW' end,
         format('blocks=%s — excluded from checks 7.01-7.03 because the signed snapshot also excludes soft-deleted blocks; a non-zero value needs a human look',
                f.n)
    from frozen_deleted_blocks f

  union all
  select 7.50 + (row_number() over (order by pd.session_id, pd.block_id))::numeric / 1000,
         '7',
         'Projection drift — mismatching block',
         format('session=%s block=%s', pd.session_id, pd.block_id),
         'FAIL',
         format('record_status=%s, structured areas on block=%s, primary_area drift=%s, side drift=%s — capture this row as evidence; do NOT repair it (see INCIDENT PROTOCOL at the end of this file)',
                pd.record_status, pd.n_areas, pd.area_drift::text, pd.side_drift::text)
    from projection_drift pd
   where pd.record_status <> 'draft' and pd.block_live
     and (pd.area_drift or pd.side_drift)

  -- =========================================================================
  -- 8. Snapshot content_hash re-derivation (tamper evidence).
  -- =========================================================================
  union all
  select 8.01::numeric,
         '8',
         'Snapshot inventory',
         'public.clinical_record_snapshots',
         'INFO',
         format('snapshots=%s, sessions with a snapshot=%s, superseded versions not re-derivable by design=%s',
                t.n_snapshots, t.n_sessions_with_snapshots,
                t.n_snapshots - t.n_sessions_with_snapshots)
    from snap_totals t

  union all
  select 8.02::numeric,
         '8',
         'Finalized records missing a snapshot',
         'sessions.current_snapshot_id is null on a frozen record',
         case when s.n_frozen_without_snapshot = 0 then 'PASS' else 'FAIL' end,
         format('finalized-or-void sessions with no current_snapshot_id=%s', s.n_frozen_without_snapshot)
    from sess_totals s

  union all
  select 8.03::numeric,
         '8',
         'Snapshot content_hash re-derivation',
         'encode(digest(build_session_snapshot(session_id)::text, sha256), hex)',
         case when t.n_mismatch = 0 and t.n_not_comparable = 0 then 'PASS' else 'FAIL' end,
         format('latest snapshot per session: MATCH=%s, MISMATCH=%s, NOT COMPARABLE=%s — a MATCH proves the LEGACY block projection, entries and photo metadata are byte-identical to what was signed; it says NOTHING about structured areas, which the snapshot does not serialize (check 9)',
                t.n_match, t.n_mismatch, t.n_not_comparable)
    from snap_totals t

  union all
  select 8.50 + (row_number() over (order by v.session_id))::numeric / 1000,
         '8',
         'Snapshot re-derivation — per session',
         format('session=%s', v.session_id),
         case when v.verdict = 'MATCH' then 'PASS' else 'FAIL' end,
         format('latest version_no=%s, version_type=%s, verdict=%s',
                v.version_no, v.version_type, v.verdict)
    from snap_verdict v

  -- =========================================================================
  -- 9. What this report CANNOT prove. Read before quoting any zero above.
  -- =========================================================================
  union all
  select 9.01::numeric,
         '9',
         'LIMITATION — no mutation timestamps on session_block_areas',
         'public.session_block_areas columns',
         'LIMITATION',
         format('columns (%s)=%s | updated_at present=%s, deleted_at present=%s, created_at present=%s. The table records only CREATION time. Checks 6.05 and 7 therefore detect post-finalization INSERTs and surviving divergence ONLY. A zero there does NOT prove that no UPDATE and no DELETE ever occurred — absence of evidence is not evidence of absence.',
                c.n_cols, coalesce(c.col_list, '(table absent)'),
                (c.has_updated_at > 0)::text, (c.has_deleted_at > 0)::text,
                (c.has_created_at > 0)::text)
    from col_inv c

  union all
  select 9.02::numeric,
         '9',
         'LIMITATION — no history or audit table for structured areas',
         'public schema relations resembling a structured-area history',
         'LIMITATION',
         format('candidate history/audit relations found=%s. There is no shadow table, no row-versioning trigger and no soft-delete column, so a deleted structured-area row leaves NO trace of any kind in the database.',
                h.n_candidates)
    from hist_probe h

  union all
  select 9.03::numeric,
         '9',
         'LIMITATION — structured areas are outside the signed snapshot',
         'public.build_session_snapshot(uuid)',
         'LIMITATION',
         format('build_session_snapshot references session_block_areas=%s; correct_finalized_session references session_block_areas=%s. The signed content_hash covers only the LEGACY primary_area/side/custom_area_detail projection, so a structured-area change does not alter the hash and check 8 cannot detect it. There is also no correction applier for structured areas, so such a change can be neither versioned nor restored.',
                coalesce(cp.snapshot_covers_areas::text, 'UNKNOWN (function absent)'),
                coalesce(cp.corrections_cover_areas::text, 'UNKNOWN (function absent)'))
    from cover_probe cp

  union all
  select 9.04::numeric,
         '9',
         'LIMITATION — check 7 only sees DIVERGENCE, not change',
         'legacy projection vs structured rows',
         'LIMITATION',
         'Check 7 compares the two representations against each other. A rewrite that updated BOTH consistently (which is exactly what the charting RPCs do) produces NO drift and is therefore invisible to this report. Check 7 detects a partial or one-sided edit, not editing as such.'

  union all
  select 9.05::numeric,
         '9',
         'LIMITATION — TRUNCATE leaves no trace',
         'public.session_block_areas',
         'LIMITATION',
         'TRUNCATE is not row-level, is not intercepted by the BEFORE ROW guard trigger, and is not restricted by RLS. Before migration 0158 the role `authenticated` held TRUNCATE on this table (verified in production), so a browser JWT could have emptied it leaving no row, no timestamp and no audit entry. Check 6 cannot distinguish "never populated" from "truncated".'

  union all
  select 9.06::numeric,
         '9',
         'Audit evidence that DOES exist',
         'clinical_audit_events + clinical_record_amendments',
         'INFO',
         format('clinical_audit_events rows=%s, clinical_record_amendments rows=%s. Neither ledger has an event type for structured areas, so these counts are context, not coverage: they would be zero whether or not an area was changed.',
                a.n_audit_events, a.n_amendments)
    from audit_totals a

  union all
  select 9.07::numeric,
         '9',
         'Exposure context — clinical feature flags',
         'public.studios',
         'INFO',
         format('studios=%s, clinical_finalization_enabled=%s, clinical_corrections_enabled=%s. Flags govern EXPOSURE, not the defect: the missing guard, the browser write privileges and the unsigned areas exist regardless of flag state. Finalization must not be enabled for any studio until structured areas are inside the signed snapshot and have a correction applier.',
                f.n_studios, f.n_finalization_on, f.n_corrections_on)
    from flag_state f

) r
order by r.seq, r.subject;

-- ---------------------------------------------------------------------------
-- INCIDENT PROTOCOL — read this BEFORE touching anything.
--
-- If check 7 (projection drift on a finalized/void record) or check 8 (snapshot
-- content_hash re-derivation) returns a non-zero mismatch, a signed clinical
-- record and its current relational state disagree. Treat that as a clinical
-- record-integrity incident, not as a bug to tidy up.
--
--   1. Do NOT repair, backfill, re-align, re-finalize, regenerate a snapshot,
--      delete, or otherwise touch the affected row, block, session or snapshot.
--      Any "fix" destroys the only evidence of what happened and makes the
--      divergence unprovable afterwards. The record stays exactly as it is.
--   2. CAPTURE the evidence immediately and immutably: save this script's full
--      CSV output (it already carries the affected session and block ids, the
--      migration state, the privilege matrix, the policy/trigger/function state
--      and the per-session hash verdicts), note the exact UTC run time, the
--      project ref, and the connection role. Re-run the script unchanged and
--      keep the second output too — a verdict that changes between two runs is
--      itself a finding.
--   3. FREEZE the surface. If migration 0158 is not yet applied, applying it is
--      the containment step and needs its own explicit authorization; it changes
--      no data. Do not enable clinical_finalization_enabled or
--      clinical_corrections_enabled for any studio while a mismatch is open.
--   4. RAISE a separate incident with its own explicit authorization, owned by
--      the person accountable for the clinical record. Determining what changed,
--      whether the affected client's care was affected, whether a regulatory
--      notification is owed, and what (if anything) may be written to the record
--      are decisions for that incident — never for whoever happened to run this
--      audit. Remediation of a signed record requires a narrow, attributable,
--      separately reviewed RPC, not an ad-hoc UPDATE.
--   5. Remember what a PASS is worth. Check 9 states the limits precisely: with
--      no updated_at, no deleted_at and no history table, an all-PASS run means
--      "no divergence is visible today", not "nothing was ever changed".
-- ---------------------------------------------------------------------------
