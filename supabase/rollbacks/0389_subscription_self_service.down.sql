begin;
set local lock_timeout = '5s';
lock table public.hone_signup_attempts in access exclusive mode;
do $$ begin
  if exists(select from public.hone_signup_attempts where restart_id is not null or change_id is not null or canceled_at is not null)
    then raise exception 'subscription_change_history_present'; end if;
end $$;
drop function public.claim_hone_restart(uuid,uuid,uuid),public.apply_hone_restart_invoice(text,uuid,uuid,text,text,text,text,text,timestamptz,uuid);
drop function public.read_hone_billing_provider_ids(uuid,uuid), public.my_hone_solo_impact(uuid), public.request_hone_subscription_change(uuid,text,uuid,text),public.my_hone_studio_canceled(uuid),
  public.claim_hone_subscription_change(uuid),public.finish_hone_subscription_change(uuid,boolean),
  public.record_hone_subscription_canceled(text,text,uuid,uuid);
create or replace function public.check_hone_new_work_allowed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  lock_at timestamptz;
begin
  select min(i.failed_at + interval '168 hours') into lock_at
  from public.hone_signup_attempts a join public.hone_renewal_invoices i on i.attempt_id=a.id
  where a.studio_id=new.studio_id and not i.paid and i.failed_at is not null;
  if lock_at is null or now() < lock_at then return new; end if;
  if tg_table_name = 'sessions' then
    if new.appointment_id is not null and exists (
      select 1 from public.appointments ap where ap.id=new.appointment_id and ap.created_at < lock_at) then
      return new;
    end if;
  end if;
  raise exception 'subscription_payment_required';
end $$;

create or replace function public.my_hone_billing_status(p_studio uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('plan', a.plan,
    'invoice', overdue.invoice_id, 'deadline', overdue.deadline, 'status', case
      when overdue.invoice_id is null then 'active'
      when now() >= overdue.deadline then 'paused'
      else 'past_due' end)
  from public.hone_signup_attempts a
  left join lateral (
    select i.invoice_id, i.failed_at + interval '168 hours' as deadline
    from public.hone_renewal_invoices i
    where i.attempt_id=a.id and not i.paid and i.failed_at is not null
    order by i.failed_at, i.invoice_id limit 1
  ) overdue on true
  where a.studio_id=p_studio and exists (select 1 from public.practitioners p where p.studio_id=a.studio_id
    and p.user_id=auth.uid() and p.role='owner' and p.active);
$$;

create or replace function public.hone_team_seat_counts(p_studio uuid)
returns table(plan text, practitioner_used int, practitioner_limit int, receptionist_used int, receptionist_limit int)
language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select a.plan,
    (select count(*) from public.practitioners p where p.studio_id=a.studio_id and p.active)::int + pending.clinical,
    case a.plan when 'solo' then 1 when 'studio' then 3 end,
    (select count(*) from public.studio_receptionists r where r.studio_id=a.studio_id and r.active)::int + pending.desk,
    public.front_desk_seat_limit(a.studio_id)
  from public.hone_signup_attempts a
  cross join lateral (
    select count(*) filter (where i.role is distinct from 'receptionist')::int as clinical,
           count(*) filter (where i.role='receptionist')::int as desk
    from public.pending_invitations i where i.studio_id=a.studio_id and i.status='pending'
  ) pending
  where a.state='paid' and a.studio_id=p_studio;
end $$;

create or replace function public.apply_hone_billing_invoice(p_event text, p_attempt uuid, p_user uuid, p_plan text,
  p_customer text, p_subscription text, p_invoice text, p_kind text, p_event_at timestamptz)
returns text language plpgsql security definer set search_path = '' as $$
declare
  a public.hone_signup_attempts;
  new_studio uuid;
  verified_email text;
begin
  if p_kind not in ('initial_paid','renewal_failed','renewal_paid') or
    nullif(p_customer,'') is null or nullif(p_subscription,'') is null or nullif(p_invoice,'') is null
    then raise exception 'invalid_billing_invoice'; end if;
  select * into a from public.hone_signup_attempts where id=p_attempt for update;
  if not found or a.user_id<>p_user or a.plan<>p_plan or a.state='expired'
     or (a.customer_id is not null and a.customer_id<>p_customer)
     or (a.subscription_id is not null and a.subscription_id<>p_subscription)
    then return 'refused'; end if;
  if p_kind<>'initial_paid' and a.state<>'paid' then return 'retry_after_initial'; end if;
  insert into public.hone_billing_events values(p_event) on conflict do nothing;
  if not found then return 'duplicate'; end if;
  if p_kind='initial_paid' then
    if a.state='paid' then return 'already_provisioned'; end if;
    select email into strict verified_email from auth.users where id=a.user_id and email_confirmed_at is not null;
    insert into public.studios(name,owner_email,slug) values(a.studio_name,verified_email,
      'studio-' || gen_random_uuid()::text) returning id into new_studio;
    insert into public.practitioners(studio_id,user_id,display_name,email,role,active)
      values(new_studio,a.user_id,a.owner_name,verified_email,'owner',true);
    update public.hone_signup_attempts set state='paid',studio_id=new_studio,customer_id=p_customer,
      subscription_id=p_subscription,session_url=null where id=a.id;
    insert into public.hone_subscription_notices(attempt_id,invoice_id,kind) values(a.id,p_invoice,'receipt');
    return 'provisioned';
  end if;
  insert into public.hone_renewal_invoices as i(invoice_id,attempt_id,failed_at,paid,settled_at)
  values(p_invoice,a.id,case when p_kind='renewal_failed' then p_event_at end,p_kind='renewal_paid',case when p_kind='renewal_paid' then now() end)
  on conflict(invoice_id) do update set paid=i.paid or excluded.paid,
    settled_at=coalesce(i.settled_at,excluded.settled_at),failed_at=least(i.failed_at,excluded.failed_at) where i.attempt_id=excluded.attempt_id;
  if not found then raise exception 'invoice_binding_mismatch'; end if;
  if p_kind='renewal_paid' then
    insert into public.hone_subscription_notices(attempt_id,invoice_id,kind)
      values(a.id,p_invoice,'receipt') on conflict do nothing;
  else
    insert into public.hone_subscription_notices(attempt_id,invoice_id,kind)
      values(a.id,p_invoice,'warning'),(a.id,p_invoice,'paused') on conflict do nothing;
  end if;
  return 'recorded';
end $$;

create or replace view public.hone_due_subscription_notices with (security_invoker=true) as
select n.id, n.kind, n.invoice_id, a.customer_id, a.subscription_id, a.plan,
  u.email as recipient, s.timezone,
  i.failed_at + interval '168 hours' as deadline
from public.hone_subscription_notices n
join public.hone_signup_attempts a on a.id=n.attempt_id and a.state='paid'
join auth.users u on u.id=a.user_id and u.email_confirmed_at is not null
join public.studios s on s.id=a.studio_id
left join public.hone_renewal_invoices i on i.invoice_id=n.invoice_id and i.attempt_id=a.id
where n.sent_at is null and exists (
  select 1 from public.practitioners p where p.studio_id=a.studio_id
    and p.user_id=u.id and p.active and p.role='owner'
) and (n.kind='receipt' or (
  not i.paid and i.failed_at is not null
  and (n.kind='paused') = (now() >= i.failed_at + interval '168 hours')
  and not exists (
    select 1 from public.hone_renewal_invoices older where older.attempt_id=a.id and not older.paid
    and (older.failed_at,older.invoice_id) < (i.failed_at,i.invoice_id)
  )
  and not exists (
    select 1 from public.hone_subscription_notices prior
    join public.hone_renewal_invoices prior_invoice on prior_invoice.invoice_id=prior.invoice_id
    where prior.attempt_id=a.id and prior.kind='paused' and prior.sent_at is not null
      and prior.invoice_id<>i.invoice_id and prior_invoice.failed_at<=i.failed_at
      and (prior_invoice.settled_at is null or prior_invoice.settled_at >= i.failed_at + interval '168 hours')
  )
));

alter table public.hone_signup_attempts drop column change_id, drop column change_target,
  drop column retry_change_at, drop column canceled_at, drop column restart_id, drop column restart_started_at;
alter table public.hone_renewal_invoices drop column former_subscription;
alter table public.hone_subscription_notices drop column former_subscription;
commit;
