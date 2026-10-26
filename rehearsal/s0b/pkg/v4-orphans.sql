-- S0B (V4) orphan checks over rows created at or before T. Every value must be 0 on both sides. T is the one placeholder.
-- Counts only.
with p as (select '@@T@@'::timestamptz as t)
select
  (select count(*) from public.appointments a cross join p where a.created_at <= p.t and not exists (select 1 from public.clients c where c.id = a.client_id)) as appointments_without_client,
  (select count(*) from public.appointment_payments x cross join p where x.created_at <= p.t and not exists (select 1 from public.appointments a where a.id = x.appointment_id)) as payments_without_appointment,
  (select count(*) from public.payment_charge_attempts x cross join p where x.created_at <= p.t and x.appointment_id is not null and not exists (select 1 from public.appointments a where a.id = x.appointment_id)) as charge_attempts_without_appointment,
  (select count(*) from public.clients x cross join p where x.created_at <= p.t and not exists (select 1 from public.studios s where s.id = x.studio_id)) as clients_without_studio,
  (select count(*) from public.appointments x cross join p where x.created_at <= p.t and not exists (select 1 from public.studios s where s.id = x.studio_id)) as appointments_without_studio,
  (select count(*) from public.sessions x cross join p where x.created_at <= p.t and not exists (select 1 from public.studios s where s.id = x.studio_id)) as sessions_without_studio,
  (select count(*) from public.client_consent_signatures x cross join p where x.created_at <= p.t and not exists (select 1 from public.studios s where s.id = x.studio_id)) as consents_without_studio,
  (select count(*) from public.client_intake_forms x cross join p where x.created_at <= p.t and not exists (select 1 from public.studios s where s.id = x.studio_id)) as intake_forms_without_studio,
  (select count(*) from public.payment_charge_attempts x cross join p where x.created_at <= p.t and not exists (select 1 from public.studios s where s.id = x.studio_id)) as charge_attempts_without_studio,
  (select count(*) from public.appointment_payments x cross join p where x.created_at <= p.t and not exists (select 1 from public.studios s where s.id = x.studio_id)) as appointment_payments_without_studio;
