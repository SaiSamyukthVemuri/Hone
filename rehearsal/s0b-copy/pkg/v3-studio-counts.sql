-- S0B (V3) per-studio-ordinal row counts, only rows created at or before T (the recovery timestamp).
-- T is the one placeholder below; s0b-validate.sh replaces it with a UTC time it validated against a strict pattern, and the
-- comparator checks that the file that actually ran equals this template with exactly that one substitution.
-- Studios are numbered 1..N by (created_at, id); no studio id is returned. Counts only.
with p as (select '@@T@@'::timestamptz as t),
st as (
  select s.id, row_number() over (order by s.created_at, s.id) as studio_ordinal
  from public.studios s cross join p where s.created_at <= p.t
)
select st.studio_ordinal,
  (select count(*) from public.clients x cross join p where x.studio_id = st.id and x.created_at <= p.t) as clients,
  (select count(*) from public.appointments x cross join p where x.studio_id = st.id and x.created_at <= p.t) as appointments,
  (select count(*) from public.sessions x cross join p where x.studio_id = st.id and x.created_at <= p.t) as sessions,
  (select count(*) from public.client_consent_signatures x cross join p where x.studio_id = st.id and x.created_at <= p.t) as consents,
  (select count(*) from public.client_intake_forms x cross join p where x.studio_id = st.id and x.created_at <= p.t) as intake_forms,
  (select count(*) from public.payment_charge_attempts x cross join p where x.studio_id = st.id and x.created_at <= p.t) as charge_attempts,
  (select count(*) from public.appointment_payments x cross join p where x.studio_id = st.id and x.created_at <= p.t) as appointment_payments
from st
order by st.studio_ordinal;
