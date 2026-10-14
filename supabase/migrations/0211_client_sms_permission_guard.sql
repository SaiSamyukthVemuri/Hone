-- ===========================================================================
-- 0211 — G3: A STUDIO MEMBER CANNOT MANUFACTURE A CLIENT'S SMS CONSENT OR
--        CLEAR THEIR STOP
-- ===========================================================================
--
-- THE FINDING (G3, 2026-10-11). public.clients carries four SMS fields (0049):
-- sms_consent_at / sms_consent_source, the client's agreement to texts, and
-- sms_opted_out_at / sms_opt_out_source, their STOP. Studio members hold the
-- row-level "clients: members insert" and "clients: members update" policies
-- (0087), the `authenticated` role holds table-wide INSERT and UPDATE, and no
-- trigger guarded these columns. So any signed-in member, with a raw database
-- API request and no screen involved, could:
--   * MANUFACTURE CONSENT: set sms_consent_at on a client who never agreed, and
--     the reminder cron would text them wherever the studio's switches are on;
--   * CLEAR SUPPRESSION: null a client's STOP, and texts would resume to a
--     person who said STOP;
--   * re-time, re-source or erase recorded consent evidence;
--   * insert a new client who arrives already "consenting".
-- No application screen does any of this. Nothing in the database prevented it.
--
-- THE CENSUS (production 6c5eac80, every migration and every application
-- write of these four columns). Exactly three paths write them, and none runs
-- as a member:
--   W1 create_public_appointment_for_new_client (0204), SECURITY DEFINER:
--      INSERTs a new client with consent, source public_booking;
--   W2 the public booking action, service_role: stamps consent on an EXISTING
--      client that has neither consent nor an opt-out, source public_booking;
--   W3 the inbound STOP route, service_role: stamps sms_opted_out_at, source
--      twilio_stop, on every matching client not already opted out.
-- Nothing anywhere clears an opt-out or rewrites recorded consent. Every
-- member-session client write (new client, calendar quick-add, client edit,
-- archive, CSV import) leaves the four fields alone. Production at 17:58Z:
-- 136 clients, 54 consents (all public_booking), 0 opt-outs, 0 rows with one
-- half of a pair set.
--
-- THE RULES. One SECURITY INVOKER trigger, so current_user is the REAL caller
-- (the 0134 / 0136 / 0140 pattern): a SECURITY DEFINER command runs as its
-- owner and a service_role connection as service_role, and both are trusted
-- paths; `anon` and `authenticated` are raw API callers.
--   1. A MEMBER NEVER RECORDS CONSENT. anon / authenticated may not add,
--      change or remove sms_consent_at or sms_consent_source, on insert or
--      update. Consent is recorded only by governed paths (W1, W2, and any
--      future command), which run as the definer or service_role. 42501.
--   2. CONSENT EVIDENCE IS WRITE-ONCE, FOR EVERYONE. Once recorded it is never
--      changed, re-sourced or removed. A withdrawal is an opt-out, never an
--      edit of the consent: the history of what was agreed stays true (0208
--      made the same rule for waitlist entries).
--   3. AN OPT-OUT IS TERMINAL, FOR EVERYONE. Never cleared, re-timed or
--      re-sourced. STOP wins, as it already does for waitlist entries (0203).
--   4. A MEMBER MAY RECORD A WITHDRAWAL. Adding an opt-out where there is none
--      is the protective direction and stays open to members, with source
--      'practitioner' only (a member cannot claim it was a Twilio STOP), and
--      stamped by the database clock (a member cannot back- or post-date it).
--
-- WHAT STAYS EXACTLY AS IT WAS:
--   * W1, W2 and W3, which only ever add, as trusted roles;
--   * every other column of clients: members still edit names, phones, notes;
--   * row-level security and every policy on clients;
--   * the inbound STOP route and its phone-wide reach;
--   * privileged writers adding a field (fixtures, operator SQL) keep the
--     existing shape rules, which are only the 0049 source CHECKs.
--
-- NOT IN SCOPE, each a separate decision:
--   * what a PHONE CHANGE means for recorded consent;
--   * a screen or command for an owner to record a client's withdrawal;
--   * waitlist entries, which 0185 (no table privilege for any role) and the
--     0203 / 0208 guard already protect.
--
-- NO DATA IS WRITTEN. The trigger validates changes only. No existing row is
-- read for rewriting, and no constraint is added that existing rows must meet.
-- The trigger fires on INSERT, and on an UPDATE that names one of the four
-- columns, so an ordinary client edit never reaches it.
-- ===========================================================================

begin;
set local lock_timeout = '5s';

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
    if old.sms_consent_at is not null or old.sms_consent_source is not null then
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

drop trigger if exists clients_sms_permission_guard on public.clients;
create trigger clients_sms_permission_guard
  before insert or update of sms_consent_at, sms_consent_source, sms_opted_out_at, sms_opt_out_source
  on public.clients
  for each row
  execute function public.clients_sms_permission_guard();

-- A trigger function cannot be called directly; its privileges are restated
-- anyway, as 0206 and 0210 do for their guards, so no role holds a grant it
-- could never use.
revoke all privileges on function public.clients_sms_permission_guard()
  from public, anon, authenticated, service_role;

comment on function public.clients_sms_permission_guard() is
  'G3 (0211). Guards the four client SMS fields. A raw API caller (anon / authenticated) can never add, change or remove SMS consent (42501), and may add an opt-out only as a withdrawal: source practitioner, stamped by the database clock. For every role, recorded consent evidence is write-once and an opt-out is terminal. SECURITY INVOKER, so current_user is the real caller: SECURITY DEFINER commands and service_role connections are the governed paths.';
comment on trigger clients_sms_permission_guard on public.clients is
  'G3 (0211). Fires on INSERT and on any UPDATE naming sms_consent_at, sms_consent_source, sms_opted_out_at or sms_opt_out_source. See public.clients_sms_permission_guard().';

commit;
