-- ---------------------------------------------------------------------------
-- Migration 0128: session_block_areas — multiple treated areas, each with its
-- own laterality, under ONE settings block (Willow charting).
--
-- Today a session_block carries a SINGLE structured area: primary_area + one
-- block-level `side` (migration 0039). That cannot represent two areas treated
-- with the same machine settings but different sides in one block, e.g.
-- "Left cheek" + "Right sideburn". This adds a structured child table so a
-- settings block can list many treated areas, each with its own laterality.
--
-- ADDITIVE + NON-DESTRUCTIVE. session_blocks.primary_area / side /
-- custom_area_detail are left exactly as-is (legacy fallback). NO backfill. The
-- read contract (documented in lib/sessions/block-areas.ts):
--   * if a block has session_block_areas rows, they are authoritative;
--   * otherwise fall back to the legacy primary_area + side.
-- New/edited blocks write child rows; a safe legacy projection keeps
-- primary_area = the first area, and block-level `side` is only set when every
-- area shares one side (never a misleading single value for mixed laterality).
--
-- Tenant isolation is enforced in the DATABASE: studio_id is trigger-derived
-- from the parent session_block (anti-spoof, the 0035/0126 pattern); RLS limits
-- every operation to studio members. Editable (add/remove/reorder), NOT
-- append-only. NO portal/public access.
-- ---------------------------------------------------------------------------

create table if not exists public.session_block_areas (
  id                uuid primary key default gen_random_uuid(),
  session_block_id  uuid not null references public.session_blocks (id) on delete cascade,
  -- Denormalized for RLS; ALWAYS trigger-derived from the parent block below.
  studio_id         uuid not null,
  area              text not null,
  laterality        text not null
                      check (laterality in ('left', 'right', 'bilateral', 'midline', 'not_applicable')),
  -- Ordering hint (not unique, so reordering never needs swap gymnastics);
  -- deterministic order is (display_order, created_at, id).
  display_order     integer not null default 0,
  created_at        timestamptz not null default now(),

  constraint session_block_areas_area_nonempty
    check (length(btrim(area)) > 0 and length(area) <= 60),
  -- No duplicate identical (area, laterality) pair within one settings block.
  constraint session_block_areas_uniq unique (session_block_id, area, laterality)
);

create index if not exists session_block_areas_block_order_idx
  on public.session_block_areas (session_block_id, display_order, created_at, id);
create index if not exists session_block_areas_studio_idx
  on public.session_block_areas (studio_id);

-- BEFORE INSERT/UPDATE OF session_block_id: derive studio_id from the parent
-- session_block, overwriting any caller value (anti-spoof). Runs as INVOKER, so
-- RLS hides other studios' blocks → a cross-studio session_block_id resolves to
-- "not found" and is rejected.
create or replace function public.session_block_areas_derive_studio()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio uuid;
begin
  select studio_id into v_studio
    from public.session_blocks where id = new.session_block_id;
  if v_studio is null then
    raise exception 'session_block_areas.session_block_id % does not reference a visible session_blocks row', new.session_block_id;
  end if;
  new.studio_id := v_studio;
  return new;
end;
$$;

drop trigger if exists session_block_areas_derive_studio on public.session_block_areas;
create trigger session_block_areas_derive_studio
  before insert or update of session_block_id on public.session_block_areas
  for each row execute function public.session_block_areas_derive_studio();

-- RLS: studio members may read + write (add/remove/reorder) their studio's
-- rows. Mirrors session_blocks (member-scoped, editable clinical data). Portal /
-- public / unauthenticated get nothing.
alter table public.session_block_areas enable row level security;

drop policy if exists "session_block_areas_member_all" on public.session_block_areas;
create policy "session_block_areas_member_all"
  on public.session_block_areas for all to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

grant select, insert, update, delete on public.session_block_areas to authenticated;
revoke all on public.session_block_areas from anon;
grant select, insert, update, delete on public.session_block_areas to service_role;
