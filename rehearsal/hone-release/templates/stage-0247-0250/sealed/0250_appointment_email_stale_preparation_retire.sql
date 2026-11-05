-- 0250: MSG-002/003 R2 liveness repair for 0247's reminder email authority.
-- A reschedule between prepare and authorize left a stale 'prepared' operation
-- that every later prepare refused (held/stale_preparation) and nobody could
-- retire once its lease expired, so the cohort never got another reminder.
-- prepare now retires an expired, provably unattempted, stale preparation in
-- place and prepares fresh. No table/column/grant widening; unknown/accepted
-- and any possibly attempted row remain fail-closed. SOURCE ONLY: local proof;
-- no hosted apply is authorized (ships behind 0247 under its own approval).
begin;
set local lock_timeout = '5s';

create or replace function public.prepare_appointment_email_operation(
  p_studio_id uuid,p_appointment_id uuid,p_purpose text,p_provider_account text,p_expected_authority jsonb
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare v jsonb; o appointment_email_private.operations%rowtype; n integer; existing boolean;
begin
  if p_provider_account is null or p_provider_account !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$' then return jsonb_build_object('kind','held','reason','invalid_input'); end if;
  v := appointment_email_private.read_authority(p_studio_id,p_appointment_id,p_purpose);
  if v->>'kind' <> 'eligible' then return v; end if;
  if p_expected_authority is distinct from v->'authority' then return jsonb_build_object('kind','held','reason','stale_authority'); end if;
  insert into appointment_email_private.cohorts(studio_id,appointment_id,purpose,attempts)
    values(p_studio_id,p_appointment_id,p_purpose,least(3,(v->>'legacyAttempts')::integer)) on conflict do nothing;
  select attempts into n from appointment_email_private.cohorts where studio_id=p_studio_id and appointment_id=p_appointment_id and purpose=p_purpose for no key update;
  select * into o from appointment_email_private.operations where studio_id=p_studio_id and appointment_id=p_appointment_id and purpose=p_purpose and state in ('prepared','unknown','accepted') for no key update;
  existing := found;
  -- 0250 (MSG-002/003 R2): an EXPIRED preparation that is PROVABLY unattempted
  -- (no first possible attempt, no authorization lease) and whose authority,
  -- account or composition went stale (e.g. a reschedule between prepare and
  -- authorize) is retired here, under the same cohort + row locks, and a fresh
  -- preparation follows. Anything possibly attempted stays fail-closed.
  if existing and o.state = 'prepared' and o.lease_expires_at <= clock_timestamp()
     and o.first_possible_attempt_at is null and o.authorization_lease_token is null
     and (o.authority is distinct from p_expected_authority or o.provider_account <> p_provider_account
          or o.composition <> v->>'composition') then
    update appointment_email_private.operations set state='retired' where id=o.id;
    existing := false;
  end if;
  if existing then
    if o.state in ('unknown','accepted') then return jsonb_build_object('kind','held','reason','prior_possible_effect'); end if;
    if o.lease_expires_at > clock_timestamp() then return jsonb_build_object('kind','held','reason','leased'); end if;
    if o.authority is distinct from p_expected_authority or o.provider_account <> p_provider_account or o.composition <> v->>'composition' then
      return jsonb_build_object('kind','held','reason','stale_preparation');
    end if;
    -- Reconciliation of a PROVABLY unattempted expired preparation only.
    update appointment_email_private.operations set lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '5 minutes'
      where id=o.id and first_possible_attempt_at is null returning * into o;
  else
    if v->'legacySent' <> 'null'::jsonb or v->'legacyClaimed' <> 'null'::jsonb then return jsonb_build_object('kind','held','reason','legacy_effect'); end if;
    if greatest(n,(v->>'legacyAttempts')::integer) >= 3 then return jsonb_build_object('kind','held','reason','attempt_cap'); end if;
    insert into appointment_email_private.operations(studio_id,appointment_id,purpose,provider_account,authority,composition)
      values(p_studio_id,p_appointment_id,p_purpose,p_provider_account,p_expected_authority,v->>'composition') returning * into o;
  end if;
  -- Refresh after preparation lock waits too. Only opaque authority is
  -- durable; the clinical/render projection is returned transiently.
  v := appointment_email_private.snapshot_authority(p_studio_id,p_appointment_id,p_purpose);
  if v->>'kind' <> 'eligible' or o.authority is distinct from v->'authority' or
    o.composition is distinct from v->>'composition' then return jsonb_build_object('kind','held'); end if;
  return jsonb_build_object('kind','prepared','render',v->'render','operationId',o.id,'leaseToken',o.lease_token,'authority',o.authority,
    'providerKey',o.provider_key,'composition',o.composition,'intakeId',v->'intakeId');
end;
$$;

-- Supabase default grants are not authority: re-close all roles by name, then
-- grant only the trusted server, exactly as 0247 did.
revoke execute on function public.prepare_appointment_email_operation(uuid,uuid,text,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.prepare_appointment_email_operation(uuid,uuid,text,text,jsonb) to service_role;
commit;
