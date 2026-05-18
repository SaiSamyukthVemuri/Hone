-- Migration 0020: backfill one "Main" block per existing session and point
-- every existing entry at it.
--
-- Per the Session 16 / 17.5a lesson: paste each step separately. Verify the
-- count query between steps. Do NOT paste both at once.

-- =====================
-- Step 1: paste this first.
-- Creates one block per session (one row per active session) and pulls the
-- first entry's treatment params as the block's defaults. Re-runnable: the
-- `not exists` clause prevents a second block from being created for any
-- session that already has one.
-- =====================

insert into public.session_blocks (
  studio_id, session_id, sort_order, block_name,
  mode, apilus_modality, energy_level, minutes_performed,
  probe_type, machine_frequency,
  created_at, updated_at
)
select
  s.studio_id,
  s.id,
  1,
  'Main',
  (select e.mode from public.electrolysis_entries e
    where e.session_id = s.id
    order by e.created_at asc
    limit 1),
  (select e.apilus_modality from public.electrolysis_entries e
    where e.session_id = s.id
    order by e.created_at asc
    limit 1),
  (select e.energy_level from public.electrolysis_entries e
    where e.session_id = s.id
    order by e.created_at asc
    limit 1),
  (select e.minutes_performed from public.electrolysis_entries e
    where e.session_id = s.id
    order by e.created_at asc
    limit 1),
  (select e.probe_type from public.electrolysis_entries e
    where e.session_id = s.id
    order by e.created_at asc
    limit 1),
  (select e.machine_frequency from public.electrolysis_entries e
    where e.session_id = s.id
    order by e.created_at asc
    limit 1),
  s.created_at,
  s.created_at
from public.sessions s
where s.deleted_at is null
  and not exists (
    select 1 from public.session_blocks sb
    where sb.session_id = s.id
  );

-- Verify Step 1 before running Step 2:
--   select s.id, count(sb.id) as block_count
--     from public.sessions s
--     left join public.session_blocks sb
--       on sb.session_id = s.id and sb.deleted_at is null
--     where s.deleted_at is null
--     group by s.id
--     having count(sb.id) != 1;
-- Expected: zero rows. Each active session has exactly one block.

-- =====================
-- Step 2: paste this after Step 1 commits cleanly and verify above passes.
-- Points every entry at its session's "Main" block. Re-runnable: the WHERE
-- clause only updates rows that don't yet have a block_id.
-- =====================

update public.electrolysis_entries e
set block_id = (
  select sb.id
  from public.session_blocks sb
  where sb.session_id = e.session_id
    and sb.deleted_at is null
  order by sb.sort_order asc
  limit 1
)
where e.block_id is null;

-- Verify Step 2:
--   select count(*) from public.electrolysis_entries where block_id is null;
-- Expected: 0.
