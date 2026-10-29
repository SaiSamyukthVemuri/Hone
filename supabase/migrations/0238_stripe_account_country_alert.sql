-- PAY-CCY-03 / 4305395970. One open country incident per bound account,
-- mode and derived reason. Existing rows are reused, never rewritten/deleted.
-- Apply before the caller upgrade. Old callers remain compatible but can
-- still duplicate alerts until upgraded. Email is best effort, not exactly-once.
begin;
set local lock_timeout = '5s';

create or replace function public.claim_stripe_account_country_alert(
  p_studio_id uuid,
  p_stripe_account_id text,
  p_stripe_livemode boolean
)
returns table (
  out_result text,
  out_alert_id uuid,
  out_created_at timestamptz,
  out_reason text,
  out_message text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_settings public.studio_payment_settings%rowtype;
  v_payment_country text;
  v_reason text;
  v_message text;
  v_alert_id uuid;
  v_created_at timestamptz;
begin
  -- The SELECT after the row-lock wait must see the previous winner's commit.
  -- Fail retryably rather than deduplicate against an older fixed snapshot.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = '40001', message = 'country_alert_requires_read_committed';
  end if;
  if p_studio_id is null or p_stripe_livemode is null
     or coalesce(btrim(p_stripe_account_id), '') = '' then
    return query select 'invalid_input'::text, null::uuid, null::timestamptz, null::text, null::text;
    return;
  end if;

  -- Match provisioning's jurisdiction-before-settings lock order (0214).
  select j.payment_country into v_payment_country
    from public.studio_payment_jurisdictions j
   where j.studio_id = p_studio_id
   for share;
  select * into v_settings
    from public.studio_payment_settings s
   where s.studio_id = p_studio_id
     and s.stripe_account_id = p_stripe_account_id
     and s.stripe_livemode = p_stripe_livemode
   for update;
  if not found then
    return query select 'not_bound'::text, null::uuid, null::timestamptz, null::text, null::text;
    return;
  end if;
  if v_payment_country is null or v_settings.stripe_account_country is null then
    return query select 'unverified'::text, null::uuid, null::timestamptz, null::text, null::text;
    return;
  end if;

  -- Caller-supplied countries/reasons/payloads cannot forge an incident.
  if v_settings.stripe_account_country_conflict is not null then
    v_reason := 'country_conflict';
    v_message := 'Stripe reported a different country for a connected account than the one Hone recorded. Nothing was overwritten; charging stays blocked until an operator resolves it.';
  elsif v_settings.stripe_account_country <> v_payment_country then
    v_reason := 'country_mismatch';
    v_message := 'A studio''s Stripe connected account is in a different country than the studio''s payment country. Onboarding and charging are blocked; the account is not replaced.';
  else
    return query select 'not_mismatched'::text, null::uuid, null::timestamptz, null::text, null::text;
    return;
  end if;

  -- All upgraded callers serialize on the same bound settings row. Including
  -- reason permits a new conflict incident independently of a prior mismatch.
  -- Any pre-existing open row counts; no uniqueness cleanup/backfill is needed.
  select a.id, a.created_at into v_alert_id, v_created_at
    from public.ops_alerts a
   where a.studio_id = p_studio_id
     and a.event = 'stripe_account_country_mismatch'
     and a.resolved_at is null
     and a.safe_details->>'stripe_account_id' = p_stripe_account_id
     and a.safe_details->>'livemode' = p_stripe_livemode::text
     and a.safe_details->>'reason' = v_reason
   order by a.created_at, a.id
   limit 1;
  if found then
    return query select 'existing'::text, v_alert_id, v_created_at, v_reason, v_message;
    return;
  end if;

  insert into public.ops_alerts (severity, event, message, studio_id, route, safe_details)
  values ('critical', 'stripe_account_country_mismatch', v_message, p_studio_id,
    'lib/stripe/account:recordStripeAccountObservation',
    jsonb_build_object('stripe_account_id', p_stripe_account_id,
      'livemode', p_stripe_livemode, 'reason', v_reason,
      'recorded_account_country', v_settings.stripe_account_country,
      'conflicting_account_country', v_settings.stripe_account_country_conflict,
      'studio_payment_country', v_payment_country))
  returning id, created_at into v_alert_id, v_created_at;
  return query select 'created'::text, v_alert_id, v_created_at, v_reason, v_message;
end;
$$;

revoke execute on function public.claim_stripe_account_country_alert(uuid, text, boolean) from public;
revoke execute on function public.claim_stripe_account_country_alert(uuid, text, boolean) from anon;
revoke execute on function public.claim_stripe_account_country_alert(uuid, text, boolean) from authenticated;
revoke execute on function public.claim_stripe_account_country_alert(uuid, text, boolean) from service_role;
grant execute on function public.claim_stripe_account_country_alert(uuid, text, boolean) to service_role;

comment on function public.claim_stripe_account_country_alert(uuid, text, boolean) is
  '0238: service-only, read-committed country incident claim. Locks verified bound settings; derives reason from persisted state; creates/reuses one open ops alert. Only created winner may send best-effort email. Operator resolution re-arms; no country/conflict/history mutation.';
commit;
