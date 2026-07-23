-- Migration 0151: Appointment tenant-consistency composite foreign keys (RC hardening).
--
-- Root cause: migration 0010 created appointments.client_id / service_id /
-- practitioner_id as SINGLE-column foreign keys. Migration 0094 later hardened the
-- clinical/import child tables with COMPOSITE same-studio foreign keys (a child row
-- with studio_id=A cannot point at a parent in studio B) but OMITTED appointments —
-- the top-level booking entity. As a result an authenticated studio member could
-- INSERT an appointment in their OWN studio that references another studio's
-- client / service / practitioner. RLS still hides the foreign parent's details
-- (embedded reads return null) and studio_id is server-resolved, so this is a
-- referential-integrity / defense-in-depth gap rather than a data-disclosure or
-- cross-tenant-mutation leak — but multi-tenant defense-in-depth wants it enforced
-- in the schema, exactly as 0094 did for the other child tables. (Found during the
-- baseline multi-tenant isolation test on managed staging, 2026-07-22.)
--
-- Mechanism (mirrors 0094): each COMPOSITE (child_id, studio_id) foreign key
-- REPLACES the prior single-column FK and MIRRORS its ON DELETE action. On
-- Postgres 15+ the column-list `ON DELETE SET NULL (col)` nulls ONLY the parent id
-- (never the NOT NULL studio_id). The composites reference the EXISTING unique keys
-- from migration 0032 — clients / services / practitioners (id, studio_id) — so no
-- new parent uniques are created. Each table pair keeps EXACTLY ONE relationship
-- (single FK dropped before the composite is added) so PostgREST embedded selects
-- stay unambiguous.
--
-- Forward migration for every already-existing database (unlike the 0025 historical
-- correction). Existing valid appointments are unaffected (the composite joins on
-- the same rows via studio_id, which is always consistent for a valid row).
--
-- Safety: runs in ONE explicit transaction under an EXCLUSIVE lock on appointments
-- (0030/0032 pattern) so the preflight and the constraint swap cannot race with
-- appointment writes. An embedded PREFLIGHT counts any pre-existing cross-studio
-- reference and RAISES a FIXED, NON-PII exception BEFORE dropping any constraint —
-- no ids, names, emails or studio ids appear in the error. Idempotent
-- (drop-if-exists throughout). No RLS weakened; delete semantics preserved.

begin;

-- Serialize preflight + constraint replacement with concurrent appointment writes.
lock table public.appointments in exclusive mode;

-- PREFLIGHT: no appointment may reference a client / (non-null) service /
-- (non-null) practitioner that belongs to a different studio. A non-zero count is a
-- real cross-tenant row -> abort BEFORE dropping constraints. Fixed, non-PII error.
do $$
declare
  v_bad_client       bigint;
  v_bad_service      bigint;
  v_bad_practitioner bigint;
begin
  select count(*) into v_bad_client
    from public.appointments a
    join public.clients c on c.id = a.client_id
    where c.studio_id <> a.studio_id;

  select count(*) into v_bad_service
    from public.appointments a
    join public.services s on s.id = a.service_id
    where a.service_id is not null and s.studio_id <> a.studio_id;

  select count(*) into v_bad_practitioner
    from public.appointments a
    join public.practitioners p on p.id = a.practitioner_id
    where a.practitioner_id is not null and p.studio_id <> a.studio_id;

  if v_bad_client > 0 or v_bad_service > 0 or v_bad_practitioner > 0 then
    raise exception
      'appointment tenant-consistency preflight failed: cross-studio appointment reference(s) present; aborting before constraint replacement'
      using errcode = 'raise_exception';
  end if;
end $$;

-- Drop the prior single-column FKs (so each table pair keeps exactly ONE
-- relationship -> no PostgREST embed ambiguity)...
alter table public.appointments drop constraint if exists appointments_client_id_fkey;
alter table public.appointments drop constraint if exists appointments_service_id_fkey;
alter table public.appointments drop constraint if exists appointments_practitioner_id_fkey;
-- ...and any prior 0151 composites (re-run safety).
alter table public.appointments drop constraint if exists appointments_client_same_studio_fk;
alter table public.appointments drop constraint if exists appointments_service_same_studio_fk;
alter table public.appointments drop constraint if exists appointments_practitioner_same_studio_fk;

-- client: NOT NULL, ON DELETE CASCADE (mirrors 0010). Both FK columns are NOT NULL
-- so this composite is always enforced. References clients (id, studio_id) [0032].
alter table public.appointments add constraint appointments_client_same_studio_fk
  foreign key (client_id, studio_id) references public.clients (id, studio_id)
  on delete cascade;

-- service: nullable, ON DELETE SET NULL (service_id) — nulls ONLY service_id so the
-- NOT NULL studio_id is preserved. MATCH SIMPLE skips the check when service_id is
-- null (nullable behavior preserved). References services (id, studio_id) [0032].
alter table public.appointments add constraint appointments_service_same_studio_fk
  foreign key (service_id, studio_id) references public.services (id, studio_id)
  on delete set null (service_id);

-- practitioner: nullable, ON DELETE SET NULL (practitioner_id). Same nullable +
-- studio_id-preserving semantics. References practitioners (id, studio_id) [0032].
alter table public.appointments add constraint appointments_practitioner_same_studio_fk
  foreign key (practitioner_id, studio_id) references public.practitioners (id, studio_id)
  on delete set null (practitioner_id);

commit;
