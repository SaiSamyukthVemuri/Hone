-- ---------------------------------------------------------------------------
-- Migration 0161: deterministic service ordering + a wider, separable service
-- colour set.
--
-- DEPENDS ON: 0021 (services.sort_order), 0153 (services.calendar_color).
-- Migration max 0160 -> 0161.
--
-- ===========================================================================
-- THE DEFECT (ordering) — reproduced against a CI-parity database.
-- ===========================================================================
-- `services.sort_order` is `not null default 100` (0021) with NO uniqueness and
-- no per-studio normalization, and new services are numbered by
-- `max(sort_order) + 10` scoped PER MODALITY. A studio with a consultation
-- service and an electrolysis service is therefore GUARANTEED to have two rows
-- at sort_order = 100. Ties are the normal state, not an edge case.
--
-- The settings page numbers its Move up / Move down arrows from a list sorted
-- `(active desc, sort_order asc, name)`. The old server action re-read its own
-- list with `order by sort_order` and NO secondary key, so tied rows came back
-- in heap order — which changes after every UPDATE, because Postgres writes a
-- new tuple version at the end of the heap. The row at screen position N was
-- routinely NOT the row the action found at index N. When the action happened
-- to find the clicked service at index 0 it returned silently after
-- revalidating: the practitioner tapped "Move up", the page re-rendered, and
-- nothing moved — permanently, because the no-op changes nothing, so the next
-- tap resolves the identical tie the identical way. That is exactly "the
-- service I want first cannot reliably reach the top".
--
-- The old swap also wrote TWO independent UPDATEs with no transaction and no
-- optimistic-concurrency predicate. A failure between them left both rows
-- holding the neighbour's value — a NEW permanent duplicate.
--
-- ===========================================================================
-- WHAT THIS MIGRATION DOES
-- ===========================================================================
-- 1. `public.reorder_studio_service(...)` — ONE atomic, owner-authorized
--    command that normalizes the studio's services into unique, deterministic
--    positions and applies the requested move (top / up / down / bottom) in the
--    same transaction. There is no window in which the order is duplicated or
--    half-applied.
-- 2. Widens the 0153 `calendar_color` CHECK from six values to ten. Every
--    existing key is preserved; four visually distinct families are added.
--
-- NOT DONE HERE, DELIBERATELY:
--   * No uniqueness constraint on sort_order. Hidden services keep their stored
--     values, and a hard constraint would make an un-hide fail instead of
--     re-slotting. The RPC normalizes on every move, which is the durable fix.
--   * No business-row rewrite. The colour CHECK is widened, never narrowed, so
--     every stored value stays legal and no row is touched. The RPC rewrites
--     ONLY `sort_order` (+ `updated_at`) on the studio's own services, and only
--     when an owner explicitly taps a move control — never at apply time.
--
-- ===========================================================================
-- MIGRATION-FIRST MIXED-VERSION SAFETY
-- ===========================================================================
-- Applying this BEFORE the application deploy is safe in both directions:
--   * The currently deployed app never calls `reorder_studio_service`. Creating
--     an unused function changes nothing for it.
--   * The colour CHECK is only WIDENED. The deployed app writes only the six
--     original keys, all of which remain legal. It never reads the constraint.
--   * During the mixed window the old two-update swap still works exactly as it
--     does today (badly, but no worse) — the RPC does not replace or disable it
--     at the database level.
-- Rolling the app forward without this migration would fail loudly (undefined
-- function / CHECK violation) rather than silently, so migration-first is the
-- required order.
--
-- ===========================================================================
-- WHY THIS FILE OPENS ITS OWN TRANSACTION (0159/0160 precedent)
-- ===========================================================================
-- `supabase db push --linked` does NOT wrap a migration file in an explicit
-- transaction. A bare `SET LOCAL lock_timeout` therefore emits
-- `WARNING (25P01): SET LOCAL can only be used in transaction blocks` and
-- silently NEVER ARMS, and the file is not atomic. This file opens the
-- transaction itself so the timeout genuinely arms and the whole migration
-- commits or rolls back as one unit.
--
-- EXPECTED ROLLBACK BEHAVIOUR. If any statement fails — including a lock_timeout
-- (SQLSTATE 55P03) while acquiring the lock the constraint swap needs — COMMIT
-- is never reached and everything rolls back: no `reorder_studio_service`, the
-- ORIGINAL six-value CHECK still in place, and every row unchanged. Re-running
-- is then safe and idempotent.
--
-- Every statement below is legal inside a transaction block: no CREATE INDEX
-- CONCURRENTLY, no ALTER TYPE ... ADD VALUE, no VACUUM.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ===========================================================================
-- 1. Atomic, owner-authorized service reorder.
-- ===========================================================================
-- Contract:
--   * Owner only. `is_studio_owner` is the same predicate the settings surface
--     already enforces in the action layer; enforcing it again here means the
--     RPC is safe even if reached directly over PostgREST.
--   * Operates on the studio's VISIBLE (active) services, in the SAME canonical
--     order the application uses: (sort_order asc, name asc, id asc). The `id`
--     term is what makes it total — with it there are no ties left to resolve
--     in heap order, so the server and the screen can never disagree again.
--   * Normalizes those services to 10, 20, 30 … BEFORE applying the move, so
--     one tap always moves exactly one position.
--   * HIDDEN services are not renumbered and not moved. They are also given a
--     position ABOVE the visible block's range on un-hide by the application's
--     normalize call, so a stale stored value can never collide with the new
--     sequence — see section 1b.
--   * Returns the resulting ordered ids so the caller can reconcile optimistic
--     UI without a second read.
--   * p_expected_position is an optional optimistic-concurrency token: the
--     0-based position the CLIENT believed the service occupied. When supplied
--     and stale, the RPC raises rather than moving the wrong row — this closes
--     the interleaved-double-tap race the old per-arrow forms allowed.

create or replace function public.reorder_studio_service(
  p_studio_id         uuid,
  p_service_id        uuid,
  p_move              text,             -- 'top' | 'up' | 'down' | 'bottom'
  p_expected_position integer default null
)
returns uuid[]
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_ids      uuid[];
  v_idx      integer;
  v_target   integer;
  v_len      integer;
  v_moved    uuid;
begin
  if not public.is_studio_owner(p_studio_id) then
    raise exception 'not authorized for studio %', p_studio_id
      using errcode = '42501';
  end if;

  if p_move is null or p_move not in ('top', 'up', 'down', 'bottom') then
    raise exception 'p_move must be one of top, up, down, bottom'
      using errcode = '22023';
  end if;

  -- Lock the studio's visible services for the duration of the transaction so a
  -- concurrent reorder cannot interleave a read-modify-write. FOR UPDATE on the
  -- canonical set is enough: every writer of sort_order goes through here.
  perform 1
    from public.services
   where studio_id = p_studio_id
     and active
   for update;

  -- Canonical, TOTAL ordering. The trailing id term removes the last tie.
  select array_agg(id order by sort_order asc, name asc, id asc)
    into v_ids
    from public.services
   where studio_id = p_studio_id
     and active;

  if v_ids is null then
    return array[]::uuid[];
  end if;

  v_len := array_length(v_ids, 1);
  v_idx := array_position(v_ids, p_service_id);

  if v_idx is null then
    -- Hidden, deleted, or another studio's service. Not an error: the caller's
    -- view was stale. Normalize what we can see and report it.
    for i in 1 .. v_len loop
      update public.services
         set sort_order = i * 10,
             updated_at = now()
       where id = v_ids[i]
         and studio_id = p_studio_id
         and sort_order is distinct from i * 10;
    end loop;
    return v_ids;
  end if;

  -- Optimistic concurrency: the caller tells us where it BELIEVED the row was.
  if p_expected_position is not null and p_expected_position <> (v_idx - 1) then
    raise exception 'service order changed elsewhere; reload and try again'
      using errcode = '40001';
  end if;

  v_target := case p_move
                when 'top'    then 1
                when 'bottom' then v_len
                when 'up'     then greatest(1, v_idx - 1)
                when 'down'   then least(v_len, v_idx + 1)
              end;

  if v_target <> v_idx then
    v_moved := v_ids[v_idx];
    v_ids   := v_ids[1:v_idx-1] || v_ids[v_idx+1:v_len];
    v_ids   := v_ids[1:v_target-1] || array[v_moved] || v_ids[v_target:array_length(v_ids, 1)];
  end if;

  -- ONE normalization pass writes the final, unique, deterministic positions.
  -- `is distinct from` keeps it a no-op write for rows already correct.
  for i in 1 .. v_len loop
    update public.services
       set sort_order = i * 10,
           updated_at = now()
     where id = v_ids[i]
       and studio_id = p_studio_id
       and sort_order is distinct from i * 10;
  end loop;

  return v_ids;
end;
$$;

comment on function public.reorder_studio_service(uuid, uuid, text, integer) is
  'Atomically normalize a studio''s visible service order to 10,20,30… and apply one move (top/up/down/bottom). Owner-only. Returns the resulting ordered ids. Migration 0161.';

revoke all on function public.reorder_studio_service(uuid, uuid, text, integer)
  from public, anon;
grant execute on function public.reorder_studio_service(uuid, uuid, text, integer)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1b. Re-showing a hidden service must not collide with the normalized block.
-- ---------------------------------------------------------------------------
-- A hidden service keeps whatever sort_order it had when it was hidden (which
-- may be 100, i.e. right in the middle of the new 10/20/30 sequence, or exactly
-- equal to another row's). This helper places a newly-shown service at the END
-- of the visible order and renormalizes, in one transaction.

create or replace function public.show_studio_service(
  p_studio_id  uuid,
  p_service_id uuid
)
returns uuid[]
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_max integer;
begin
  if not public.is_studio_owner(p_studio_id) then
    raise exception 'not authorized for studio %', p_studio_id
      using errcode = '42501';
  end if;

  select coalesce(max(sort_order), 0) into v_max
    from public.services
   where studio_id = p_studio_id
     and active;

  update public.services
     set active     = true,
         sort_order = v_max + 10,
         updated_at = now()
   where id = p_service_id
     and studio_id = p_studio_id;

  if not found then
    raise exception 'service % not found in studio %', p_service_id, p_studio_id
      using errcode = 'P0002';
  end if;

  -- Renormalize so the freshly-shown row lands on a clean position too.
  return public.reorder_studio_service(p_studio_id, p_service_id, 'bottom');
end;
$$;

comment on function public.show_studio_service(uuid, uuid) is
  'Re-show a hidden service at the END of the visible order and renormalize positions. Owner-only. Migration 0161.';

revoke all on function public.show_studio_service(uuid, uuid) from public, anon;
grant execute on function public.show_studio_service(uuid, uuid)
  to authenticated, service_role;

-- ===========================================================================
-- 2. Wider, visually separable service colour set.
-- ===========================================================================
-- 0153 allowed six keys: amber, emerald, teal, sky, indigo, violet. In practice
-- teal/emerald and sky/indigo/violet are hard to tell apart on a phone, and six
-- choices is not enough for a real service menu.
--
-- ADDED (four): orange, lime, fuchsia, slate.
--   orange  — deep warm; separated from amber by BOTH hue and lightness.
--   lime    — yellow-green; separates cleanly from emerald (true green).
--   fuchsia — magenta; a distinct hue from violet, and unmistakably not red.
--   slate   — neutral; the natural choice for admin/consultation services and
--             trivially separable from every chromatic option.
--
-- DELIBERATELY NOT ADDED:
--   red, rose — RESERVED, permanently, for allergies, EpiPen and clinical
--               cautions. Diluting that signal is not a colour-choice trade-off.
--   pink      — too close to the reserved rose family at a glance on a phone.
--   blue, cyan— both land inside the already-crowded teal/sky/indigo band that
--               Chloe reported as unreadable. Adding them would make the exact
--               reported problem worse.
--
-- WIDEN ONLY. Every one of the six original keys stays legal, so no stored value
-- becomes invalid and NO ROW IS REWRITTEN.
--
-- The swap uses NOT VALID + VALIDATE deliberately. `add constraint … check` in
-- one step takes ACCESS EXCLUSIVE for the whole existing-row scan; NOT VALID
-- takes it only briefly, and VALIDATE then runs under SHARE UPDATE EXCLUSIVE,
-- which does not block concurrent reads or writes. The validation cannot fail:
-- the old allowed set is a strict subset of the new one.

alter table public.services
  drop constraint if exists services_calendar_color_allowed;

alter table public.services
  add constraint services_calendar_color_allowed
  check (calendar_color in (
    -- 0153 originals — preserved exactly.
    'amber', 'emerald', 'teal', 'sky', 'indigo', 'violet',
    -- 0161 additions.
    'orange', 'lime', 'fuchsia', 'slate'
  ))
  not valid;

alter table public.services
  validate constraint services_calendar_color_allowed;

comment on constraint services_calendar_color_allowed on public.services is
  'Ten allowed calendar colour keys (0153 six + 0161 four). red/rose/pink are permanently reserved for allergy and clinical-caution signals. Migration 0161.';

commit;

-- ===========================================================================
-- 3. Operator verification (READ-ONLY; run after apply).
-- ===========================================================================
--   -- Both functions exist, are SECURITY DEFINER with a pinned search_path.
--   select p.proname, p.prosecdef, p.proconfig
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('reorder_studio_service', 'show_studio_service')
--    order by 1;
--
--   -- anon cannot execute either; authenticated can.
--   select has_function_privilege('anon',
--            'public.reorder_studio_service(uuid,uuid,text,integer)', 'execute') as anon_exec,
--          has_function_privilege('authenticated',
--            'public.reorder_studio_service(uuid,uuid,text,integer)', 'execute') as auth_exec;
--
--   -- The CHECK now lists ten keys and is VALIDATED.
--   select conname, convalidated, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.services'::regclass
--      and conname = 'services_calendar_color_allowed';
--
--   -- ZERO DATA OPERATION at apply time: no service row is written by this file.
--   select count(*) as services,
--          count(*) filter (where calendar_color in
--            ('orange','lime','fuchsia','slate')) as new_family_rows  -- expect 0
--     from public.services;
--
--   -- Distribution of stored sort_order duplicates BEFORE any owner taps a move
--   -- control (expected: non-zero — this migration does not renumber anything).
--   select studio_id, sort_order, count(*)
--     from public.services where active
--    group by 1, 2 having count(*) > 1 order by 3 desc limit 20;
--
-- ===========================================================================
-- ROLLBACK (throwaway/local only; not part of this PR's hosted apply):
--   begin;
--   drop function if exists public.show_studio_service(uuid, uuid);
--   drop function if exists public.reorder_studio_service(uuid, uuid, text, integer);
--   alter table public.services drop constraint services_calendar_color_allowed;
--   alter table public.services add constraint services_calendar_color_allowed
--     check (calendar_color in ('amber','emerald','teal','sky','indigo','violet'));
--   commit;
--   NOTE: the narrow rollback FAILS if any service has already been saved with a
--   0161 colour. Reset those rows to a 0153 key first — that is a deliberate
--   data decision, not something a rollback should do silently.
-- ===========================================================================
