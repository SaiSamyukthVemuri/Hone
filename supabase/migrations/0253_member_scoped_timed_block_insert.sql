-- 0253 — HON-48 F1: a non-owner may block only THEIR OWN schedule.
--
-- Decision (Sam, 2026-10-25, SAM-DECISIONS item 14): practitioners create blocks
-- only on their own schedule; owners may block any practitioner or the whole
-- studio. Enforced here, in the database, not in the calendar UI.
--
-- 0137 Step 3 left the member INSERT policy as
--   is_studio_member(studio_id) and practitioner_id is null
-- so (a) a non-owner could never write a self-scoped block, and (b) a non-owner
-- could still close the WHOLE studio when per-practitioner capacity is ON.
-- This replaces the policy body with one decision function:
--
--   capacity OFF  a member may insert a studio-wide row (there is no per-
--                 practitioner schedule to scope to; unchanged from today);
--   capacity ON   a member may insert ONLY a row scoped to their OWN active
--                 practitioner row in that same studio. A studio-wide row, or a
--                 colleague's id, is refused by RLS (42501).
--
-- Unchanged on purpose: UPDATE and DELETE stay owner-only (0030 owner_all,
-- 0138 owner_scoped_write); the owner policies already allow scoped and
-- studio-wide rows; guard_scoped_source_capacity (0137/0138) still takes the
-- per-studio capacity lock and refuses a scoped row when capacity is OFF
-- (42501) or the target is inactive (23514); the composite (studio_id,
-- practitioner_id) FK still refuses a cross-studio id (23503).
--
-- Why a function: studio_capacity_enabled(uuid) has EXECUTE revoked from every
-- runtime role (0134), and own_practitioner_in_studio(uuid) likewise (0178), so a
-- policy evaluated as `authenticated` cannot call them. The decision function is
-- SECURITY DEFINER with a pinned search_path and qualified references, and is the
-- only new EXECUTE grant: `authenticated`, because a policy needs it.

begin;
set local lock_timeout = '5s';

create or replace function public.member_may_insert_timed_block(
  p_studio_id uuid,
  p_practitioner_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    case
      when p_studio_id is null then false
      when p_practitioner_id is null then
        public.is_studio_member(p_studio_id)
        and not public.studio_capacity_enabled(p_studio_id)
      else
        public.studio_capacity_enabled(p_studio_id)
        and exists (
          select 1
            from public.practitioners p
           where p.id = p_practitioner_id
             and p.studio_id = p_studio_id
             and p.user_id = auth.uid()
             and p.active = true
        )
    end,
    false
  );
$$;

-- Supabase's default privileges grant EXECUTE to PUBLIC, anon, authenticated AND
-- service_role at create time: revoke all four by name, then grant back only what
-- the policy needs.
revoke execute on function public.member_may_insert_timed_block(uuid, uuid) from public;
revoke execute on function public.member_may_insert_timed_block(uuid, uuid) from anon;
revoke execute on function public.member_may_insert_timed_block(uuid, uuid) from authenticated;
revoke execute on function public.member_may_insert_timed_block(uuid, uuid) from service_role;
grant execute on function public.member_may_insert_timed_block(uuid, uuid) to authenticated;

drop policy if exists "studio_timed_blocks_member_insert" on public.studio_timed_blocks;
create policy "studio_timed_blocks_member_insert"
  on public.studio_timed_blocks
  for insert
  to authenticated
  with check (public.member_may_insert_timed_block(studio_id, practitioner_id));

commit;
