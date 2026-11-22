-- ===========================================================================
-- 0368: A CLIENT'S SMS CONSENT IS BOUND TO THE NUMBER IT WAS GIVEN FOR
-- ===========================================================================
-- DRAFT, UNSEALED, authorizes_nothing: true. Not applied anywhere.
--
-- The problem. clients.sms_consent_at records THAT a client agreed to texts, not WHICH number they agreed for, and a studio
-- member may edit clients.phone freely. Every send gate reads the current phone beside the old consent, so a corrected,
-- replaced or later-added number inherits a consent that was never given for it.
--
-- What this does, in three parts (the draft ships all three; Part 2 carries the one open product choice, marked below).
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
-- The binding trigger. SECURITY INVOKER, so current_user is the real caller (the 0211 pattern): anon and authenticated are
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
    if v_member and (new.sms_consent_phone is not null or new.sms_consent_text_version is not null) then
      raise exception 'clients: SMS consent evidence is recorded only by governed paths (role %)', current_user using errcode = '42501';
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
  if v_member and (new.sms_consent_phone is distinct from old.sms_consent_phone
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

  -- a consent already exists: its evidence is write-once
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
  before insert or update of phone, sms_consent_at, sms_consent_phone, sms_consent_text_version
  on public.clients
  for each row
  execute function public.clients_sms_consent_binding_guard();

revoke all privileges on function public.clients_sms_consent_binding_guard() from public, anon, authenticated, service_role;

comment on function public.clients_sms_consent_binding_guard() is
  'Binds a client''s SMS consent to the number it was given for, in the same statement that records it. Consent with no sendable number is refused. Evidence is write-once; a legacy consent is bound to its number at the first change of that number. Raw API callers can never set the evidence.';

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
