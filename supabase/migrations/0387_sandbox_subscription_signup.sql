-- Hone platform billing. All writers are server-only; existing studio memberships
-- and Connect accounts are outside this ledger.
begin;
set local lock_timeout = '5s';

create table public.hone_signup_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  plan text not null check (plan in ('solo','studio')),
  studio_name text not null check (length(btrim(studio_name)) between 1 and 100),
  owner_name text not null check (length(btrim(owner_name)) between 1 and 100),
  owner_email text not null,
  created_at timestamptz not null default now(),
  state text not null default 'open' check (state in ('open','expired','paid')),
  session_id text unique,
  session_url text,
  customer_id text unique,
  subscription_id text unique,
  studio_id uuid unique references public.studios(id),
  check ((state = 'paid') = (studio_id is not null)),
  check (state <> 'paid' or (customer_id is not null and subscription_id is not null))
);
create unique index hone_signup_one_purchase on public.hone_signup_attempts(user_id) where state <> 'expired';
create table public.hone_billing_events (id text primary key);
create table public.hone_renewal_invoices (
  invoice_id text primary key,
  attempt_id uuid not null references public.hone_signup_attempts(id),
  failed_at timestamptz,
  settled_at timestamptz,
  paid boolean not null default false
);
create index hone_overdue_invoices on public.hone_renewal_invoices(attempt_id,failed_at) where not paid;
alter table public.hone_signup_attempts enable row level security;
alter table public.hone_billing_events enable row level security;
alter table public.hone_renewal_invoices enable row level security;
revoke all on public.hone_signup_attempts, public.hone_billing_events, public.hone_renewal_invoices from public, anon, authenticated, service_role;

-- One intent per billing fact, committed with the invoice. The pause intent is
-- scheduled by the same unpaid-invoice deadline that gates bookings and charts.
create table public.hone_subscription_notices (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.hone_signup_attempts(id),
  invoice_id text not null,
  kind text not null check (kind in ('receipt','warning','paused')),
  retry_at timestamptz not null default now(),
  lease uuid,
  first_send_at timestamptz,
  payload_hash text,
  sent_at timestamptz,
  unique (attempt_id, invoice_id, kind)
);
alter table public.hone_subscription_notices enable row level security;
revoke all on public.hone_subscription_notices from public, anon, authenticated, service_role;
create index hone_subscription_mail_due on public.hone_subscription_notices(retry_at) where sent_at is null;

create view public.hone_due_subscription_notices with (security_invoker=true) as
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
revoke all on public.hone_due_subscription_notices from public, anon, authenticated, service_role;

create function public.claim_hone_subscription_notice(p_recipient text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  notice public.hone_due_subscription_notices;
  token uuid := gen_random_uuid();
begin
  select d.* into notice from public.hone_due_subscription_notices d
    join public.hone_subscription_notices n on n.id=d.id
    where lower(d.recipient)=lower(p_recipient) and n.retry_at<=now()
      and (n.first_send_at is null or n.first_send_at > now()-interval '23 hours')
    order by n.retry_at,n.id limit 1 for update of n skip locked;
  if not found then
    if exists (
      select 1 from public.hone_due_subscription_notices d join public.hone_subscription_notices n on n.id=d.id
      where lower(d.recipient)=lower(p_recipient) and n.first_send_at<=now()-interval '23 hours'
    ) then return jsonb_build_object('needs_review',true); end if;
    return null;
  end if;
  update public.hone_subscription_notices set lease=token,retry_at=now()+interval '5 minutes' where id=notice.id;
  return to_jsonb(notice) || jsonb_build_object('lease',token);
end $$;

-- Recheck current owner, account state and exact message immediately before mail
-- handoff. A retry after an ambiguous send must use the original payload/key.
create function public.authorize_hone_subscription_notice(p_id uuid,p_lease uuid,p_recipient text,p_hash text,p_deadline timestamptz)
returns boolean language sql security definer set search_path = '' as $$
  with granted as (
    update public.hone_subscription_notices n
    set first_send_at=coalesce(n.first_send_at,now()),payload_hash=p_hash
    from public.hone_due_subscription_notices d
    where n.id=p_id and n.id=d.id and n.lease=p_lease and n.retry_at>now()
      and (d.kind='receipt' or d.deadline=p_deadline) and d.recipient=p_recipient and p_hash ~ '^[0-9a-f]{64}$'
      and (n.payload_hash is null or n.payload_hash=p_hash)
      and (n.first_send_at is null or n.first_send_at>now()-interval '23 hours')
    returning n.id
  ) select exists(select 1 from granted);
$$;

create function public.finish_hone_subscription_notice(p_id uuid,p_lease uuid)
returns boolean language sql security definer set search_path = '' as $$
  with finished as (
    update public.hone_subscription_notices set sent_at=now(),lease=null
    where id=p_id and lease=p_lease and first_send_at is not null and sent_at is null returning id
  ) select exists(select 1 from finished);
$$;
revoke all on function public.claim_hone_subscription_notice(text),
  public.authorize_hone_subscription_notice(uuid,uuid,text,text,timestamptz),public.finish_hone_subscription_notice(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_hone_subscription_notice(text),
  public.authorize_hone_subscription_notice(uuid,uuid,text,text,timestamptz),public.finish_hone_subscription_notice(uuid,uuid)
  to service_role;

create function public.claim_hone_signup(p_user uuid, p_plan text, p_studio text, p_owner text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.hone_signup_attempts;
  verified_email text;
begin
  select email into verified_email from auth.users where id=p_user and email_confirmed_at is not null for update;
  if verified_email is null or exists (select 1 from public.practitioners where user_id=p_user and active)
    or exists (select 1 from public.studio_receptionists where user_id=p_user and active)
    or exists (select 1 from public.pending_invitations where lower(email)=lower(verified_email) and status='pending')
    then return jsonb_build_object('state','ineligible'); end if;
  select * into a from public.hone_signup_attempts where user_id=p_user and state <> 'expired';
  if not found then
    insert into public.hone_signup_attempts(user_id,plan,studio_name,owner_name,owner_email)
    values(p_user,p_plan,btrim(p_studio),btrim(p_owner),verified_email) returning * into a;
  end if;
  return jsonb_build_object('id',a.id,'state',a.state,'plan',a.plan,'email',a.owner_email,
    'created',floor(extract(epoch from a.created_at)), 'session',a.session_id,'url',a.session_url);
end $$;

create function public.bind_hone_checkout(p_attempt uuid, p_user uuid, p_session text, p_url text)
returns boolean language sql security definer set search_path = '' as $$
  with bound as (update public.hone_signup_attempts set session_id=p_session, session_url=p_url
    where id=p_attempt and user_id=p_user and state='open' and (session_id is null or session_id=p_session)
    returning id) select exists(select 1 from bound);
$$;
create function public.expire_hone_checkout(p_attempt uuid, p_user uuid, p_session text)
returns boolean language sql security definer set search_path = '' as $$
  with expired as (update public.hone_signup_attempts set state='expired',session_url=null
    where id=p_attempt and user_id=p_user and state='open' and (session_id is null or session_id=p_session)
    returning id) select exists(select 1 from expired);
$$;

-- The verified Stripe invoice is applied in the same transaction as membership.
-- A failed insert rolls back the event receipt too, so redelivery can recover.
create function public.apply_hone_billing_invoice(p_event text, p_attempt uuid, p_user uuid, p_plan text,
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

-- Existing studios, existing visits and all read/export paths keep their current permissions.
create function public.check_hone_new_work_allowed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  target_studio uuid;
begin
  if tg_table_name in ('electrolysis_entries','laser_entries') then
    select s.studio_id into target_studio from public.sessions s where s.id=new.session_id;
  else
    target_studio := new.studio_id;
  end if;
  if exists (select 1 from public.hone_signup_attempts a join public.hone_renewal_invoices i on i.attempt_id=a.id
    where a.studio_id=target_studio and not i.paid and now() >= i.failed_at + interval '168 hours')
    then raise exception 'subscription_payment_required'; end if;
  return new;
end $$;
create trigger subscription_allows_new_booking before insert on public.appointments
for each row execute function public.check_hone_new_work_allowed();
create trigger subscription_allows_new_chart before insert on public.sessions
for each row execute function public.check_hone_new_work_allowed();

create trigger subscription_allows_new_block before insert on public.session_blocks
for each row execute function public.check_hone_new_work_allowed();
create trigger subscription_allows_new_electrolysis before insert on public.electrolysis_entries
for each row execute function public.check_hone_new_work_allowed();
create trigger subscription_allows_new_laser before insert on public.laser_entries
for each row execute function public.check_hone_new_work_allowed();

-- The owner can review only the selected studio's purchase, including during suspension.
create function public.my_hone_billing_status(p_studio uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('plan', a.plan, 'customer', a.customer_id, 'subscription', a.subscription_id,
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

revoke all on function public.claim_hone_signup(uuid,text,text,text),public.bind_hone_checkout(uuid,uuid,text,text),
  public.expire_hone_checkout(uuid,uuid,text), public.apply_hone_billing_invoice(text,uuid,uuid,text,text,text,text,text,timestamptz),
  public.check_hone_new_work_allowed(), public.my_hone_billing_status(uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_hone_signup(uuid,text,text,text),public.bind_hone_checkout(uuid,uuid,text,text),
  public.expire_hone_checkout(uuid,uuid,text), public.apply_hone_billing_invoice(text,uuid,uuid,text,text,text,text,text,timestamptz)
  to service_role;
grant execute on function public.my_hone_billing_status(uuid) to authenticated;
commit;
