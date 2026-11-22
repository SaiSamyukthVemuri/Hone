-- DOWN for the SMS consent number binding. Restores the previous eligibility view (same columns), then removes the binding
-- trigger, its function, the constraints and the two columns. It REFUSES while any client holds binding evidence: dropping
-- the columns would destroy what a client agreed to and for which number.
begin;
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.client_sms_consent_events) or exists (select 1 from public.clients where sms_consent_phone is not null or sms_consent_text_version is not null) then
    raise exception 'refusing: SMS consent binding evidence or consent events exist; nothing is dropped' using errcode = 'check_violation';
  end if;
end $$;

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
   -- THE CLIENT GATES. A row failing any of these is skipped by the route with
   -- a bare `continue` -- no send, no claim, no state change -- so its
   -- eligibility is unchanged and it re-occupies the same page slot on every
   -- later pass. Excluding it from selection is what stops it starving a
   -- sendable appointment behind it.
   --
   -- STILL NOT AUTHORITY. Consent and opt-out change between selection and
   -- send; `passesConsentGate` re-reads all three immediately before the send
   -- and refuses on its own, so a consent withdrawn or a STOP received in that
   -- window is honoured there, not here.
   and c.sms_phone is not null
   and c.sms_consent_at is not null
   and c.sms_opted_out_at is null;

-- The previous 0211 guard, byte for byte (comments inside the body are part of the stored source).
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

drop trigger if exists clients_sms_consent_event_writer on public.clients;
drop function if exists public.clients_sms_consent_event_writer();
drop table if exists public.client_sms_consent_events;
drop function if exists public.client_sms_consent_events_guard();
drop trigger if exists clients_sms_consent_binding on public.clients;
drop function if exists public.clients_sms_consent_binding_guard();
alter table public.clients
  drop constraint if exists clients_sms_consent_text_version_check,
  drop constraint if exists clients_sms_consent_evidence_check,
  drop constraint if exists clients_sms_consent_phone_shape_check;
alter table public.clients
  drop column if exists sms_consent_phone,
  drop column if exists sms_consent_text_version;

commit;
