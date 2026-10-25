-- MSG-002/003: generation-bound appointment reminder email authority.
-- SOURCE ONLY under Sam's new missing-0247 directive. No apply/rollout is
-- authorized. Drain old automation and inventory possible effects BEFORE a
-- separately approved migration/caller release. New caller + old DB is held,
-- never a legacy-RPC fallback. No request body/recipient/token is retained.
begin;
set local lock_timeout = '5s';

create schema appointment_email_private;
revoke all on schema appointment_email_private from public, anon, authenticated, service_role;
create sequence appointment_email_private.authority_revision_seq as bigint;
revoke all on sequence appointment_email_private.authority_revision_seq from public, anon, authenticated, service_role;
alter table public.appointments add column email_operation_revision bigint not null default 0;
alter table public.clients add column email_operation_revision bigint not null default 0;
alter table public.studios add column email_operation_revision bigint not null default 0;
alter table public.services add column email_operation_revision bigint not null default 0;
alter table public.practitioners add column email_operation_revision bigint not null default 0;

-- No cascading parent FK: absence/reinsert must not erase epochs, attempt
-- budgets, or an accepted/UNKNOWN fence. These are not replay representations.
create table appointment_email_private.intake_epochs (
  studio_id uuid not null, client_id uuid not null,
  revision bigint not null default 0 check (revision >= 0),
  primary key (studio_id, client_id)
);
create table appointment_email_private.cohorts (
  studio_id uuid not null, appointment_id uuid not null,
  purpose text not null check (purpose in ('reminder_24h','reminder_2h')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  primary key (studio_id, appointment_id, purpose)
);
create table appointment_email_private.operations (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null, appointment_id uuid not null,
  purpose text not null check (purpose in ('reminder_24h','reminder_2h')),
  provider_account text not null check (provider_account ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$'),
  provider_key uuid not null unique default gen_random_uuid(),
  authority jsonb not null,
  composition text not null check (composition in ('reminder_only','reminder_with_intake','intake_only')),
  lease_token uuid not null default gen_random_uuid(),
  lease_expires_at timestamptz not null default (clock_timestamp() + interval '5 minutes'),
  authorization_lease_token uuid,
  state text not null default 'prepared' check (state in ('prepared','retired','unknown','accepted','refused')),
  request_digest text check (request_digest ~ '^[a-f0-9]{64}$'),
  capability_digest text check (capability_digest ~ '^[a-f0-9]{64}$'),
  first_possible_attempt_at timestamptz,
  retry_not_after timestamptz check (retry_not_after is null),
  provider_message_id text,
  unknown_observed boolean not null default false,
  check ((first_possible_attempt_at is null) = (authorization_lease_token is null)),
  check (state not in ('unknown','accepted','refused') or
    (first_possible_attempt_at is not null and request_digest is not null and capability_digest is not null)),
  check (state <> 'accepted' or provider_message_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$')
);
create unique index appointment_email_one_unresolved_cohort
  on appointment_email_private.operations(studio_id,appointment_id,purpose)
  where state in ('prepared','unknown','accepted');
alter table appointment_email_private.intake_epochs enable row level security;
alter table appointment_email_private.cohorts enable row level security;
alter table appointment_email_private.operations enable row level security;
revoke all on all tables in schema appointment_email_private from public, anon, authenticated, service_role;

-- Own-row only: never acquire a parent lock from an appointment row trigger.
-- Accounting updates cannot self-invalidate. New identities use a DB sequence,
-- so delete/reinsert and A->B->A cannot recreate an old vector.
create function appointment_email_private.revise_authority()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare fields text[] := string_to_array(tg_argv[0], ','); old_fields jsonb; new_fields jsonb;
begin
  if tg_op = 'INSERT' then
    new.email_operation_revision := nextval('appointment_email_private.authority_revision_seq');
  else
    select jsonb_object_agg(k,to_jsonb(old)->k), jsonb_object_agg(k,to_jsonb(new)->k)
      into old_fields,new_fields from unnest(fields) k;
    if old_fields is distinct from new_fields then
      new.email_operation_revision := nextval('appointment_email_private.authority_revision_seq');
    else new.email_operation_revision := old.email_operation_revision;
    end if;
  end if;
  return new;
end;
$$;
create trigger appointment_email_revision before insert or update on public.appointments
for each row execute function appointment_email_private.revise_authority('id,studio_id,client_id,status,starts_at,ends_at,service_id,practitioner_id,duration_minutes');
create trigger appointment_email_revision before insert or update on public.clients
for each row execute function appointment_email_private.revise_authority('id,studio_id,name,email,archived_at');
-- JSON projection also tolerates the two later settings columns being absent;
-- this does NOT import/apply 0234 or enable either setting.
create trigger appointment_email_revision before insert or update on public.studios
for each row execute function appointment_email_private.revise_authority('id,name,address,slug,timezone,owner_email,postcare_contact_email,show_treatment_time_to_clients,send_24h_reminders,send_2h_reminders,send_intake_reminders,client_cancellation_enabled,client_reschedule_enabled');

-- Referenced render content gets its own ABA epoch; own-row changes only.
-- Never acquire a parent or clinical lock from these triggers.
create trigger appointment_email_revision before insert or update on public.services
for each row execute function appointment_email_private.revise_authority('id,studio_id,name,pre_care_instructions');
create trigger appointment_email_revision before insert or update on public.practitioners
for each row execute function appointment_email_private.revise_authority('id,studio_id,display_name,email');

create function appointment_email_private.advance_intake_epoch()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare r record;
begin
  if tg_op = 'UPDATE' and row(new.id,new.studio_id,new.client_id,new.status,new.deleted_at,new.created_at)
    is not distinct from row(old.id,old.studio_id,old.client_id,old.status,old.deleted_at,old.created_at) then return new; end if;
  -- OLD and NEW parent scopes in stable order; no lock on an intake child
  -- from the authorizer, avoiding the child->parent / parent->child inversion.
  for r in select distinct s,c from (values
    (case when tg_op <> 'INSERT' then old.studio_id end, case when tg_op <> 'INSERT' then old.client_id end),
    (case when tg_op <> 'DELETE' then new.studio_id end, case when tg_op <> 'DELETE' then new.client_id end)
  ) scopes(s,c) where s is not null and c is not null order by s,c
  loop
    insert into appointment_email_private.intake_epochs as e(studio_id,client_id,revision)
      values(r.s,r.c,nextval('appointment_email_private.authority_revision_seq'))
      on conflict(studio_id,client_id) do update set revision=excluded.revision;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger appointment_email_intake_epoch before insert or update or delete on public.client_intake_forms
for each row execute function appointment_email_private.advance_intake_epoch();

-- Capture ALL current render facts in ONE SELECT statement. This VOLATILE
-- helper must be called in a fresh READ COMMITTED statement AFTER all existing
-- parent/cohort/operation lock waits. No clinical/service/practitioner locks.
-- The transient clinical pair proves current rendered truth, not every-edit
-- ABA. Equal aggregate A->B->A is indistinguishable and renders the same line.
create function appointment_email_private.snapshot_authority(p_studio uuid,p_appointment uuid,p_purpose text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare v jsonb; r jsonb; pair jsonb; reminder boolean; incomplete boolean;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode='25001',message='email authority requires read committed';
  end if;
  if p_purpose is null or p_purpose not in ('reminder_24h','reminder_2h') then
    return jsonb_build_object('kind','held','reason','invalid_purpose');
  end if;
  with candidate as materialized (
    select a, c, s, sv, pr, e.revision as intake_revision,
      case when p_purpose='reminder_24h' then s.send_24h_reminders else s.send_2h_reminders end as wants_reminder,
      clock_timestamp() as at_time
    from public.appointments a
    join public.studios s on s.id=a.studio_id
    join public.clients c on c.id=a.client_id and c.studio_id=s.id
    join appointment_email_private.intake_epochs e on e.studio_id=s.id and e.client_id=c.id
    left join public.services sv on sv.id=a.service_id and sv.studio_id=s.id
    left join public.practitioners pr on pr.id=a.practitioner_id and pr.studio_id=s.id
    where a.id=p_appointment and a.studio_id=p_studio
  ), facts as materialized (
    select x.*, i.latest, i.ties,
      case when x.wants_reminder and (x.s).show_treatment_time_to_clients then (
        -- Exact existing helper membership: no status/void/started_at filter.
        -- Count sessions with no blocks; avoid join fanout of sessionCount.
        select jsonb_build_object('sessionCount',count(*),'totalMinutes',coalesce(sum(t.minutes),0),
          'absoluteMinutes',coalesce(sum(t.absolute_minutes),0))
        from (
          select ss.id, coalesce(sum(bb.minutes_performed::numeric),0) as minutes,
            coalesce(sum(abs(bb.minutes_performed::numeric)),0) as absolute_minutes
          from public.sessions ss
          left join public.session_blocks bb on bb.session_id=ss.id and bb.deleted_at is null
          where ss.studio_id=p_studio and ss.client_id=(x.c).id
            and ss.modality='electrolysis' and ss.deleted_at is null
          group by ss.id
        ) t
      ) else null end as clinical
    from candidate x
    left join lateral (
      select jsonb_agg(jsonb_build_object('id',z.id,'status',z.status)) as latest, count(*) as ties
      from public.client_intake_forms z
      where (x.s).send_intake_reminders and z.studio_id=p_studio and z.client_id=(x.c).id
        and z.deleted_at is null and z.created_at=(
          select max(q.created_at) from public.client_intake_forms q
          where q.studio_id=p_studio and q.client_id=(x.c).id and q.deleted_at is null)
    ) i on true
  )
  select jsonb_build_object(
    'status',(a).status,'email',(c).email,'startsAt',(a).starts_at,'atTime',at_time,
    'missingRelation',((a).service_id is not null and (sv).id is null) or
      ((a).practitioner_id is not null and (pr).id is null),
    'wantsReminder',wants_reminder,'latest',latest,'ties',ties,'clinical',clinical,
    'authority',jsonb_build_object('appointment',(a).email_operation_revision::text,
      'client',(c).email_operation_revision::text,'studio',(s).email_operation_revision::text,
      'intake',intake_revision::text,
      'service',case when (a).service_id is null then 'unassigned' else (sv).email_operation_revision::text end,
      'practitioner',case when (a).practitioner_id is null then 'unassigned' else (pr).email_operation_revision::text end),
    'render',jsonb_build_object(
      'appointment',jsonb_build_object('id',(a).id,'studio_id',(a).studio_id,'client_id',(a).client_id,
        'status',(a).status,'starts_at',(a).starts_at,'ends_at',(a).ends_at,'duration_minutes',(a).duration_minutes,
        'service_id',(a).service_id,'practitioner_id',(a).practitioner_id),
      'client',jsonb_build_object('id',(c).id,'name',(c).name,'email',(c).email),
      'studio',jsonb_build_object('id',(s).id,'name',(s).name,'address',(s).address,'slug',(s).slug,
        'timezone',(s).timezone,'owner_email',(s).owner_email,'postcare_contact_email',(s).postcare_contact_email,
        'show_treatment_time_to_clients',(s).show_treatment_time_to_clients,
        'send_24h_reminders',(s).send_24h_reminders,'send_2h_reminders',(s).send_2h_reminders,
        'send_intake_reminders',(s).send_intake_reminders,
        'client_cancellation_enabled',to_jsonb(s)->'client_cancellation_enabled',
        'client_reschedule_enabled',to_jsonb(s)->'client_reschedule_enabled'),
      'service',case when (sv).id is null then null else jsonb_build_object('id',(sv).id,
        'name',(sv).name,'pre_care_instructions',(sv).pre_care_instructions) end,
      'practitioner',case when (pr).id is null then null else jsonb_build_object('id',(pr).id,
        'display_name',(pr).display_name,'email',(pr).email) end),
    'legacyAttempts',(to_jsonb(a)->>(p_purpose||'_send_attempts'))::integer,
    'legacyClaimed',to_jsonb(a)->(p_purpose||'_claimed_at'),'legacySent',to_jsonb(a)->(p_purpose||'_sent_at'))
  into v from facts;
  if v is null then return jsonb_build_object('kind','held','reason','missing_scope'); end if;
  if (v->>'missingRelation')::boolean then return jsonb_build_object('kind','held','reason','missing_relation'); end if;
  if v->>'status' <> 'confirmed' or v->>'email' is null or position('@' in (v->>'email'))<2 or
    (p_purpose='reminder_24h' and ((v->>'startsAt')::timestamptz < (v->>'atTime')::timestamptz+interval '23 hours' or
      (v->>'startsAt')::timestamptz > (v->>'atTime')::timestamptz+interval '25 hours')) or
    (p_purpose='reminder_2h' and ((v->>'startsAt')::timestamptz < (v->>'atTime')::timestamptz+interval '105 minutes' or
      (v->>'startsAt')::timestamptz > (v->>'atTime')::timestamptz+interval '135 minutes')) then
    return jsonb_build_object('kind','held','reason','ineligible');
  end if;
  if (v->>'ties')::bigint > 1 then return jsonb_build_object('kind','held','reason','ambiguous_intake'); end if;
  reminder := coalesce((v->>'wantsReminder')::boolean,false);
  incomplete := coalesce(v->'latest'->0->>'status'='in_progress',false);
  if not reminder and not incomplete then return jsonb_build_object('kind','held','reason','nothing_to_send'); end if;
  pair := v->'clinical';
  if pair <> 'null'::jsonb then
    -- Minute columns are integral. Numeric SUM avoids int32 overflow; the
    -- absolute sum bound makes every JS intermediate addition exactly safe.
    -- Count+1 must also be safe. Never round or fabricate an aggregate.
    if (pair->>'absoluteMinutes')::numeric > 9007199254740991 or
      abs((pair->>'totalMinutes')::numeric) > 9007199254740991 or
      (pair->>'totalMinutes')::numeric <> trunc((pair->>'totalMinutes')::numeric) or
      (pair->>'sessionCount')::numeric >= 9007199254740991 then
      return jsonb_build_object('kind','held','reason','unrepresentable_treatment_time');
    end if;
    pair := pair-'absoluteMinutes';
  end if;
  -- Closed composition-specific trusted-server DTOs. Intake-only renders
  -- no clinical line, client name, contact/replyTo, practitioner or service.
  -- Do not expose the broader reminder DTO merely because it was read here.
  r := case when reminder then (v->'render') || jsonb_build_object(
    'treatmentTime',pair,'intake',case when incomplete then v->'latest'->0 else 'null'::jsonb end,
    'attachments',null)
  else jsonb_build_object('kind',p_purpose,'clientEmail',v->>'email',
    'studioName',v->'render'->'studio'->'name','timezone',v->'render'->'studio'->'timezone',
    'startsAt',v->'render'->'appointment'->'starts_at','intake',v->'latest'->0,
    'replyTo',null,'attachments',null) end;
  -- Current runtime/template/origin/signing/provider identity remains the
  -- separately reviewed trusted caller's binding, not SQL hash-shape proof.
  return jsonb_build_object('kind','eligible','authority',v->'authority','render',r,
    'composition',case when reminder then case when incomplete then 'reminder_with_intake' else 'reminder_only' end else 'intake_only' end,
    'intakeId',case when incomplete then v->'latest'->0->'id' else 'null'::jsonb end,
    'legacyAttempts',v->'legacyAttempts','legacyClaimed',v->'legacyClaimed','legacySent',v->'legacySent');
end;
$$;

-- Existing parent lock order only; snapshot above never adds lock edges.
create function appointment_email_private.lock_authority_scope(p_studio uuid,p_appointment uuid,p_purpose text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare v_client uuid; v_locked_client uuid;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode='25001',message='email authority requires read committed';
  end if;
  perform 1 from public.studios where id=p_studio for no key update;
  if not found then return jsonb_build_object('kind','held','reason','missing_scope'); end if;
  select client_id into v_client from public.appointments where id=p_appointment and studio_id=p_studio;
  if not found then return jsonb_build_object('kind','held','reason','missing_scope'); end if;
  perform 1 from public.clients where id=v_client and studio_id=p_studio for no key update;
  if not found then return jsonb_build_object('kind','held','reason','missing_scope'); end if;
  insert into appointment_email_private.intake_epochs(studio_id,client_id) values(p_studio,v_client) on conflict do nothing;
  perform 1 from appointment_email_private.intake_epochs where studio_id=p_studio and client_id=v_client for no key update;
  select client_id into v_locked_client from public.appointments where id=p_appointment and studio_id=p_studio for no key update;
  if not found or v_locked_client is distinct from v_client then return jsonb_build_object('kind','held','reason','scope_changed'); end if;
  return jsonb_build_object('kind','locked');
end;
$$;

-- Separate lock acquisition from transient rendering so late original
-- observations can retain evidence even when current render validation fails.
create function appointment_email_private.read_authority(p_studio uuid,p_appointment uuid,p_purpose text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare v jsonb;
begin
  v := appointment_email_private.lock_authority_scope(p_studio,p_appointment,p_purpose);
  if v->>'kind' <> 'locked' then return v; end if;
  return appointment_email_private.snapshot_authority(p_studio,p_appointment,p_purpose);
end;
$$;

create function public.inspect_appointment_email_operation(p_studio_id uuid,p_appointment_id uuid,p_purpose text)
returns jsonb language sql security definer
set search_path = pg_catalog, pg_temp as $$
  select appointment_email_private.read_authority(p_studio_id,p_appointment_id,p_purpose);
$$;

create function public.prepare_appointment_email_operation(
  p_studio_id uuid,p_appointment_id uuid,p_purpose text,p_provider_account text,p_expected_authority jsonb
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare v jsonb; o appointment_email_private.operations%rowtype; n integer;
begin
  if p_provider_account is null or p_provider_account !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$' then return jsonb_build_object('kind','held','reason','invalid_input'); end if;
  v := appointment_email_private.read_authority(p_studio_id,p_appointment_id,p_purpose);
  if v->>'kind' <> 'eligible' then return v; end if;
  if p_expected_authority is distinct from v->'authority' then return jsonb_build_object('kind','held','reason','stale_authority'); end if;
  insert into appointment_email_private.cohorts(studio_id,appointment_id,purpose,attempts)
    values(p_studio_id,p_appointment_id,p_purpose,least(3,(v->>'legacyAttempts')::integer)) on conflict do nothing;
  select attempts into n from appointment_email_private.cohorts where studio_id=p_studio_id and appointment_id=p_appointment_id and purpose=p_purpose for no key update;
  select * into o from appointment_email_private.operations where studio_id=p_studio_id and appointment_id=p_appointment_id and purpose=p_purpose and state in ('prepared','unknown','accepted') for no key update;
  if found then
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

create function public.authorize_appointment_email_operation(
  p_operation_id uuid,p_lease_token uuid,p_authority jsonb,p_provider_account text,p_provider_key uuid,
  p_request_digest text,p_capability_digest text,p_expected_render jsonb
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare o appointment_email_private.operations%rowtype; v jsonb; n integer; t timestamptz;
begin
  if p_request_digest is null or p_capability_digest is null or p_request_digest !~ '^[a-f0-9]{64}$' or p_capability_digest !~ '^[a-f0-9]{64}$' then return jsonb_build_object('kind','held'); end if;
  select * into o from appointment_email_private.operations where id=p_operation_id;
  if not found then return jsonb_build_object('kind','held'); end if;
  v := appointment_email_private.read_authority(o.studio_id,o.appointment_id,o.purpose);
  if v->>'kind' <> 'eligible' then return jsonb_build_object('kind','held'); end if;
  select attempts into n from appointment_email_private.cohorts where studio_id=o.studio_id and appointment_id=o.appointment_id and purpose=o.purpose for no key update;
  select * into o from appointment_email_private.operations where id=p_operation_id for no key update;
  -- Final current projection in ONE fresh snapshot AFTER all lock waits.
  -- Current-render linearization is here, not at SDK/delivery. Existing
  -- parent/cohort/operation locks stay held through debit/grant.
  v := appointment_email_private.snapshot_authority(o.studio_id,o.appointment_id,o.purpose);
  if v->>'kind' <> 'eligible' or p_expected_render is null or
    p_expected_render is distinct from v->'render' then return jsonb_build_object('kind','held'); end if;
  if o.state <> 'prepared' or o.first_possible_attempt_at is not null or o.lease_token is distinct from p_lease_token or
     o.lease_expires_at <= clock_timestamp() or o.authority is distinct from p_authority or o.authority is distinct from v->'authority' or
     o.provider_account is distinct from p_provider_account or o.provider_key is distinct from p_provider_key or
     o.composition <> v->>'composition' or v->'legacySent' <> 'null'::jsonb or v->'legacyClaimed' <> 'null'::jsonb or
     n is null or greatest(n,(v->>'legacyAttempts')::integer) >= 3 then return jsonb_build_object('kind','held'); end if;
  t := clock_timestamp();
  update appointment_email_private.cohorts set attempts=greatest(n,(v->>'legacyAttempts')::integer)+1
    where studio_id=o.studio_id and appointment_id=o.appointment_id and purpose=o.purpose returning attempts into n;
  if o.purpose='reminder_24h' then
    update public.appointments set reminder_24h_send_attempts=n,reminder_24h_claimed_at=t where id=o.appointment_id and studio_id=o.studio_id;
  else
    update public.appointments set reminder_2h_send_attempts=n,reminder_2h_claimed_at=t where id=o.appointment_id and studio_id=o.studio_id;
  end if;
  update appointment_email_private.operations set state='unknown',request_digest=p_request_digest,capability_digest=p_capability_digest,
    authorization_lease_token=p_lease_token,first_possible_attempt_at=t where id=o.id;
  -- Commit this transaction before SDK. Lost reply => held; NEVER refund or
  -- reauthorize on the strength of an expired lease or a new generation.
  return jsonb_build_object('kind','authorized','firstPossibleAttemptAt',t,'retryNotAfter',null,'attemptNumber',n);
end;
$$;

create function public.observe_appointment_email_operation(
  p_operation_id uuid,p_original_lease uuid,p_authority jsonb,p_provider_account text,p_provider_key uuid,
  p_request_digest text,p_capability text,p_outcome text,p_provider_message_id text,p_original_render jsonb
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare o appointment_email_private.operations%rowtype; v jsonb; projected integer := 0;
begin
  if p_capability is null or p_capability !~ '^[a-f0-9]{64}$' or p_outcome is null or p_outcome not in ('accepted','unknown','definite_refusal') or
    (p_outcome='accepted' and (p_provider_message_id is null or p_provider_message_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$')) then return jsonb_build_object('kind','held'); end if;
  select * into o from appointment_email_private.operations where id=p_operation_id;
  if not found then return jsonb_build_object('kind','held'); end if;
  -- Existing parent/cohort/operation order, with NO render query before waits.
  -- Missing/ineligible current parents must not discard original evidence.
  v := appointment_email_private.lock_authority_scope(o.studio_id,o.appointment_id,o.purpose);
  perform 1 from appointment_email_private.cohorts where studio_id=o.studio_id and appointment_id=o.appointment_id and purpose=o.purpose for no key update;
  select * into o from appointment_email_private.operations where id=p_operation_id for no key update;
  if o.first_possible_attempt_at is null or o.authorization_lease_token is distinct from p_original_lease or o.authority is distinct from p_authority or
    o.provider_account is distinct from p_provider_account or o.provider_key is distinct from p_provider_key or o.request_digest is distinct from p_request_digest or
    o.capability_digest is distinct from encode(sha256(convert_to(p_capability,'UTF8')),'hex') then return jsonb_build_object('kind','held'); end if;
  if o.state='accepted' then return jsonb_build_object('kind','accepted_retained','projection','unchanged'); end if;
  if p_outcome='accepted' then
    update appointment_email_private.operations set state='accepted',provider_message_id=p_provider_message_id where id=o.id;
  elsif p_outcome='unknown' or o.unknown_observed then
    update appointment_email_private.operations set state='unknown',unknown_observed=true where id=o.id;
    return jsonb_build_object('kind','unknown_held');
  else
    update appointment_email_private.operations set state='refused' where id=o.id;
  end if;
  -- p_original_render is transient and comes ONLY from the original frozen
  -- request held by the trusted adapter's original capability. SQL verifies
  -- that capability/request/account tuple above, but cannot independently
  -- attest HTML or prove an arbitrary supplied JSON object was its rendering.
  -- A missing binding never prevents retaining valid original accepted truth.
  if p_original_render is null or jsonb_typeof(p_original_render) <> 'object' then
    return jsonb_build_object('kind',case when p_outcome='accepted' then 'accepted_retained' else 'refusal_recorded' end,'projection','unverified');
  end if;
  if v->>'kind' <> 'locked' then
    return jsonb_build_object('kind',case when p_outcome='accepted' then 'accepted_retained' else 'refusal_recorded' end,'projection','superseded');
  end if;
  begin
    -- Fresh single current-render snapshot AFTER ALL existing row-lock waits.
    -- Read/validation failure does not roll back the original observation
    -- written outside this sub-block; no clinical pair/hash is persisted.
    v := appointment_email_private.snapshot_authority(o.studio_id,o.appointment_id,o.purpose);
  exception when others then
    return jsonb_build_object('kind',case when p_outcome='accepted' then 'accepted_retained' else 'refusal_recorded' end,'projection','unverified');
  end;
  if v->>'kind'='eligible' and v->'authority'=o.authority and v->>'composition'=o.composition and
    v->'render'=p_original_render and o.lease_token=p_original_lease and o.lease_expires_at > clock_timestamp() then
    if o.purpose='reminder_24h' then
      update public.appointments set reminder_24h_sent_at=case when p_outcome='accepted' then clock_timestamp() else reminder_24h_sent_at end,reminder_24h_claimed_at=null
        where id=o.appointment_id and studio_id=o.studio_id and email_operation_revision::text=o.authority->>'appointment' and reminder_24h_claimed_at=o.first_possible_attempt_at;
    else
      update public.appointments set reminder_2h_sent_at=case when p_outcome='accepted' then clock_timestamp() else reminder_2h_sent_at end,reminder_2h_claimed_at=null
        where id=o.appointment_id and studio_id=o.studio_id and email_operation_revision::text=o.authority->>'appointment' and reminder_2h_claimed_at=o.first_possible_attempt_at;
    end if;
    get diagnostics projected = row_count;
  end if;
  return jsonb_build_object('kind',case when p_outcome='accepted' then 'accepted_retained' else 'refusal_recorded' end,
    'projection',case when projected=1 then 'current' else 'superseded' end);
end;
$$;

create function public.retire_unattempted_appointment_email_operation(p_operation_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare o appointment_email_private.operations%rowtype;
begin
  select * into o from appointment_email_private.operations where id=p_operation_id;
  if not found then return jsonb_build_object('kind','held'); end if;
  perform appointment_email_private.read_authority(o.studio_id,o.appointment_id,o.purpose);
  perform 1 from appointment_email_private.cohorts where studio_id=o.studio_id and appointment_id=o.appointment_id and purpose=o.purpose for no key update;
  select * into o from appointment_email_private.operations where id=p_operation_id for no key update;
  if o.state <> 'prepared' or o.first_possible_attempt_at is not null or o.authorization_lease_token is not null or o.lease_token is distinct from p_lease_token then return jsonb_build_object('kind','held'); end if;
  update appointment_email_private.operations set state='retired' where id=o.id;
  return jsonb_build_object('kind','retired');
end;
$$;

-- Forward-only compatibility closure. The reminder scheduler MUST be drained
-- before a separately approved apply. Never reopen these as rollback/fallback.
revoke execute on function public.claim_email_send(uuid,text) from public, anon, authenticated, service_role;
revoke execute on function public.record_email_result(uuid,text,boolean) from public, anon, authenticated, service_role;
create or replace function public.record_email_attempt(p_appointment_id uuid,p_email_type text,p_success boolean)
returns void language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_email_type='confirmation' then
    update public.appointments set confirmation_send_attempts=confirmation_send_attempts+1,
      confirmation_sent_at=case when p_success then now() else confirmation_sent_at end where id=p_appointment_id;
  elsif p_email_type='no_show' then
    update public.appointments set no_show_email_send_attempts=no_show_email_send_attempts+1,
      no_show_email_sent_at=case when p_success then now() else no_show_email_sent_at end where id=p_appointment_id;
  else raise exception using errcode='42501',message='legacy reminder writing disabled';
  end if;
end;
$$;

-- Supabase default grants are not authority. Close ALL four roles before
-- granting only these exact trusted-server commands. No generic table writer.
revoke execute on all functions in schema appointment_email_private from public, anon, authenticated, service_role;
revoke execute on function public.inspect_appointment_email_operation(uuid,uuid,text) from public, anon, authenticated, service_role;
revoke execute on function public.prepare_appointment_email_operation(uuid,uuid,text,text,jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.authorize_appointment_email_operation(uuid,uuid,jsonb,text,uuid,text,text,jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.observe_appointment_email_operation(uuid,uuid,jsonb,text,uuid,text,text,text,text,jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.retire_unattempted_appointment_email_operation(uuid,uuid) from public, anon, authenticated, service_role;
revoke execute on function public.record_email_attempt(uuid,text,boolean) from public, anon, authenticated, service_role;
grant execute on function public.inspect_appointment_email_operation(uuid,uuid,text) to service_role;
grant execute on function public.prepare_appointment_email_operation(uuid,uuid,text,text,jsonb) to service_role;
grant execute on function public.authorize_appointment_email_operation(uuid,uuid,jsonb,text,uuid,text,text,jsonb) to service_role;
grant execute on function public.observe_appointment_email_operation(uuid,uuid,jsonb,text,uuid,text,text,text,text,jsonb) to service_role;
grant execute on function public.retire_unattempted_appointment_email_operation(uuid,uuid) to service_role;
grant execute on function public.record_email_attempt(uuid,text,boolean) to service_role;
commit;
