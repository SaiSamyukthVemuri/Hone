-- 0393 down: removes the visit payment ledger tables, their guards and the legacy-refund mirror.
-- REFUSES once any bill, any external payment or any non-legacy refund exists (that is real money history). The legacy
-- refund rows are copies of the attempts' own refund columns, which this migration never changed, so they are dropped
-- with the table and can be rebuilt by re-applying 0393.
begin;
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.visit_bills) then
    raise exception '0393 down: a visit bill exists; refusing' using errcode = '55000';
  end if;
  if exists (select 1 from public.visit_external_payments) then
    raise exception '0393 down: an external payment exists; refusing' using errcode = '55000';
  end if;
  if exists (select 1 from public.payment_refunds where not legacy) then
    raise exception '0393 down: a refund made after 0393 exists; refusing' using errcode = '55000';
  end if;
end;
$$;

drop trigger payment_charge_attempts_refund_mirror_trg on public.payment_charge_attempts;
drop function public.payment_refunds_mirror_attempt();
drop table public.payment_refunds;
drop table public.visit_external_payments;
drop table public.visit_bills;
drop function public.payment_refunds_guard();
drop function public.visit_external_payments_guard();
drop function public.visit_bills_guard();
drop function public.payment_refundable_cents(uuid, uuid);

commit;
