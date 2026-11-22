-- DOWN for the SMS consent number binding. Restores the previous eligibility view (same columns), then removes the binding
-- trigger, its function, the constraints and the two columns. It REFUSES while any client holds binding evidence: dropping
-- the columns would destroy what a client agreed to and for which number.
begin;
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.clients where sms_consent_phone is not null or sms_consent_text_version is not null) then
    raise exception 'refusing: clients hold SMS consent binding evidence; nothing is dropped' using errcode = 'check_violation';
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
