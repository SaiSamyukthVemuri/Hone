-- DRAFT, UNNUMBERED, HELD. Not in supabase/migrations. Do not apply, do not number, do not copy into the migration
-- directory until OPS reserves a number and Privacy + Insurance re-review these exact bytes (Insurance C-10).
--
-- M1: identity revisions, identity audit, single-name marker (identity-readiness; Privacy R1/R2/R5/R8,
--     Insurance C-2/C-3, findings I-2/I-3).
--
-- What it does, and nothing else:
--   1. Per-concept revisions. clients.name_revision and clients.preferred_name_revision, and
--      client_legal_identities.revision, each +1 only when THAT concept's stored value changes. The app's interim
--      conditional-write (baseline in the WHERE clause) is replaced by "update ... where revision = :loaded".
--   2. Shape rule for clients.name as a TRIGGER on INSERT and UPDATE, never a CHECK ... NOT VALID. (The trigger fires on every update so
--      it can pin the revision columns, but the shape rule itself is evaluated only when name changes, or on INSERT.)
--      (A NOT VALID check is re-evaluated against the NEW row on every later update, so a legacy row that breaks it
--      would refuse every unrelated edit, e.g. a phone change. The trigger fires only when name itself changes.)
--   3. An identity audit row per change, with NO name values: who, when, which concept, new revision.
--   4. client_legal_identities.legal_single_name (boolean, default false): a client with one legal name is stated,
--      never inferred, and no name part is invented. source also allows 'client_provided'; such a row is NOT
--      verified and cannot satisfy billing completeness without staff confirmation (Insurance C-8).
--   5. Unforgeable stamps: the BEFORE INSERT OR UPDATE trigger OVERWRITES clients.name_revision and preferred_name_revision on every
--      write: an insert gets 1, an update keeps the old value and adds 1 only when that concept's value changed. A caller-supplied revision
--      is ignored (on clients AND client_legal_identities, insert and update), so a direct write to a revision column has no effect. The trigger also writes the audit row and takes the author
--      from auth.uid(). (This file changes no column privilege on clients; the guarantee is the trigger, not a grant.)
--      Audit author: changed_by is NULL for a write with no signed-in practitioner of that studio (service role, SQL, a migration).
--   6. Audit READ is owner and practitioner only, never a desk role (the gate is can_use_client_legal_identity, the one the legal
--      identity table writes use); no role can write the audit table directly.
--   7. update_client_profile_if_unchanged(): the atomic JSON-body profile save (section 6 below; Sam 3 Nov: the read-to-write gap for
--      long allergy and address fields is not accepted). One statement compares and writes; the conflict review and typed drafts stay.
--
-- NOT in this file (separately governed): any backfill, any copy of clients.name into a legal name, any drop of a
-- source column (no migration may drop a source column), any data change. Existing rows get revision 1 by default.
--
-- BEFORE NUMBERING:
--   * Sam-run, counts-only census on the hosted project (no values; willow/HOSTED-READ-0281-CENSUS.sql): number of clients whose name
--     is blank after btrim (spaces only) or over 200 characters (exactly what the trigger below refuses), plus, as information only, how
--     many contain a control character (the trigger does NOT refuse those). If non-zero, the trigger still never blocks an unrelated
--     update; those rows are only refused when their name is edited.
--   * DB tests (local stack, heavy slot): revision bumps only on a real change of that concept; a no-op update bumps
--     nothing; a stale "where revision = :n" update touches zero rows; the audit row carries no value; a receptionist
--     can neither read nor write the audit; cross-studio write refused at every entry point; grants by name.
--   * The audit table is an export-registry resource (tests/security) and needs a registry entry in the same change.
--   * Adding columns with a constant default is metadata-only on current Postgres; confirm on the hosted version.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.client_legal_identities') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'clients' and column_name = 'preferred_name') then
    raise exception 'M1 requires 0258; not applying' using errcode = '55000';
  end if;
end;
$$;

-- 1) Revisions (additive, default 1; no existing value is touched).
alter table public.clients
  add column name_revision           integer not null default 1,
  add column preferred_name_revision integer not null default 1;

alter table public.client_legal_identities
  add column revision          integer not null default 1,
  add column legal_single_name boolean not null default false;

-- 4) source: staff entry stays the default; a client-provided value is allowed but not verified.
alter table public.client_legal_identities drop constraint client_legal_identities_source_check;
alter table public.client_legal_identities
  add constraint client_legal_identities_source_check check (source in ('staff_entry', 'client_provided'));

-- 3) Audit: who changed which concept and when. No value, ever.
create table public.client_identity_audit (
  id          uuid primary key default gen_random_uuid(),
  studio_id   uuid not null references public.studios(id) on delete cascade,
  client_id   uuid not null,
  concept     text not null check (concept in ('name', 'preferred_name', 'legal_name')),
  revision    integer not null,
  -- A nullable audit pointer, ON DELETE SET NULL, like client_legal_identities.updated_by (0258): removing a practitioner must never be
  -- blocked by, or erase, the history they made. (Slot 3 finding: without this the default NO ACTION refused a practitioner delete.)
  changed_by  uuid references public.practitioners(id) on delete set null,
  changed_at  timestamptz not null default pg_catalog.now(),
  foreign key (client_id, studio_id) references public.clients(id, studio_id) on delete cascade
);
alter table public.client_identity_audit enable row level security;
revoke all on public.client_identity_audit from public, anon, authenticated, service_role;
create policy client_identity_audit_select on public.client_identity_audit
  for select to authenticated using (public.can_use_client_legal_identity(studio_id));
grant select on public.client_identity_audit to authenticated;
-- Writes happen only inside the trigger functions below (security definer); no role has insert/update/delete.

-- 1+2+3) clients: shape rule and revisions, only when the concept itself changes.
create function public.clients_identity_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
begin
  -- NULL when no signed-in practitioner of this studio is writing (service role, SQL, a migration): the audit then records no author.
  v_actor := (select p.id from public.practitioners p
               where p.studio_id = new.studio_id and p.user_id = auth.uid() and p.active limit 1);

  -- Unforgeable stamps: whatever the caller supplied for the revision columns is discarded here.
  if tg_op = 'INSERT' then
    new.name_revision := 1;
    new.preferred_name_revision := 1;
  else
    new.name_revision := old.name_revision;
    new.preferred_name_revision := old.preferred_name_revision;
  end if;

  if tg_op = 'INSERT' or new.name is distinct from old.name then
    if pg_catalog.btrim(coalesce(new.name, '')) = '' or pg_catalog.length(new.name) > 200 then
      raise exception 'clients: name must be 1 to 200 characters' using errcode = '23514';
    end if;
    if tg_op = 'UPDATE' then
      new.name_revision := old.name_revision + 1;
      insert into public.client_identity_audit (studio_id, client_id, concept, revision, changed_by)
        values (new.studio_id, new.id, 'name', new.name_revision, v_actor);
    end if;
  end if;

  if tg_op = 'UPDATE' and new.preferred_name is distinct from old.preferred_name then
    new.preferred_name_revision := old.preferred_name_revision + 1;
    insert into public.client_identity_audit (studio_id, client_id, concept, revision, changed_by)
      values (new.studio_id, new.id, 'preferred_name', new.preferred_name_revision, v_actor);
  end if;
  return new;
end;
$$;
revoke all on function public.clients_identity_guard() from public, anon, authenticated, service_role;

create trigger clients_identity_guard
  before insert or update on public.clients
  for each row execute function public.clients_identity_guard();

-- legal identity: revision and audit on a real change of any part.
create function public.client_legal_identities_revision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  -- CB-8: a first insert is stamped 1 whatever the caller sent (no audit row for the first entry; CB-5 stays a stated limit).
  if tg_op = 'INSERT' then
    new.revision := 1;
    return new;
  end if;
  if tg_op = 'UPDATE' and (
       new.legal_given_name  is distinct from old.legal_given_name
    or new.legal_middle_name is distinct from old.legal_middle_name
    or new.legal_family_name is distinct from old.legal_family_name
    or new.legal_single_name is distinct from old.legal_single_name) then
    new.revision := old.revision + 1;
    insert into public.client_identity_audit (studio_id, client_id, concept, revision, changed_by)
      values (new.studio_id, new.client_id, 'legal_name', new.revision, new.updated_by);
  elsif tg_op = 'UPDATE' then
    new.revision := old.revision;
  end if;
  return new;
end;
$$;
revoke all on function public.client_legal_identities_revision() from public, anon, authenticated, service_role;

-- Fires after 0272's guard (alphabetical trigger order: "client_legal_identities_revision" sorts after "..._guard"),
-- so updated_by is already the caller's own practitioner row.
create trigger client_legal_identities_revision
  before insert or update on public.client_legal_identities
  for each row execute function public.client_legal_identities_revision();

-- 6) Atomic profile save (Sam, 3 Nov 2026: he does NOT accept the read-to-write gap for long allergy and address fields).
-- ONE statement compares and writes: UPDATE ... WHERE id AND studio AND every expected column IS NOT DISTINCT FROM the value the page
-- loaded. Under READ COMMITTED (the PostgREST default), if another transaction changed the row first, this UPDATE waits for it and then
-- RE-EVALUATES the WHERE clause on the committed row, so a stale write matches zero rows. There is no gap between a read and the write,
-- and no value travels in a URL (JSON body only), so a 25,000-character allergies or 30,000-character address works.
-- SECURITY INVOKER on purpose: it runs with the caller's own privileges and row-level security, exactly as the PostgREST update it
-- replaces (a receptionist, another studio's member or anon gets zero rows or a privilege error, never more). The column list is fixed
-- to the eleven profile columns the edit form writes; an unknown key is refused, so this is not a general writer. skin_notes is not in it.
-- Every patched key MUST also be in p_expected (a write with no precondition is refused). p_expected may carry EXTRA keys that are not in
-- p_patch: those are the identity guards (name, phone, date_of_birth) the app already adds, and they condition the write the same way.
-- Return: the client id when the row was written; NULL when no row matched (the client is gone, in another studio, or a precondition no
-- longer holds). The app then reads the current values of the conditioned columns in the body, as it does today, and shows the existing
-- "changed by someone else" review, so the conflict panel and the typed drafts are unchanged.
-- Errors from the write itself (duplicate email 23505, the name shape rule 23514, an invalid date) are NOT swallowed.
create function public.update_client_profile_if_unchanged(
  p_studio_id uuid,
  p_client_id uuid,
  p_patch     jsonb,
  p_expected  jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  c_keys constant text[] := array['name','preferred_name','pronouns','date_of_birth','phone','email','address',
                                  'fitzpatrick_type','allergies','emergency_contact_name','emergency_contact_phone'];
  v_key text;
  v_id  uuid;
begin
  if p_patch is null or pg_catalog.jsonb_typeof(p_patch) <> 'object' or p_expected is null or pg_catalog.jsonb_typeof(p_expected) <> 'object' then
    raise exception 'update_client_profile_if_unchanged: patch and expected must be JSON objects' using errcode = '22023';
  end if;
  if p_patch = '{}'::jsonb then
    raise exception 'update_client_profile_if_unchanged: empty patch' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p_patch) loop
    if not (v_key = any (c_keys)) then
      raise exception 'update_client_profile_if_unchanged: unknown patch key' using errcode = '22023';
    end if;
    if not (p_expected ? v_key) then
      raise exception 'update_client_profile_if_unchanged: a patched key has no expected value' using errcode = '22023';
    end if;
  end loop;
  for v_key in select pg_catalog.jsonb_object_keys(p_expected) loop
    if not (v_key = any (c_keys)) then
      raise exception 'update_client_profile_if_unchanged: unknown expected key' using errcode = '22023';
    end if;
  end loop;

  update public.clients c set
    name                    = case when p_patch ? 'name'                    then p_patch ->> 'name'                                  else c.name end,
    preferred_name          = case when p_patch ? 'preferred_name'          then p_patch ->> 'preferred_name'                        else c.preferred_name end,
    pronouns                = case when p_patch ? 'pronouns'                then p_patch ->> 'pronouns'                              else c.pronouns end,
    date_of_birth           = case when p_patch ? 'date_of_birth'           then (p_patch ->> 'date_of_birth')::date                 else c.date_of_birth end,
    phone                   = case when p_patch ? 'phone'                   then p_patch ->> 'phone'                                 else c.phone end,
    email                   = case when p_patch ? 'email'                   then p_patch ->> 'email'                                 else c.email end,
    address                 = case when p_patch ? 'address'                 then p_patch ->> 'address'                               else c.address end,
    fitzpatrick_type        = case when p_patch ? 'fitzpatrick_type'        then (p_patch ->> 'fitzpatrick_type')::integer           else c.fitzpatrick_type end,
    allergies               = case when p_patch ? 'allergies'               then p_patch ->> 'allergies'                             else c.allergies end,
    emergency_contact_name  = case when p_patch ? 'emergency_contact_name'  then p_patch ->> 'emergency_contact_name'                else c.emergency_contact_name end,
    emergency_contact_phone = case when p_patch ? 'emergency_contact_phone' then p_patch ->> 'emergency_contact_phone'               else c.emergency_contact_phone end
  where c.id = p_client_id
    and c.studio_id = p_studio_id
    and (not p_expected ? 'name'                    or c.name                    is not distinct from (p_expected ->> 'name'))
    and (not p_expected ? 'preferred_name'          or c.preferred_name          is not distinct from (p_expected ->> 'preferred_name'))
    and (not p_expected ? 'pronouns'                or c.pronouns                is not distinct from (p_expected ->> 'pronouns'))
    and (not p_expected ? 'date_of_birth'           or c.date_of_birth           is not distinct from (p_expected ->> 'date_of_birth')::date)
    and (not p_expected ? 'phone'                   or c.phone                   is not distinct from (p_expected ->> 'phone'))
    and (not p_expected ? 'email'                   or c.email                   is not distinct from (p_expected ->> 'email'))
    and (not p_expected ? 'address'                 or c.address                 is not distinct from (p_expected ->> 'address'))
    and (not p_expected ? 'fitzpatrick_type'        or c.fitzpatrick_type        is not distinct from (p_expected ->> 'fitzpatrick_type')::integer)
    and (not p_expected ? 'allergies'               or c.allergies               is not distinct from (p_expected ->> 'allergies'))
    and (not p_expected ? 'emergency_contact_name'  or c.emergency_contact_name  is not distinct from (p_expected ->> 'emergency_contact_name'))
    and (not p_expected ? 'emergency_contact_phone' or c.emergency_contact_phone is not distinct from (p_expected ->> 'emergency_contact_phone'))
  returning c.id into v_id;

  return v_id;
end;
$$;
-- Authenticated staff only, by name (CLAUDE.md: Supabase default privileges grant public, anon, authenticated and service_role).
revoke all on function public.update_client_profile_if_unchanged(uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.update_client_profile_if_unchanged(uuid, uuid, jsonb, jsonb) to authenticated;

commit;
