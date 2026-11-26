-- Keep any recorded negotiated price and its audit evidence. Once used, the
-- schema stays in place while the application can revert independently.
begin;
set local lock_timeout = '5s';
lock table public.appointment_settlements in access exclusive mode;
do $$
begin
  if exists (select 1 from public.appointment_settlements where reference_fee_cents is not null) then
    raise exception 'Adjusted settlements exist. Keep their fee history and roll back the application only.';
  end if;
end;
$$;
drop function public.record_adjusted_appointment_settlement(uuid,uuid,text,integer,text,boolean,integer,integer,text);
drop trigger preserve_settlement_fee_adjustment on public.appointment_settlements;
drop function public.preserve_settlement_fee_adjustment();
alter table public.appointment_settlements
  drop constraint appointment_settlements_adjustment_evidence,
  drop column reference_fee_cents,
  drop column fee_adjustment_reason;
commit;
