-- Disable new signup first. Refuse a destructive rollback with outstanding purchases.
begin;
set local lock_timeout = '5s';
lock table public.hone_signup_attempts in access exclusive mode;
do $$ begin
  if exists (select 1 from public.hone_signup_attempts where state <> 'expired') then
    raise exception 'billing_history_present: preserve purchase and entitlement records';
  end if;
end $$;
drop function public.finish_hone_subscription_notice(uuid,uuid),
  public.authorize_hone_subscription_notice(uuid,uuid,text,text,timestamptz),public.claim_hone_subscription_notice(text);
drop view public.hone_due_subscription_notices;
drop table public.hone_subscription_notices;
drop trigger subscription_allows_new_booking on public.appointments;
drop trigger subscription_allows_new_chart on public.sessions;
drop trigger subscription_allows_new_block on public.session_blocks;
drop trigger subscription_allows_new_electrolysis on public.electrolysis_entries;
drop trigger subscription_allows_new_laser on public.laser_entries;
drop function public.check_hone_new_work_allowed();
drop function public.my_hone_billing_status(uuid);
drop function public.apply_hone_billing_invoice(text,uuid,uuid,text,text,text,text,text,timestamptz);
drop function public.claim_hone_signup(uuid,text,text,text);
drop function public.bind_hone_checkout(uuid,uuid,text,text);
drop function public.expire_hone_checkout(uuid,uuid,text);
drop table public.hone_renewal_invoices,public.hone_billing_events,public.hone_signup_attempts;
commit;
