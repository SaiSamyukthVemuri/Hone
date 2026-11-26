begin;
set local lock_timeout = '5s';
alter table public.hone_signup_attempts
  add column restart_id uuid unique,
  add column restart_started_at timestamptz,
  add column change_id uuid,
  add column change_target text check (change_target in ('solo','studio','cancel')),
  add column retry_change_at timestamptz,
  add column canceled_at timestamptz;
alter table public.hone_renewal_invoices add column former_subscription text;
alter table public.hone_subscription_notices add column former_subscription text;
create index hone_pending_subscription_changes on public.hone_signup_attempts(retry_change_at) where change_target is not null;


create or replace function public.check_hone_new_work_allowed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  target_studio uuid;
begin
  if tg_table_name in ('electrolysis_entries','laser_entries') then
    select s.studio_id into target_studio from public.sessions s where s.id=new.session_id;
  else
    target_studio := new.studio_id;
  end if;
  if exists (select 1 from public.hone_signup_attempts where studio_id=target_studio
      and (canceled_at is not null or change_target='cancel')) then
    raise exception 'subscription_canceled';
  end if;
  if exists (select 1 from public.hone_signup_attempts a join public.hone_renewal_invoices i on i.attempt_id=a.id
    where a.studio_id=target_studio and i.former_subscription is null and not i.paid and now() >= i.failed_at + interval '168 hours')
    then raise exception 'subscription_payment_required'; end if;
  return new;
end $$;

create or replace function public.my_hone_billing_status(p_studio uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('plan', a.plan, 'customer', a.customer_id, 'subscription', a.subscription_id,
    'change_id',a.change_id,'pending',a.change_target,'canceled_at',a.canceled_at,
    'invoice', overdue.invoice_id, 'deadline', overdue.deadline, 'status', case
      when a.canceled_at is not null then 'canceled'
      when a.change_target='cancel' then 'canceling'
      when overdue.invoice_id is null then 'active'
      when now() >= overdue.deadline then 'paused'
      else 'past_due' end)
  from public.hone_signup_attempts a
  left join lateral (
    select i.invoice_id, i.failed_at + interval '168 hours' as deadline
    from public.hone_renewal_invoices i
    where i.attempt_id=a.id and i.former_subscription is null and not i.paid and i.failed_at is not null
    order by i.failed_at, i.invoice_id limit 1
  ) overdue on true
  where a.studio_id=p_studio and exists (select 1 from public.practitioners p where p.studio_id=a.studio_id
    and p.user_id=auth.uid() and p.role='owner' and p.active);
$$;

create or replace function public.hone_team_seat_counts(p_studio uuid)
returns table(plan text, practitioner_used int, practitioner_limit int, receptionist_used int, receptionist_limit int)
language sql stable security definer set search_path = '' as $$
  select a.plan,
    (select count(*) from public.practitioners p where p.studio_id=a.studio_id and p.active)::int + pending.clinical,
    case when a.plan='solo' or a.change_target='solo' then 1 when a.plan='studio' then 3 end,
    (select count(*) from public.studio_receptionists r where r.studio_id=a.studio_id and r.active)::int + pending.desk,
    case when a.plan='solo' or a.change_target='solo' then 0 when a.plan='studio' then 1 end
  from public.hone_signup_attempts a
  cross join lateral (
    select count(*) filter (where i.role is distinct from 'receptionist')::int as clinical,
           count(*) filter (where i.role='receptionist')::int as desk
    from public.pending_invitations i where i.studio_id=a.studio_id and i.status='pending'
  ) pending
  where a.state='paid' and a.studio_id=p_studio;
$$;

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
  if not found or a.user_id<>p_user or (p_kind='initial_paid' and a.state<>'paid' and a.plan<>p_plan) or a.state='expired'
     or (a.customer_id is not null and a.customer_id<>p_customer)
     or (a.subscription_id is not null and a.subscription_id<>p_subscription)
    then return 'refused'; end if;
  if p_kind<>'initial_paid' and a.state<>'paid' then return 'retry_after_initial'; end if;
  insert into public.hone_billing_events values(p_event) on conflict do nothing;
  if not found then return 'duplicate'; end if;
  if p_kind='initial_paid' then
    if a.state='paid' then return 'already_provisioned'; end if;
    select email into strict verified_email from auth.users where id=a.user_id and email_confirmed_at is not null;
    insert into public.studios(name,owner_email,onboarding_v2_enabled,slug) values(a.studio_name,verified_email,true,
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
select n.id, n.kind, n.invoice_id, a.customer_id, coalesce(n.former_subscription,a.subscription_id) as subscription_id, a.plan,
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
  n.former_subscription is null and a.canceled_at is null and a.change_target is distinct from 'cancel' and i.former_subscription is null and not i.paid and i.failed_at is not null
  and (n.kind='paused') = (now() >= i.failed_at + interval '168 hours')
  and not exists (
    select 1 from public.hone_renewal_invoices older where older.attempt_id=a.id and older.former_subscription is null and not older.paid
    and (older.failed_at,older.invoice_id) < (i.failed_at,i.invoice_id)
  )
  and not exists (
    select 1 from public.hone_subscription_notices prior
    join public.hone_renewal_invoices prior_invoice on prior_invoice.invoice_id=prior.invoice_id
    where prior.attempt_id=a.id and prior.former_subscription is null and prior.kind='paused' and prior.sent_at is not null
      and prior.invoice_id<>i.invoice_id and prior_invoice.failed_at<=i.failed_at
      and (prior_invoice.settled_at is null or prior_invoice.settled_at >= i.failed_at + interval '168 hours')
  )
));



-- Preview only this paid studio's affected team. Never expose the list to staff.
create function public.my_hone_solo_impact(p_studio uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select roster || jsonb_build_object('version', md5(roster::text)) from (
    select jsonb_build_object(
      'owner', keeper.display_name, 'can_confirm', a.user_id = auth.uid(),
      'members', coalesce((
        select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'role', m.role) order by m.name,m.id)
        from (
          select p.id,p.display_name as name,p.role from public.practitioners p
          where p.studio_id=a.studio_id and p.active and p.id<>keeper.id
          union all
          select r.id,r.display_name,'receptionist' from public.studio_receptionists r
          where r.studio_id=a.studio_id and r.active
        ) m
      ),'[]'::jsonb),
      'invitations',coalesce((select jsonb_agg(i.email order by i.email,i.id)
        from public.pending_invitations i where i.studio_id=a.studio_id and i.status='pending'),'[]'::jsonb)) as roster
    from public.hone_signup_attempts a join public.practitioners keeper
      on keeper.studio_id=a.studio_id and keeper.user_id=a.user_id and keeper.active and keeper.role='owner'
    where a.studio_id=p_studio and a.state='paid' and a.plan='studio' and public.is_studio_owner(p_studio)
  ) current_team;
$$;

-- Only an active owner can submit a decision. The ledger row also serializes seat acquisition.
create function public.request_hone_subscription_change(p_studio uuid,p_target text,p_version uuid,p_team_version text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.hone_signup_attempts;
begin
  if p_target is null or p_target not in ('solo','studio','cancel') then return null; end if;
  select * into a from public.hone_signup_attempts where studio_id=p_studio and state='paid'
    and public.is_studio_owner(p_studio) for update;
  if not found then return null; end if;
  if a.canceled_at is not null then return jsonb_build_object('result','canceled'); end if;
  if p_target='solo' and a.user_id<>auth.uid() then
    return jsonb_build_object('result','billing_owner'); end if;
  if a.change_target=p_target then return jsonb_build_object('result','pending','id',a.change_id); end if;
  if a.change_id is distinct from p_version or (a.change_target is not null and p_target<>'cancel') then
    return jsonb_build_object('result','stale'); end if;
  if p_target=a.plan then return jsonb_build_object('result','unchanged'); end if;
  if p_target='solo' and (p_team_version is null or
      p_team_version is distinct from (public.my_hone_solo_impact(p_studio)->>'version')) then
    return jsonb_build_object('result','team_changed');
  end if;
  if p_target<>'cancel' and exists(select from public.hone_renewal_invoices where attempt_id=a.id and former_subscription is null and not paid and failed_at is not null)
    then return jsonb_build_object('result','overdue'); end if;
  update public.hone_signup_attempts set change_id=gen_random_uuid(),change_target=p_target,retry_change_at=now()
    where id=a.id returning * into a;
  return jsonb_build_object('result','pending','id',a.change_id);
end $$;

-- Claim a durable decision for immediate execution or background retry after an interrupted request.
create function public.claim_hone_subscription_change(p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.hone_signup_attempts;
begin
  select * into a from public.hone_signup_attempts where change_target is not null
    and (p_id is null or change_id=p_id) and retry_change_at<=now()
    order by retry_change_at limit 1 for update skip locked;
  if not found then return null; end if;
  update public.hone_signup_attempts set retry_change_at=now()+interval '1 minute' where id=a.id;
  return jsonb_build_object('id',a.change_id,'target',a.change_target,'plan',a.plan,'user',a.user_id,
    'attempt',a.id,'subscription',a.subscription_id,'customer',a.customer_id);
end $$;

create function public.finish_hone_subscription_change(p_id uuid,p_applied boolean) returns boolean
language plpgsql security definer set search_path='' as $$
declare
  a public.hone_signup_attempts;
  keeper uuid;
  desk record;
  result text;
begin
  select * into a from public.hone_signup_attempts where change_id=p_id and change_target is not null;
  if not found then return false; end if;
  if p_applied and a.change_target='solo' then
    select id into strict keeper from public.practitioners
      where studio_id=a.studio_id and user_id=a.user_id and role='owner' and active;
    -- Follow the ordinary staff-removal lock order before locking the billing request.
    if public.lock_studio_and_assert_owner(a.studio_id,keeper)<>'ok' then
      raise exception 'billing_owner_changed';
    end if;
  end if;
  select * into a from public.hone_signup_attempts
    where change_id=p_id and change_target is not null for update;
  if not found then return false; end if;

  if keeper is not null then
    -- Stripe accepted the change. Revoke every outstanding seat and switch tier
    -- in one transaction. Membership IDs and all historical assignments survive.
    perform 1 from public.practitioners where id=keeper and studio_id=a.studio_id
      and user_id=a.user_id and role='owner' and active for update;
    if not found then raise exception 'billing_owner_changed'; end if;
    update public.pending_invitations set status='revoked'
      where studio_id=a.studio_id and status='pending';
    for desk in select id from public.studio_receptionists where studio_id=a.studio_id and active order by id loop
      result := public.set_studio_receptionist_active(a.studio_id,keeper,desk.id,false);
      if result not in ('updated','no_change') then raise exception 'desk_membership_changed'; end if;
    end loop;
    update public.practitioners set active=false
      where studio_id=a.studio_id and active and id<>keeper;
  end if;
  update public.hone_signup_attempts set
    plan=case when p_applied and change_target in ('solo','studio') then change_target else plan end,
    canceled_at=case when p_applied and change_target='cancel' then coalesce(canceled_at,now()) else canceled_at end,
    change_target=null,retry_change_at=null where change_id=p_id;
  return true;
end $$;

-- Stripe can also cancel the subscription outside an interactive request. Cancellation is terminal.
create function public.record_hone_subscription_canceled(p_subscription text,p_customer text,p_attempt uuid,p_user uuid)
returns boolean language sql security definer set search_path='' as $$
  with recorded as (update public.hone_signup_attempts set canceled_at=coalesce(canceled_at,now()),
    change_target=null,retry_change_at=null where subscription_id=p_subscription and customer_id=p_customer
    and id=p_attempt and user_id=p_user and state='paid' returning id)
  select exists(select from recorded);
$$;

create function public.my_hone_studio_canceled(p_studio uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select from public.hone_signup_attempts a where a.studio_id=p_studio
    and (a.canceled_at is not null or a.change_target='cancel')
    and (exists(select from public.practitioners p where p.studio_id=p_studio and p.user_id=auth.uid() and p.active)
      or exists(select from public.studio_receptionists r where r.studio_id=p_studio and r.user_id=auth.uid() and r.active)));
$$;

revoke all on function public.my_hone_solo_impact(uuid),public.request_hone_subscription_change(uuid,text,uuid,text),public.my_hone_studio_canceled(uuid),
  public.claim_hone_subscription_change(uuid),public.finish_hone_subscription_change(uuid,boolean),
  public.record_hone_subscription_canceled(text,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.my_hone_solo_impact(uuid),public.request_hone_subscription_change(uuid,text,uuid,text),public.my_hone_studio_canceled(uuid) to authenticated;
grant execute on function public.claim_hone_subscription_change(uuid),public.finish_hone_subscription_change(uuid,boolean),
  public.record_hone_subscription_canceled(text,text,uuid,uuid) to service_role;

-- The existing studio, customer and team survive cancellation. Serialize retries
-- of a replacement Checkout Session on the original purchase.
create function public.claim_hone_restart(p_studio uuid,p_user uuid,p_expired uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.hone_signup_attempts;
begin
  select * into a from public.hone_signup_attempts
    where studio_id=p_studio and user_id=p_user and state='paid' and canceled_at is not null
      and exists(select from public.practitioners where studio_id=p_studio and user_id=p_user and role='owner' and active)
    for update;
  if not found then return null; end if;
  -- p_expired is supplied only by the server after checking the session at Stripe.
  if a.restart_id is null or (p_expired=a.restart_id and a.restart_started_at+interval '31 minutes'<=now()) then
    update public.hone_signup_attempts set restart_id=gen_random_uuid(),restart_started_at=now()
      where id=a.id returning * into a;
  end if;
  return jsonb_build_object('id',a.restart_id,'created',floor(extract(epoch from a.restart_started_at)),
    'attempt',a.id,'customer',a.customer_id,'plan',a.plan);
end $$;

create function public.apply_hone_restart_invoice(p_event text,p_attempt uuid,p_user uuid,p_plan text,
    p_customer text,p_subscription text,p_invoice text,p_kind text,p_event_at timestamptz,p_restart uuid)
returns text language plpgsql security definer set search_path='' as $$
declare a public.hone_signup_attempts;
begin
  select * into a from public.hone_signup_attempts where id=p_attempt for update;
  if not found or a.user_id<>p_user or a.customer_id<>p_customer or a.state<>'paid' then return 'refused'; end if;
  if a.subscription_id=p_subscription then
    return public.apply_hone_billing_invoice(p_event,p_attempt,p_user,p_plan,p_customer,p_subscription,p_invoice,p_kind,p_event_at);
  end if;
  if a.canceled_at is null or a.restart_id is distinct from p_restart or p_restart is null or a.plan<>p_plan
     or not exists(select from public.practitioners where studio_id=a.studio_id and user_id=p_user and role='owner' and active)
    then return 'refused'; end if;
  if p_kind<>'initial_paid' then return 'retry_after_initial'; end if;
  if nullif(p_subscription,'') is null or nullif(p_invoice,'') is null then return 'refused'; end if;
  insert into public.hone_billing_events values(p_event) on conflict do nothing;
  if not found then return 'duplicate'; end if;
  update public.hone_renewal_invoices set former_subscription=a.subscription_id where attempt_id=a.id and former_subscription is null;
  update public.hone_subscription_notices set former_subscription=a.subscription_id where attempt_id=a.id and former_subscription is null;
  update public.hone_signup_attempts set subscription_id=p_subscription,canceled_at=null,
      change_id=gen_random_uuid(),restart_id=null,restart_started_at=null where id=a.id;
  insert into public.hone_subscription_notices(attempt_id,invoice_id,kind) values(a.id,p_invoice,'receipt');
  return 'restarted';
end $$;
revoke all on function public.claim_hone_restart(uuid,uuid,uuid),public.apply_hone_restart_invoice(text,uuid,uuid,text,text,text,text,text,timestamptz,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.claim_hone_restart(uuid,uuid,uuid),public.apply_hone_restart_invoice(text,uuid,uuid,text,text,text,text,text,timestamptz,uuid)
  to service_role;

commit;
