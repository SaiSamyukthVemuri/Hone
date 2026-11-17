-- Owner-configured cancellation tiers. NOT APPLIED. No studio is enrolled or enabled here.
-- 0355/0356 remain reserved for the existing Roles work; never include them in this package's push.
-- Old app + new DB keeps its existing release hold. New app + old DB refuses tier reads.
-- Once a studio adopts tiers, old prepared attempts cannot bypass its rules.
begin;
set local lock_timeout = '5s';

create table public.studio_cancellation_fee_rules (
  studio_id uuid primary key references public.studios(id) on delete cascade,
  revision bigint not null check (revision > 0),
  enabled boolean not null default false,
  notice_hours integer not null check (notice_hours between 1 and 168),
  notice_mode text not null check (notice_mode in ('fixed', 'percent')),
  notice_value integer not null,
  same_day_mode text not null check (same_day_mode in ('fixed', 'percent')),
  same_day_value integer not null,
  policy_snapshot_hash text not null check (policy_snapshot_hash ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz not null default now(),
  check (notice_value between 1 and case when notice_mode = 'percent' then 10000 else 20000 end),
  check (same_day_value between 1 and case when same_day_mode = 'percent' then 10000 else 20000 end)
);
alter table public.studio_cancellation_fee_rules enable row level security;
create policy cancellation_fee_rules_owner_read on public.studio_cancellation_fee_rules
  for select to authenticated using (public.is_studio_owner(studio_id));
revoke all on public.studio_cancellation_fee_rules from public, anon, authenticated, service_role;
grant select on public.studio_cancellation_fee_rules to authenticated, service_role;

create table public.studio_cancellation_fee_rule_changes (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  changed_by uuid,
  old_rule jsonb,
  new_rule jsonb not null,
  changed_at timestamptz not null default now()
);
alter table public.studio_cancellation_fee_rule_changes enable row level security;
create policy cancellation_fee_rule_changes_owner_read on public.studio_cancellation_fee_rule_changes
  for select to authenticated using (public.is_studio_owner(studio_id));
revoke all on public.studio_cancellation_fee_rule_changes from public, anon, authenticated, service_role;
grant select on public.studio_cancellation_fee_rule_changes to authenticated, service_role;

-- One governed writer: owner session, studio/config lock, exact revision, current policy confirmation.
-- Save always leaves the fee OFF; activation is a separate deliberate command.
create function public.save_cancellation_fee_rules(
  p_studio_id uuid, p_expected_revision bigint, p_notice_hours integer,
  p_notice_mode text, p_notice_value integer, p_same_day_mode text, p_same_day_value integer,
  p_presented_policy_hash text
) returns public.studio_cancellation_fee_rules
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_policy text; v_no_show text; v_hash text;
  v_old public.studio_cancellation_fee_rules; v_new public.studio_cancellation_fee_rules;
begin
  if auth.uid() is null or not public.is_studio_owner(p_studio_id) then raise exception 'Only the studio owner can change cancellation fees' using errcode = '42501'; end if;
  select cancellation_policy_text, no_show_policy_text into v_policy, v_no_show from public.studios where id = p_studio_id for update;
  if not found or nullif(btrim(v_policy), '') is null then raise exception 'Set a cancellation policy before configuring fees' using errcode = '23514'; end if;
  v_hash := encode(extensions.digest(coalesce(v_policy, '') || E'\n---\n' || coalesce(v_no_show, ''), 'sha256'), 'hex');
  if p_presented_policy_hash is distinct from v_hash then raise exception 'The policy changed. Refresh and review it again' using errcode = '40001'; end if;
  select * into v_old from public.studio_cancellation_fee_rules where studio_id = p_studio_id for update;
  if p_expected_revision is distinct from coalesce(v_old.revision, 0) then raise exception 'Fee settings changed. Refresh and try again' using errcode = '40001'; end if;
  insert into public.studio_cancellation_fee_rules (studio_id, revision, enabled, notice_hours, notice_mode, notice_value, same_day_mode, same_day_value, policy_snapshot_hash)
  values (p_studio_id, coalesce(v_old.revision, 0) + 1, false, p_notice_hours, p_notice_mode, p_notice_value, p_same_day_mode, p_same_day_value, v_hash)
  on conflict (studio_id) do update set revision = excluded.revision, enabled = false,
    notice_hours = excluded.notice_hours, notice_mode = excluded.notice_mode, notice_value = excluded.notice_value,
    same_day_mode = excluded.same_day_mode, same_day_value = excluded.same_day_value,
    policy_snapshot_hash = excluded.policy_snapshot_hash, updated_at = now()
  returning * into v_new;
  insert into public.studio_cancellation_fee_rule_changes (studio_id, changed_by, old_rule, new_rule)
    values (p_studio_id, auth.uid(), case when v_old.studio_id is null then null else to_jsonb(v_old) end, to_jsonb(v_new));
  return v_new;
end;
$$;

create function public.set_cancellation_fee_rules_enabled(p_studio_id uuid, p_expected_revision bigint, p_enabled boolean)
returns public.studio_cancellation_fee_rules
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_policy text; v_no_show text; v_hash text;
  v_old public.studio_cancellation_fee_rules; v_new public.studio_cancellation_fee_rules;
begin
  if auth.uid() is null or not public.is_studio_owner(p_studio_id) then raise exception 'Only the studio owner can change cancellation fees' using errcode = '42501'; end if;
  select cancellation_policy_text, no_show_policy_text into v_policy, v_no_show from public.studios where id = p_studio_id for update;
  select * into v_old from public.studio_cancellation_fee_rules where studio_id = p_studio_id for update;
  if not found or p_expected_revision is distinct from v_old.revision then raise exception 'Fee settings changed. Refresh and try again' using errcode = '40001'; end if;
  v_hash := encode(extensions.digest(coalesce(v_policy, '') || E'\n---\n' || coalesce(v_no_show, ''), 'sha256'), 'hex');
  if p_enabled and (nullif(btrim(v_policy), '') is null or v_old.policy_snapshot_hash is distinct from v_hash) then
    raise exception 'The policy changed. Review and save the rules again' using errcode = '23514';
  end if;
  update public.studio_cancellation_fee_rules set enabled = p_enabled, revision = revision + 1, updated_at = now()
    where studio_id = p_studio_id returning * into v_new;
  insert into public.studio_cancellation_fee_rule_changes (studio_id, changed_by, old_rule, new_rule)
    values (p_studio_id, auth.uid(), to_jsonb(v_old), to_jsonb(v_new));
  return v_new;
end;
$$;
revoke execute on function public.save_cancellation_fee_rules(uuid, bigint, integer, text, integer, text, integer, text) from public, anon, authenticated, service_role;
revoke execute on function public.set_cancellation_fee_rules_enabled(uuid, bigint, boolean) from public, anon, authenticated, service_role;
grant execute on function public.save_cancellation_fee_rules(uuid, bigint, integer, text, integer, text, integer, text) to authenticated;
grant execute on function public.set_cancellation_fee_rules_enabled(uuid, bigint, boolean) to authenticated;

-- An older settings tab must not report that it turned fees OFF by changing an
-- obsolete flag while the new governed configuration remains ON. Close those
-- writers as soon as a studio adopts tiers; ask that tab to refresh instead.
create function public.cancellation_fee_legacy_setting_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if exists (select 1 from public.studio_cancellation_fee_rules where studio_id = new.id) then
    raise exception 'This studio uses cancellation fee rules. Refresh Settings, Payments before changing fees'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke execute on function public.cancellation_fee_legacy_setting_guard() from public, anon, authenticated, service_role;
create trigger cancellation_fee_legacy_setting_guard
  before update of late_cancel_fee_enabled, late_cancel_fee_mode, late_cancel_fee_cents, late_cancel_fee_percent_bp
  on public.studios for each row execute function public.cancellation_fee_legacy_setting_guard();

alter table public.payment_charge_attempts add column cancellation_fee_snapshot jsonb;

-- At prepare, freeze timing + selected tier; at claim, require the same rule revision and appointment.
-- This also closes an older app's writer after a studio adopts tiers. In-flight reconciliation/refunds are untouched.
create function public.cancellation_fee_attempt_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_rule public.studio_cancellation_fee_rules; v_appt public.appointments;
  v_timezone text; v_policy text; v_no_show text; v_hash text; v_tier text; v_mode text; v_value integer; v_amount bigint; v_snapshot jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.cancellation_fee_snapshot is distinct from old.cancellation_fee_snapshot then raise exception 'Cancellation fee evidence is immutable' using errcode = '23514'; end if;
    if old.status <> 'ready' or new.status <> 'pending_stripe' then return new; end if;
  end if;
  if new.charge_reason <> 'late_cancellation_fee' then
    if new.cancellation_fee_snapshot is not null then raise exception 'Cancellation evidence requires a cancellation fee' using errcode = '23514'; end if;
    return new;
  end if;
  select * into v_rule from public.studio_cancellation_fee_rules where studio_id = new.studio_id for share;
  -- No adoption: retain old application compatibility under its original live release gate.
  if not found then
    if new.cancellation_fee_snapshot is not null then raise exception 'Cancellation fee rules missing' using errcode = '23514'; end if;
    return new;
  end if;
  if not v_rule.enabled then raise exception 'Cancellation fees are off' using errcode = '23514'; end if;
  select timezone, cancellation_policy_text, no_show_policy_text into v_timezone, v_policy, v_no_show from public.studios where id = new.studio_id;
  v_hash := encode(extensions.digest(coalesce(v_policy, '') || E'\n---\n' || coalesce(v_no_show, ''), 'sha256'), 'hex');
  if v_rule.policy_snapshot_hash is distinct from v_hash or new.policy_snapshot_hash is distinct from v_hash then raise exception 'Cancellation policy evidence does not match' using errcode = '23514'; end if;
  select * into v_appt from public.appointments where id = new.appointment_id and studio_id = new.studio_id and client_id = new.client_id;
  if not found or v_appt.status <> 'cancelled' or v_appt.cancelled_at is null or v_appt.cancelled_at > v_appt.starts_at
     or v_timezone is null or not exists (select 1 from pg_timezone_names where name = v_timezone) then
    raise exception 'Cancellation timing could not be verified' using errcode = '23514';
  end if;
  if (v_appt.cancelled_at at time zone v_timezone)::date = (v_appt.starts_at at time zone v_timezone)::date then v_tier := 'same_day';
  elsif v_appt.starts_at - v_appt.cancelled_at < make_interval(hours => v_rule.notice_hours) then v_tier := 'within_notice';
  else raise exception 'Cancellation is outside the fee window' using errcode = '23514'; end if;
  v_mode := case when v_tier = 'same_day' then v_rule.same_day_mode else v_rule.notice_mode end;
  v_value := case when v_tier = 'same_day' then v_rule.same_day_value else v_rule.notice_value end;
  v_snapshot := jsonb_build_object('revision', v_rule.revision, 'tier', v_tier, 'startsAt', v_appt.starts_at, 'cancelledAt', v_appt.cancelled_at, 'timezone', v_timezone);
  if tg_op = 'UPDATE' then
    -- JSON timestamps come from Postgres itself on insert; no browser-format equality assumptions.
    if old.cancellation_fee_snapshot is distinct from v_snapshot then raise exception 'Cancellation fee settings or timing changed' using errcode = '23514'; end if;
  end if;
  if v_mode = 'percent' then
    if new.calc_mode is distinct from 'percent' or new.percent_bp is distinct from v_value or new.basis_cents is null or new.basis_cents <= 0 then raise exception 'Cancellation fee rate does not match' using errcode = '23514'; end if;
    v_amount := (new.basis_cents::bigint * v_value + 5000) / 10000;
    if v_amount <= 0 or v_amount >= 20000 then raise exception 'Cancellation fee outside allowed range' using errcode = '23514'; end if;
  else
    if new.calc_mode is distinct from 'fixed' or new.basis_cents is not null or new.percent_bp is not null then raise exception 'Cancellation fee rate does not match' using errcode = '23514'; end if;
    v_amount := v_value;
  end if;
  if new.amount_cents is distinct from v_amount then raise exception 'Cancellation fee amount does not match' using errcode = '23514'; end if;
  if not exists (select 1 from public.appointment_policy_acknowledgements a where a.id = new.appointment_policy_acknowledgement_id
    and a.studio_id = new.studio_id and a.client_id = new.client_id and a.appointment_id = new.appointment_id and a.policy_snapshot_hash = v_hash) then
    raise exception 'Client policy acknowledgement does not match' using errcode = '23514';
  end if;
  new.cancellation_fee_snapshot := v_snapshot;
  new.timing_classification := 'system_derived';
  return new;
end;
$$;
revoke execute on function public.cancellation_fee_attempt_guard() from public, anon, authenticated, service_role;
create trigger cancellation_fee_attempt_guard before insert or update on public.payment_charge_attempts
  for each row execute function public.cancellation_fee_attempt_guard();

comment on table public.studio_cancellation_fee_rules is '0357. Owner-configured notice-window and local same-day cancellation fees. No enrollment by default. RPC writes only, revision CAS, published-policy confirmation, independent enable. No-show settings are separate.';
comment on column public.payment_charge_attempts.cancellation_fee_snapshot is '0357. Immutable server-stamped rule revision, selected tier and authoritative timing. Old prepared fees cannot execute after tier adoption.';
commit;
