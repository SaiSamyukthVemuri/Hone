-- ===========================================================================
-- A CLIENT'S SMS CONSENT IS BOUND TO THE NUMBER IT WAS GIVEN FOR
-- ===========================================================================
--
-- The problem. clients.sms_consent_at records THAT a client agreed to texts, not WHICH number they agreed for, and a studio
-- member may edit clients.phone freely. Every send gate reads the current phone beside the old consent, so a corrected,
-- replaced or later-added number inherits a consent that was never given for it.
--
-- What this does, in four parts (Part 2 carries the one open product choice, marked below; Part 4 is fresh consent for a changed number).
--   1. Two new columns on clients: sms_consent_phone (the normalized number the consent was given for) and
--      sms_consent_text_version (the wording the client saw). One BEFORE trigger sets the number in the SAME statement that
--      records consent, for every writer (the new-client booking command, the existing-client stamp, any future path), so no
--      writer needs a new argument. Consent with no sendable number is refused. Both columns are write-once with the consent.
--   2. The spend-time gate: the single SQL definition of "a reminder appointment worth loading" (the view
--      reminder_sms_eligible_appointments) requires the current normalized number to equal the number consented for.
--   3. Existing rows. NOTHING is backfilled: the only available fact about an old consent is the current phone, which would
--      claim a number we cannot prove. A legacy consent keeps sms_consent_phone NULL. What the gate does for those rows is the
--      OPEN PRODUCT CHOICE (see GATE POLICY). Chosen here: allow them as today, and bind them to the number they hold the first
--      time that number is changed, so every drift AFTER this migration is caught and only pre-migration drift stays unprovable.
--
--   4. Fresh consent. A client who changed number can consent again for the number now on file: a trusted writer may then REPLACE the consent
--      (later time, different number, no STOP). The client SMS permission guard gets that one exception, and every consent recorded or replaced is kept in an
--      append-only record (client_sms_consent_events).
--
-- NOT IN THIS FILE: a phone-level suppression list (separate, optional part, scoped in the cutover note), and the application
-- changes (the existing-client stamp passing the wording version, the TypeScript gate and the edit-screen notice).
--
-- OWNERSHIP. Runs as the migration owner. Touches clients (two new nullable columns, a trigger), one new function, and one
-- view definition (same columns). It scans no table.
begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
alter table public.clients
  add column if not exists sms_consent_phone text,
  add column if not exists sms_consent_text_version text;

-- sms_consent_phone is an E.164 number as sms_normalized_phone returns it, or the single marker '-' meaning "the consent was
-- recorded with no number" (a legacy shape; it never equals any destination, so it can never be spent).
alter table public.clients
  drop constraint if exists clients_sms_consent_phone_shape_check;
alter table public.clients
  add constraint clients_sms_consent_phone_shape_check
  check (sms_consent_phone is null or sms_consent_phone = '-' or sms_consent_phone ~ '^\+[0123456789]{8,15}$');

alter table public.clients
  drop constraint if exists clients_sms_consent_evidence_check;
alter table public.clients
  add constraint clients_sms_consent_evidence_check
  check ((sms_consent_phone is null and sms_consent_text_version is null) or sms_consent_at is not null);

alter table public.clients
  drop constraint if exists clients_sms_consent_text_version_check;
alter table public.clients
  add constraint clients_sms_consent_text_version_check
  check (sms_consent_text_version is null or sms_consent_text_version ~ '^[a-z0-9_]{1,64}$');

comment on column public.clients.sms_consent_phone is
  'The normalized number the SMS consent was given for (sms_normalized_phone at the moment of consent). NULL on a consent recorded before the binding existed: no number can be proved for it. ''-'' marks a consent that had no number. Set only by the binding trigger; write-once.';
comment on column public.clients.sms_consent_text_version is
  'The wording version the client agreed to, supplied by the governed writer. NULL when the writer did not supply one. Write-once.';

-- ---------------------------------------------------------------------------
-- The binding trigger. SECURITY INVOKER, so current_user is the real caller (the same pattern as the permission guard): anon and authenticated are
-- raw API callers, the booking command runs as its owner and the stamp as service_role, both trusted.
-- ---------------------------------------------------------------------------
create or replace function public.clients_sms_consent_binding_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_member constant boolean := current_user in ('anon', 'authenticated');
begin
  if tg_op = 'INSERT' then
    if v_member and (new.sms_consent_at is not null or new.sms_consent_source is not null
                     or new.sms_consent_phone is not null or new.sms_consent_text_version is not null) then
      raise exception 'clients: SMS consent is recorded only by governed paths (role %)', current_user using errcode = '42501';
    end if;
    if new.sms_consent_at is null then
      if new.sms_consent_phone is not null or new.sms_consent_text_version is not null then
        raise exception 'clients: consent evidence without a consent' using errcode = 'check_violation';
      end if;
      return new;
    end if;
    new.sms_consent_phone := public.sms_normalized_phone(new.phone);
    if new.sms_consent_phone is null then
      raise exception 'clients: SMS consent needs a sendable number' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- UPDATE
  if v_member and (new.sms_consent_at is distinct from old.sms_consent_at
                   or new.sms_consent_source is distinct from old.sms_consent_source
                   or new.sms_consent_phone is distinct from old.sms_consent_phone
                   or new.sms_consent_text_version is distinct from old.sms_consent_text_version) then
    raise exception 'clients: SMS consent evidence is recorded only by governed paths (role %)', current_user using errcode = '42501';
  end if;

  if old.sms_consent_at is null then
    if new.sms_consent_at is null then
      if new.sms_consent_phone is not null or new.sms_consent_text_version is not null then
        raise exception 'clients: consent evidence without a consent' using errcode = 'check_violation';
      end if;
      return new;
    end if;
    -- consent is being recorded now: bind it to the number this same statement leaves on the row
    new.sms_consent_phone := public.sms_normalized_phone(new.phone);
    if new.sms_consent_phone is null then
      raise exception 'clients: SMS consent needs a sendable number' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- a consent already exists. It can be REPLACED only by a trusted writer recording a FRESH consent for the number the row now holds
  -- (the client confirmed it): the old consent covers a different number, is bound, no STOP exists, and the new consent time is later.
  -- Every other change to the evidence is refused; the replaced consent is kept in client_sms_consent_events.
  if new.sms_consent_at is distinct from old.sms_consent_at or new.sms_consent_source is distinct from old.sms_consent_source then
    if v_member then
      raise exception 'clients: SMS consent evidence is recorded only by governed paths (role %)', current_user using errcode = '42501';
    end if;
    if old.sms_consent_phone is null or old.sms_opted_out_at is not null or new.sms_consent_at is null
       or new.sms_consent_at <= old.sms_consent_at
       or public.sms_normalized_phone(new.phone) is null
       or public.sms_normalized_phone(new.phone) is not distinct from old.sms_consent_phone then
      raise exception 'clients: SMS consent evidence is write-once; fresh consent may replace it only for a different number' using errcode = 'check_violation';
    end if;
    new.sms_consent_phone := public.sms_normalized_phone(new.phone);
    return new;
  end if;
  if new.sms_consent_text_version is distinct from old.sms_consent_text_version then
    raise exception 'clients: SMS consent evidence is write-once' using errcode = 'check_violation';
  end if;
  if old.sms_consent_phone is not null then
    if new.sms_consent_phone is distinct from old.sms_consent_phone then
      raise exception 'clients: SMS consent evidence is write-once' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- A LEGACY consent (no bound number). A caller can never claim one. The first time the number is changed, the consent is
  -- bound to the number the row held BEFORE the change, which is a fact known at this moment (or to '-' when it held none).
  if new.sms_consent_phone is not null then
    raise exception 'clients: SMS consent evidence is write-once' using errcode = 'check_violation';
  end if;
  if new.phone is distinct from old.phone
     and public.sms_normalized_phone(new.phone) is distinct from public.sms_normalized_phone(old.phone) then
    new.sms_consent_phone := coalesce(public.sms_normalized_phone(old.phone), '-');
  end if;
  return new;
end;
$$;

drop trigger if exists clients_sms_consent_binding on public.clients;
create trigger clients_sms_consent_binding
  before insert or update of phone, sms_consent_at, sms_consent_source, sms_consent_phone, sms_consent_text_version
  on public.clients
  for each row
  execute function public.clients_sms_consent_binding_guard();

revoke all privileges on function public.clients_sms_consent_binding_guard() from public, anon, authenticated, service_role;

comment on function public.clients_sms_consent_binding_guard() is
  'Binds a client''s SMS consent to the number it was given for, in the same statement that records it. Consent with no sendable number is refused. Evidence is write-once; a legacy consent is bound to its number at the first change of that number. Raw API callers can never set the evidence.';

-- ---------------------------------------------------------------------------
-- 4. Fresh consent for a different number, and the record of every consent.
-- (a) The client SMS permission guard is re-created from its CURRENT body, asserted by md5, with ONE added exception to "consent evidence is write-once":
--     a later consent for a different bound number, no STOP. Everything else in the body is unchanged.
-- ---------------------------------------------------------------------------
do $$
begin
  if (select md5(p.prosrc) from pg_proc p where p.oid = 'public.clients_sms_permission_guard()'::regprocedure) <> '534c7e27a810ea277e6d437a7b3d7eea' then
    raise exception 'clients_sms_permission_guard is not the body this migration was written against; re-derive it' using errcode = 'check_violation';
  end if;
end $$;

create or replace function public.clients_sms_permission_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  -- A raw API caller, as opposed to a SECURITY DEFINER command (current_user
  -- is its owner) or a service_role connection. Invoker rights make this the
  -- real caller.
  v_member constant boolean := current_user in ('anon', 'authenticated');
begin
  if tg_op = 'INSERT' then
    -- Rule 1: a member's new client arrives without consent.
    if v_member
       and (new.sms_consent_at is not null or new.sms_consent_source is not null) then
      raise exception
        'clients: SMS consent is recorded only by governed paths (role %)',
        current_user using errcode = '42501';
    end if;
    -- Rule 4: a member may create a client already withdrawn, as their own record.
    if v_member
       and (new.sms_opted_out_at is not null or new.sms_opt_out_source is not null) then
      if new.sms_opt_out_source is distinct from 'practitioner' then
        raise exception
          'clients: a studio member records a withdrawal with source practitioner (role %)',
          current_user using errcode = '42501';
      end if;
      new.sms_opted_out_at := now();
    end if;
    return new;
  end if;

  -- UPDATE.
  if new.sms_consent_at is distinct from old.sms_consent_at
     or new.sms_consent_source is distinct from old.sms_consent_source then
    -- Rule 1: a member never records, changes or removes consent.
    if v_member then
      raise exception
        'clients: SMS consent is recorded only by governed paths (role %)',
        current_user using errcode = '42501';
    end if;
    -- Rule 2: consent evidence is write-once, for everyone.
    -- The one exception is a FRESH consent for a different number (the binding trigger has already checked it and set the number):
    -- the bound number changed, it is a later consent, and no STOP exists.
    if (old.sms_consent_at is not null or old.sms_consent_source is not null)
       and not (old.sms_consent_phone is not null
                and new.sms_consent_phone is not null
                and new.sms_consent_phone is distinct from old.sms_consent_phone
                and new.sms_consent_at > old.sms_consent_at
                and old.sms_opted_out_at is null) then
      raise exception
        'clients: SMS consent evidence is write-once; a withdrawal is an opt-out, not an edit'
        using errcode = 'check_violation';
    end if;
  end if;

  -- Rule 3: an opt-out is terminal, for everyone.
  if (old.sms_opted_out_at is not null or old.sms_opt_out_source is not null)
     and (new.sms_opted_out_at is distinct from old.sms_opted_out_at
          or new.sms_opt_out_source is distinct from old.sms_opt_out_source) then
    raise exception
      'clients: an SMS opt-out is terminal and its evidence is immutable'
      using errcode = 'check_violation';
  end if;

  -- Rule 4: a member adding an opt-out records a withdrawal, on the database clock.
  if v_member
     and old.sms_opted_out_at is null and old.sms_opt_out_source is null
     and (new.sms_opted_out_at is not null or new.sms_opt_out_source is not null) then
    if new.sms_opt_out_source is distinct from 'practitioner' then
      raise exception
        'clients: a studio member records a withdrawal with source practitioner (role %)',
        current_user using errcode = '42501';
    end if;
    new.sms_opted_out_at := now();
  end if;

  return new;
end;
$$;

-- (b) Every consent that is recorded or replaced is kept: append-only, studio-scoped, written only by the trigger below. The number is stored as a
-- fingerprint (sha256 of the normalized number; equality evidence, not secrecy, since the number itself sits on the client row).
create table if not exists public.client_sms_consent_events (
  id             uuid primary key default gen_random_uuid(),
  studio_id      uuid not null,
  client_id      uuid not null,
  kind           text not null check (kind in ('recorded', 'superseded')),
  consented_at   timestamptz not null,
  source         text,
  phone_sha256   text check (phone_sha256 is null or phone_sha256 ~ '^[0123456789abcdef]{64}$'),
  text_version   text check (text_version is null or text_version ~ '^[a-z0-9_]{1,64}$'),
  recorded_at    timestamptz not null default pg_catalog.now()
);
create index if not exists client_sms_consent_events_client_idx on public.client_sms_consent_events (client_id, recorded_at);
alter table public.client_sms_consent_events enable row level security;
alter table public.client_sms_consent_events force row level security;
revoke all on public.client_sms_consent_events from public, anon, authenticated, service_role;
comment on table public.client_sms_consent_events is
  'Append-only record of each SMS consent recorded or replaced on a client: when, the source, a fingerprint of the number it was for, the wording version. No policy: no API role reads or writes it.';

create or replace function public.client_sms_consent_events_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'client_sms_consent_events is append-only' using errcode = 'check_violation';
end;
$$;
drop trigger if exists client_sms_consent_events_row_guard on public.client_sms_consent_events;
create trigger client_sms_consent_events_row_guard before update or delete on public.client_sms_consent_events
  for each row execute function public.client_sms_consent_events_guard();
drop trigger if exists client_sms_consent_events_truncate_guard on public.client_sms_consent_events;
create trigger client_sms_consent_events_truncate_guard before truncate on public.client_sms_consent_events
  for each statement execute function public.client_sms_consent_events_guard();

-- SECURITY DEFINER: the trigger fires as the caller (service_role, the booking command's owner), none of which may write the table.
create or replace function public.clients_sms_consent_event_writer()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.sms_consent_at is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.sms_consent_at is not distinct from old.sms_consent_at then
      return new;
    end if;
    -- the consent being replaced: kept as a snapshot when no earlier event already describes it (a consent from before this migration)
    if old.sms_consent_at is not null
       and not exists (select 1 from public.client_sms_consent_events e where e.client_id = old.id and e.consented_at = old.sms_consent_at) then
      insert into public.client_sms_consent_events (studio_id, client_id, kind, consented_at, source, phone_sha256, text_version)
      values (old.studio_id, old.id, 'superseded', old.sms_consent_at, old.sms_consent_source,
              case when old.sms_consent_phone is null or old.sms_consent_phone = '-' then null
                   else pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(old.sms_consent_phone, 'UTF8')), 'hex') end,
              old.sms_consent_text_version);
    end if;
  end if;
  insert into public.client_sms_consent_events (studio_id, client_id, kind, consented_at, source, phone_sha256, text_version)
  values (new.studio_id, new.id, 'recorded', new.sms_consent_at, new.sms_consent_source,
          case when new.sms_consent_phone is null or new.sms_consent_phone = '-' then null
               else pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(new.sms_consent_phone, 'UTF8')), 'hex') end,
          new.sms_consent_text_version);
  return new;
end;
$$;
drop trigger if exists clients_sms_consent_event_writer on public.clients;
create trigger clients_sms_consent_event_writer after insert or update of sms_consent_at on public.clients
  for each row execute function public.clients_sms_consent_event_writer();
revoke all privileges on function public.client_sms_consent_events_guard() from public, anon, authenticated, service_role;
revoke all privileges on function public.clients_sms_consent_event_writer() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The spend-time gate (selection side). GATE POLICY, THE OPEN PRODUCT CHOICE: one predicate line decides what a LEGACY
-- consent (sms_consent_phone null) does.
--   A (this draft): allowed, as today. The number it holds is used until it is changed; the change binds it and then the
--      consent stops covering the new number.
--   B (fail closed): replace the line with  c.sms_consent_phone = c.sms_phone  . Every pre-migration consent stops texting
--      until the client consents again.
-- Both refuse a bound consent whose number no longer matches. The TypeScript gate (passesConsentGate) must carry the same
-- predicate; the parity tests extend to it.
-- ---------------------------------------------------------------------------
create or replace view public.reminder_sms_eligible_appointments
with (security_invoker = true) as
select a.id,
       a.starts_at,
       a.studio_id,
       a.sms_reminder_24h_sent_at,
       a.sms_reminder_2h_sent_at,
       a.sms_reminder_24h_send_attempts,
       a.sms_reminder_2h_send_attempts,
       st.send_24h_sms_reminders,
       st.send_2h_sms_reminders
  from public.appointments a
  join public.studios st on st.id = a.studio_id
  join public.clients  c  on c.id  = a.client_id
 where a.status = 'confirmed'
   and c.sms_phone is not null
   and c.sms_consent_at is not null
   and (c.sms_consent_phone is null or c.sms_consent_phone = c.sms_phone)
   and c.sms_opted_out_at is null;

commit;
