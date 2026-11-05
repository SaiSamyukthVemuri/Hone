-- 0253 — HON-48 F1: a non-owner blocks and edits only THEIR OWN schedule.
--
-- Decision (Sam, 2026-10-25, SAM-DECISIONS item 14): practitioners create or edit
-- blocks only on their own schedule; owners may block any practitioner or the
-- whole studio. Enforced here, in the database, not in the calendar UI.
--
-- BEHAVIOUR CHANGE for members of capacity-OFF studios (decision 14, explicit):
-- before this migration any studio member could close the WHOLE studio from the
-- calendar (a studio-wide timed block) and could add or delete a full-day
-- blockout. After it, ONLY OWNERS can write a studio-wide block or a blockout,
-- whatever the capacity flag says. A member of a studio that does not use
-- per-practitioner scheduling can no longer drag-to-block; the owner must do it.
-- Capacity ON members lose the same studio-wide ability, and gain a right they
-- did not have: they can now insert, update and delete blocks scoped to
-- themselves.
--
-- What it does:
--   studio_timed_blocks
--     INSERT  member: only a row scoped to the caller's OWN active practitioner
--             row in that same studio, capacity ON. A studio-wide row (any
--             capacity) or a colleague's id is refused by RLS (42501).
--     UPDATE  member: only a row that is ALREADY scoped to the caller's own
--             active practitioner row (USING), and it must stay so (WITH CHECK):
--             it cannot be re-scoped to a colleague or to studio-wide.
--     DELETE  member: only such an own, scoped row.
--     Owners are unchanged: 0030 owner_all and 0138 owner_scoped_write already
--     allow every row, scoped or studio-wide.
--   studio_blockouts
--     Has NO practitioner column (it is studio-wide by construction, 0010), so a
--     member write can never be "their own". Member writes are refused entirely:
--     the member_all policy is replaced by a member SELECT policy and an owner
--     write policy.
--
-- Unchanged on purpose: guard_scoped_source_capacity (0137/0138) still takes the
-- per-studio capacity lock and refuses a scoped row when capacity is OFF (42501)
-- or the target is inactive (23514); it fires BEFORE the policy check, so those
-- codes win over RLS for scoped rows. The composite (studio_id, practitioner_id)
-- FK still refuses a cross-studio id (23503).
--
-- Why a function: studio_capacity_enabled(uuid) has EXECUTE revoked from every
-- runtime role (0134), and own_practitioner_in_studio(uuid) likewise (0178), so a
-- policy evaluated as `authenticated` cannot call them. The decision function is
-- SECURITY DEFINER with a pinned search_path and qualified references, and is the
-- only new EXECUTE grant: `authenticated`, because a policy needs it.

begin;
set local lock_timeout = '5s';

create or replace function public.member_owns_scoped_timed_block(
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
    p_studio_id is not null
    and p_practitioner_id is not null
    and public.studio_capacity_enabled(p_studio_id)
    and exists (
      select 1
        from public.practitioners p
       where p.id = p_practitioner_id
         and p.studio_id = p_studio_id
         and p.user_id = auth.uid()
         and p.active = true
    ),
    false
  );
$$;

-- Supabase's default privileges grant EXECUTE to PUBLIC, anon, authenticated AND
-- service_role at create time: revoke all four by name, then grant back only what
-- the policies need.
revoke execute on function public.member_owns_scoped_timed_block(uuid, uuid) from public;
revoke execute on function public.member_owns_scoped_timed_block(uuid, uuid) from anon;
revoke execute on function public.member_owns_scoped_timed_block(uuid, uuid) from authenticated;
revoke execute on function public.member_owns_scoped_timed_block(uuid, uuid) from service_role;
grant execute on function public.member_owns_scoped_timed_block(uuid, uuid) to authenticated;

drop policy if exists "studio_timed_blocks_member_insert" on public.studio_timed_blocks;
create policy "studio_timed_blocks_member_insert"
  on public.studio_timed_blocks
  for insert
  to authenticated
  with check (public.member_owns_scoped_timed_block(studio_id, practitioner_id));

drop policy if exists "studio_timed_blocks_member_update_own" on public.studio_timed_blocks;
create policy "studio_timed_blocks_member_update_own"
  on public.studio_timed_blocks
  for update
  to authenticated
  using (public.member_owns_scoped_timed_block(studio_id, practitioner_id))
  with check (public.member_owns_scoped_timed_block(studio_id, practitioner_id));

drop policy if exists "studio_timed_blocks_member_delete_own" on public.studio_timed_blocks;
create policy "studio_timed_blocks_member_delete_own"
  on public.studio_timed_blocks
  for delete
  to authenticated
  using (public.member_owns_scoped_timed_block(studio_id, practitioner_id));

-- studio_blockouts: studio-wide by construction, so owners only may write.
drop policy if exists "studio_blockouts_member_all" on public.studio_blockouts;
drop policy if exists "studio_blockouts_member_select" on public.studio_blockouts;
create policy "studio_blockouts_member_select"
  on public.studio_blockouts
  for select
  to authenticated
  using (public.is_studio_member(studio_id));
drop policy if exists "studio_blockouts_owner_write" on public.studio_blockouts;
create policy "studio_blockouts_owner_write"
  on public.studio_blockouts
  for all
  to authenticated
  using (public.is_studio_owner(studio_id))
  with check (public.is_studio_owner(studio_id));

commit;
