-- S0B (V7) per-table digest of the sorted primary-key ids of rows created at or before T. T is the one placeholder.
-- The ids are never returned: only the count and an md5 of the sorted id list (uuid order, collation independent).
with p as (select '@@T@@'::timestamptz as t),
k as (
  select 'studios' as table_name, x.id as k, x.created_at as c from public.studios x
  union all select 'clients', x.id, x.created_at from public.clients x
  union all select 'appointments', x.id, x.created_at from public.appointments x
  union all select 'sessions', x.id, x.created_at from public.sessions x
  union all select 'client_consent_signatures', x.id, x.created_at from public.client_consent_signatures x
  union all select 'client_intake_forms', x.id, x.created_at from public.client_intake_forms x
  union all select 'payment_charge_attempts', x.id, x.created_at from public.payment_charge_attempts x
  union all select 'appointment_payments', x.appointment_id, x.created_at from public.appointment_payments x
)
select k.table_name, count(*) as ids, md5(string_agg(k.k::text, ',' order by k.k)) as ids_md5
from k cross join p
where k.c <= p.t
group by k.table_name
order by k.table_name;
