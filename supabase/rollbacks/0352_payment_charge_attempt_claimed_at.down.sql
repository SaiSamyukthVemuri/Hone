-- Down for 0352. Drops the claimed_at guard trigger, its function and the claimed_at column (the stamps are lost). Touches
-- nothing else. After this the stuck-fee sweep must not be deployed with its claimed_at read (it would fail closed with a
-- critical alert and a non-200 result).
begin;

set local lock_timeout = '5s';

drop trigger if exists payment_charge_attempts_claimed_at_guard on public.payment_charge_attempts;
drop function if exists public.payment_charge_attempts_claimed_at_guard();
alter table public.payment_charge_attempts drop column if exists claimed_at;

commit;
