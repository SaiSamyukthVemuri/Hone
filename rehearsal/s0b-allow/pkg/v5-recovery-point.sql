-- S0B (V5) recovery-point consistency. T is the one placeholder. One row per main table:
--   rows_created_le_t  rows created at or before T            (production at T must equal the restored copy)
--   rows_total         all rows                               (restored copy, read with T far in the future: must equal production rows_created_le_t)
--   rows_newer_than_t  rows whose created_at or updated_at is after T  (restored copy: must be 0)
-- updated_at is read through to_jsonb so a table without that column counts as never updated. Counts only.
with p as (select '@@T@@'::timestamptz as t),
r as (
  select 'studios' as table_name, x.created_at as c, (to_jsonb(x)->>'updated_at')::timestamptz as u from public.studios x
  union all select 'clients', x.created_at, (to_jsonb(x)->>'updated_at')::timestamptz from public.clients x
  union all select 'appointments', x.created_at, (to_jsonb(x)->>'updated_at')::timestamptz from public.appointments x
  union all select 'sessions', x.created_at, (to_jsonb(x)->>'updated_at')::timestamptz from public.sessions x
  union all select 'client_consent_signatures', x.created_at, (to_jsonb(x)->>'updated_at')::timestamptz from public.client_consent_signatures x
  union all select 'client_intake_forms', x.created_at, (to_jsonb(x)->>'updated_at')::timestamptz from public.client_intake_forms x
  union all select 'payment_charge_attempts', x.created_at, (to_jsonb(x)->>'updated_at')::timestamptz from public.payment_charge_attempts x
  union all select 'appointment_payments', x.created_at, (to_jsonb(x)->>'updated_at')::timestamptz from public.appointment_payments x
)
select r.table_name,
  count(*) filter (where r.c <= p.t) as rows_created_le_t,
  count(*) as rows_total,
  count(*) filter (where greatest(r.c, coalesce(r.u, r.c)) > p.t) as rows_newer_than_t
from r cross join p
group by r.table_name
order by r.table_name;
