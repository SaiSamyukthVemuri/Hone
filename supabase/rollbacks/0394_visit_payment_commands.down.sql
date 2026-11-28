-- 0394 DOWN: remove the visit payment commands, the card wall, the attempt columns and the split_payments rollout key.
-- REFUSES (55000, changing nothing) while any bill, external payment or non-legacy refund exists, any attempt carries a bill or a submission id,
-- or the split_payments key is not off with no studio listed: those are records of money that was split.
begin;
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.visit_bills) or exists (select 1 from public.visit_external_payments)
     or exists (select 1 from public.payment_refunds where not legacy) then
    raise exception '0394 down: visit bills, payments or refunds exist; refusing' using errcode = '55000';
  end if;
  if exists (select 1 from public.payment_refund_reviews) then
    raise exception '0394 down: a refund review exists; refusing' using errcode = '55000';
  end if;
  if exists (select 1 from public.payment_charge_attempts where visit_bill_id is not null or submission_id is not null) then
    raise exception '0394 down: card attempts carry a bill or a submission id; refusing' using errcode = '55000';
  end if;
  if exists (select 1 from public.platform_rollout_studios where rollout_key = 'split_payments')
     or exists (select 1 from public.platform_rollouts where key = 'split_payments' and mode <> 'off') then
    raise exception '0394 down: the split_payments key is in use; refusing' using errcode = '55000';
  end if;
end;
$$;

drop trigger appointment_settlements_visit_bill_guard_trg on public.appointment_settlements;
drop function public.appointment_settlements_visit_bill_guard();
drop trigger payment_charge_attempts_visit_bill_guard_trg on public.payment_charge_attempts;
drop function public.payment_charge_attempts_visit_bill_guard();
drop function public.cancel_split_card_attempt(uuid, uuid, text);
drop function public.finish_payment_refund(uuid, text, text, text, text, text, integer);
drop function public.request_payment_refund(uuid, uuid, uuid, uuid, integer, text, text, uuid);
drop function public.visit_bill_supersede(uuid, uuid, integer, text, uuid);
drop function public.void_visit_external_payment(uuid, uuid, text);
drop function public.confirm_visit_external_payment(uuid, uuid);
drop function public.record_visit_external_payment(uuid, uuid, text, integer, uuid, text);
drop function public.ensure_visit_bill(uuid, uuid, integer, text, boolean);
drop function public.get_visit_payment_positions(uuid, uuid[]);
drop function public.resolve_payment_refund_review(uuid);
drop function public.flag_payment_refund_review(uuid, text, text, integer, text, text, bigint, text, text);
drop function public.record_refund_sent(uuid, text);
drop function public.get_visit_payment_position(uuid, uuid);
drop function public.visit_payment_refusal(uuid, uuid, integer, boolean);
drop function public.visit_payment_position(uuid, uuid);
drop index public.payment_charge_attempts_live_succeeded_idx;
drop function public.card_counts_toward_capacity(uuid, boolean);
drop function public.studio_has_gone_live(uuid);

drop index public.payment_charge_attempts_active_session_payment_uniq;
create unique index payment_charge_attempts_active_session_payment_uniq
  on public.payment_charge_attempts (session_id, stripe_livemode)
  where session_id is not null
    and charge_reason = 'session_payment'
    and status in ('ready', 'pending_stripe', 'succeeded');
drop index public.payment_charge_attempts_submission_key;
alter table public.payment_charge_attempts drop column visit_bill_id;
alter table public.payment_charge_attempts drop column submission_id;

delete from public.platform_rollouts where key = 'split_payments';
alter table public.platform_rollouts drop constraint platform_rollouts_split_payments_mode_check;
alter table public.platform_rollouts drop constraint platform_rollouts_key_check;
do $$
begin
  if exists (select 1 from public.platform_rollouts where key = 'front_desk') then
    alter table public.platform_rollouts add constraint platform_rollouts_key_check check (key in ('charting_new_view_xcell', 'front_desk'));
  else
    alter table public.platform_rollouts add constraint platform_rollouts_key_check check (key in ('charting_new_view_xcell'));
  end if;
end;
$$;
commit;
