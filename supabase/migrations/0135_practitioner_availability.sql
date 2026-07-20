-- ===========================================================================
-- 0135 — Per-practitioner availability (PR B, additive, default-neutral)
-- ===========================================================================
--
-- Builds on 0134 (practitioner-capacity foundation). Adds an OPTIONAL
-- per-practitioner working-hours dimension to the two availability tables:
-- studio_availability_default (weekly) and studio_availability_overrides
-- (date-specific). A row with practitioner_id IS NULL is the STUDIO-WIDE
-- fallback (today's behaviour, unchanged); a row with practitioner_id = P
-- overrides the fallback for practitioner P only.
--
-- OFF-safety: this migration only ADDS a nullable column + swaps the uniqueness
-- to ONE `UNIQUE NULLS NOT DISTINCT (studio_id, day_of_week|effective_date,
-- practitioner_id)` constraint per table (a real constraint a 3-column
-- ON CONFLICT infers, keeping one studio-wide NULL row + one row per
-- practitioner). Existing rows keep practitioner_id NULL, so a flag-OFF studio
-- (Willow) is byte-for-byte
-- identical. The slot engine's OFF path never reads practitioner_id; only the
-- flag-ON path does. Blocks/blockouts/breaks are intentionally NOT
-- per-practitioner in this slice — they remain studio-wide (a whole-studio
-- closure blocks everyone), which is the safe subset.
--
-- Install as ONE transaction.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- studio_availability_default — weekly hours, optionally per practitioner.
-- ---------------------------------------------------------------------------
alter table public.studio_availability_default
  add column if not exists practitioner_id uuid;

do $$
begin
  -- Same-studio integrity via the 0032 companion unique practitioners(id, studio_id).
  -- Nullable FK column => MATCH SIMPLE: NULL practitioner_id rows (studio-wide)
  -- skip the check; non-null rows must reference a practitioner in THIS studio.
  if not exists (
    select 1 from pg_constraint where conname = 'studio_availability_default_practitioner_fk'
  ) then
    alter table public.studio_availability_default
      add constraint studio_availability_default_practitioner_fk
      foreign key (practitioner_id, studio_id)
      references public.practitioners (id, studio_id) on delete cascade;
  end if;
end $$;

-- Swap unique(studio_id, day_of_week) for ONE UNIQUE NULLS NOT DISTINCT over
-- (studio_id, day_of_week, practitioner_id). This is a REAL unique constraint
-- (not a partial index), so an ordinary 3-column `ON CONFLICT (studio_id,
-- day_of_week, practitioner_id)` — the shape the availability upsert actions
-- send — infers it WITHOUT an index predicate (which PostgREST cannot supply).
-- NULLS NOT DISTINCT treats the NULL (studio-wide) practitioner_id as a value,
-- so there is at most ONE studio-wide row per weekday AND at most one row per
-- (practitioner, weekday). Requires PG15+; production is PG17.
alter table public.studio_availability_default
  drop constraint if exists studio_availability_default_studio_id_day_of_week_key;
drop index if exists studio_availability_default_studiowide_uidx;
drop index if exists studio_availability_default_perpractitioner_uidx;
alter table public.studio_availability_default
  drop constraint if exists studio_availability_default_scope_key;
alter table public.studio_availability_default
  add constraint studio_availability_default_scope_key
  unique nulls not distinct (studio_id, day_of_week, practitioner_id);

-- ---------------------------------------------------------------------------
-- studio_availability_overrides — date-specific hours, optionally per practitioner.
-- ---------------------------------------------------------------------------
alter table public.studio_availability_overrides
  add column if not exists practitioner_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'studio_availability_overrides_practitioner_fk'
  ) then
    alter table public.studio_availability_overrides
      add constraint studio_availability_overrides_practitioner_fk
      foreign key (practitioner_id, studio_id)
      references public.practitioners (id, studio_id) on delete cascade;
  end if;
end $$;

alter table public.studio_availability_overrides
  drop constraint if exists studio_availability_overrides_studio_id_effective_date_key;
drop index if exists studio_availability_overrides_studiowide_uidx;
drop index if exists studio_availability_overrides_perpractitioner_uidx;
alter table public.studio_availability_overrides
  drop constraint if exists studio_availability_overrides_scope_key;
alter table public.studio_availability_overrides
  add constraint studio_availability_overrides_scope_key
  unique nulls not distinct (studio_id, effective_date, practitioner_id);

-- Read-path indexes for the flag-ON per-practitioner lookups.
create index if not exists studio_availability_default_practitioner_idx
  on public.studio_availability_default (practitioner_id);
create index if not exists studio_availability_overrides_practitioner_idx
  on public.studio_availability_overrides (practitioner_id);

-- ---------------------------------------------------------------------------
-- Owner-only WRITES. The 0010 policies were `member_all` (any active member
-- could write availability directly, broader than the owner-only UI). Tighten
-- to: members may READ (unchanged — the authenticated settings/calendar and the
-- studio-scoped slot reads depend on it), but only the studio OWNER may
-- INSERT/UPDATE/DELETE. This closes the non-owner direct-write gap at the DB
-- layer, not merely in the server action.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['studio_availability_default', 'studio_availability_overrides']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_member_all', t);
    execute format('drop policy if exists %I on public.%I', t || '_member_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_write', t);
    execute format(
      'create policy %I on public.%I for select using (public.is_studio_member(studio_id))',
      t || '_member_select', t);
    execute format(
      'create policy %I on public.%I for all using (public.is_studio_owner(studio_id)) with check (public.is_studio_owner(studio_id))',
      t || '_owner_write', t);
  end loop;
end $$;

-- Practitioner-scope guard: a per-practitioner availability row
-- (practitioner_id NOT NULL) may only exist when the studio has capacity
-- enabled AND the target practitioner is active in that studio. Studio-wide
-- rows (NULL) are unaffected (allowed OFF or ON). Fires on INSERT/UPDATE only,
-- so deactivating a practitioner later leaves their historical rows intact. The
-- composite FK already enforces same-studio; this adds the flag + active gates
-- as defense in depth beyond the owner-only server actions.
create or replace function public.guard_availability_practitioner_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.practitioner_id is not null then
    if not public.studio_capacity_enabled(new.studio_id) then
      raise exception
        'per-practitioner availability requires practitioner capacity to be enabled for this studio'
        using errcode = '42501';
    end if;
    -- Reject an INACTIVE target. Same-studio is left to the composite FK
    -- (23503), so this guard does not shadow that check; here we only add the
    -- flag + active gates the FK cannot express.
    if not exists (
      select 1 from public.practitioners p
      where p.id = new.practitioner_id and p.active = true
    ) then
      raise exception 'practitioner is not active'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger studio_availability_default_scope_guard_trg
  before insert or update on public.studio_availability_default
  for each row execute function public.guard_availability_practitioner_scope();
create or replace trigger studio_availability_overrides_scope_guard_trg
  before insert or update on public.studio_availability_overrides
  for each row execute function public.guard_availability_practitioner_scope();

revoke execute on function public.guard_availability_practitioner_scope() from public;
revoke execute on function public.guard_availability_practitioner_scope() from anon;
revoke execute on function public.guard_availability_practitioner_scope() from authenticated;

commit;
