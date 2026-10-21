-- CLN-001 / CLN-003. OPS allocation 2026-10-21: source only, not apply authority.
-- Legacy revision 0 is a concurrency baseline, NOT a historical edit count.
-- Existing 0015/0118/0162 triggers and terminal review rules remain intact.
begin;
set local lock_timeout = '5s';

alter table public.client_intake_forms
  add column revision bigint not null default 0 check (revision >= 0);

create function public.advance_intake_revision()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.revision := 0;
  else
    -- Ignore caller-supplied counters. This also invalidates stale editors on
    -- notes/review/link writes without exempting any existing terminal guard.
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;

create trigger client_intake_forms_advance_revision
  before insert or update on public.client_intake_forms
  for each row execute function public.advance_intake_revision();

revoke execute on function public.advance_intake_revision() from public, anon, authenticated, service_role;

-- Called ONLY by existing server actions after token or active-practitioner
-- authorization and canonical answers/consent/provenance validation. IDs and
-- profile contributions are resolved/derived by that server, not a browser.
-- Both public and assisted editors must name the revision they actually saw.
create function public.write_intake_revision(
  p_intake_id uuid,
  p_studio_id uuid,
  p_client_id uuid,
  p_expected_revision bigint,
  p_responses jsonb,
  p_step integer,
  p_operation text,
  p_profile jsonb default '{}'::jsonb
)
returns table (outcome text, new_revision text)
language plpgsql security invoker set search_path = ''
as $$
declare
  v_intake public.client_intake_forms%rowtype;
  v_revision text;
  v_profile_key text;
begin
  if p_expected_revision is null or p_expected_revision < 0
     or p_step is null or p_step not between 1 and 5
     or p_operation is null or p_operation not in ('save', 'submit', 'handoff')
     or p_responses is null or jsonb_typeof(p_responses) <> 'object'
     or p_profile is null or jsonb_typeof(p_profile) <> 'object' then
    return query select 'invalid_request'::text, null::text;
    return;
  end if;
  for v_profile_key in select jsonb_object_keys(p_profile) loop
    if v_profile_key not in (
      'emergency_contact_name', 'emergency_contact_phone', 'date_of_birth',
      'pronouns', 'address', 'allergy_text'
    ) or jsonb_typeof(p_profile -> v_profile_key) not in ('string', 'null') then
      return query select 'invalid_request'::text, null::text;
      return;
    end if;
  end loop;
  if (p_operation <> 'submit' and p_profile <> '{}'::jsonb)
     or (p_operation in ('submit', 'handoff') and p_step <> 5) then
    return query select 'invalid_request'::text, null::text;
    return;
  end if;

  -- Always intake first, client second: the same lock order on every path.
  select f.* into v_intake from public.client_intake_forms f
    where f.id = p_intake_id and f.studio_id = p_studio_id
      and f.client_id = p_client_id and f.deleted_at is null
    for update;
  if not found then
    -- Wrong scope never discloses existence, answers or another revision.
    return query select 'not_available'::text, null::text;
    return;
  end if;
  if v_intake.status <> 'in_progress' then
    -- A repeat can acknowledge terminal state, NEVER that new answers saved.
    return query select 'terminal'::text, null::text;
    return;
  end if;
  if v_intake.revision <> p_expected_revision then
    return query select 'conflict'::text, null::text;
    return;
  end if;

  if p_operation = 'submit' then
    perform 1 from public.clients c
      where c.id = p_client_id and c.studio_id = p_studio_id for update;
    if not found then
      return query select 'not_available'::text, null::text;
      return;
    end if;
  end if;

  update public.client_intake_forms f
    set responses = p_responses, current_step = p_step,
        status = case when p_operation = 'submit' then 'submitted' else f.status end,
        submitted_at = case when p_operation = 'submit' then transaction_timestamp() else f.submitted_at end
    where f.id = p_intake_id and f.studio_id = p_studio_id
      and f.client_id = p_client_id and f.deleted_at is null
      and f.status = 'in_progress' and f.revision = p_expected_revision
    returning f.revision::text into v_revision;
  if not found then
    return query select 'conflict'::text, null::text;
    return;
  end if;

  if p_operation = 'submit' then
    -- Merge from the CURRENT locked client, never an application snapshot.
    -- Any error rolls back the submission too. Only the new submit winner
    -- reaches this append; terminal repeats cannot duplicate it.
    update public.clients c set
      emergency_contact_name = case when nullif(btrim(c.emergency_contact_name), '') is null
        then nullif(btrim(p_profile ->> 'emergency_contact_name'), '') else c.emergency_contact_name end,
      emergency_contact_phone = case when nullif(btrim(c.emergency_contact_phone), '') is null
        then nullif(btrim(p_profile ->> 'emergency_contact_phone'), '') else c.emergency_contact_phone end,
      date_of_birth = coalesce(c.date_of_birth, nullif(p_profile ->> 'date_of_birth', '')::date),
      pronouns = case when nullif(btrim(c.pronouns), '') is null
        then nullif(btrim(p_profile ->> 'pronouns'), '') else c.pronouns end,
      address = case when nullif(btrim(c.address), '') is null
        then nullif(btrim(p_profile ->> 'address'), '') else c.address end,
      allergies = case when nullif(btrim(p_profile ->> 'allergy_text'), '') is null then c.allergies
        when nullif(btrim(c.allergies), '') is null then p_profile ->> 'allergy_text'
        else c.allergies || E'\n\nFrom client intake (' || current_date::text || E'):\n' || (p_profile ->> 'allergy_text') end
      where c.id = p_client_id and c.studio_id = p_studio_id;
    if not found then
      raise exception 'Intake profile update unavailable' using errcode = 'check_violation';
    end if;
  end if;

  return query select case when p_operation = 'submit' then 'submitted' else 'saved' end, v_revision;
end;
$$;

revoke execute on function public.write_intake_revision(uuid, uuid, uuid, bigint, jsonb, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.write_intake_revision(uuid, uuid, uuid, bigint, jsonb, integer, text, jsonb) to service_role;

commit;
