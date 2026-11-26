-- Down for 0338: drop the cross-type one-fee index. Rollback only; never run against a hosted database without approval.
-- This re-opens the cross-type race (the 0105 same-type index remains). No data is touched.
begin;
set local lock_timeout = '5s';

drop index if exists public.payment_charge_attempts_one_fee_per_appointment_uniq;

commit;
