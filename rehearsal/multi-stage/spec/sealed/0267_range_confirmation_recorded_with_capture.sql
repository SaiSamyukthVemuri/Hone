-- 0267 / HON-8: a practitioner's confirmation of a value outside a documented
-- range is RECORDED WITH THE CAPTURE it belongs to.
--
-- PREPARE-ONLY. Additive: one table, one command. No backfill, no change to
-- any existing function, no change to what a capture or a reading means, and
-- nothing is applied without its own stage approval. Reservation: OPS, 0267.
--
-- WHAT THE PRODUCT DECISION IS (Sam, via OPS): reject malformed or
-- type/unit-incompatible input; a value outside a documented manufacturer
-- range WARNS and requires the practitioner's explicit confirmation, recorded
-- with the capture; a value is never clamped; there is no blanket
-- negative-value rule. The application already warns and records the value
-- exactly as submitted (lib/machines/validate-reading.ts, a note not a
-- refusal). What was missing is the durable fact that the practitioner SAW the
-- warning and confirmed.
--
-- WHAT THIS DOES NOT CLAIM. The database holds no documented ranges (they live
-- in the application's profile), so it CANNOT verify that a value really is out
-- of range. It records an attributable assertion: which reading, the exact
-- value, which warning code the practitioner was shown, who confirmed and when.
-- It does verify everything it can see: the capture is in the caller's own
-- scope, the caller recorded it, the named reading exists in that capture with
-- exactly that numeric value, and the confirmation arrives soon after the
-- capture rather than being back-filled later.
--
-- NOT ATOMIC WITH THE CAPTURE, and said so. The capture commands return a count
-- and mint ids inside, so the capture id is not known before they run; this is
-- a second call. A capture can therefore exist without its confirmation if that
-- call fails. The row is absent rather than wrong: the application must report
-- the failure and retry, and an out-of-range reading with no confirmation row is
-- detectable. Folding it into the capture commands would mean re-sealing three
-- large functions for a marginal gain.
begin;
set local lock_timeout = '5s';

create table public.treatment_setup_range_confirmations (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  capture_id uuid not null
    references public.treatment_setup_captures(id) on delete cascade,
  session_block_id uuid not null
    references public.session_blocks(id) on delete cascade,
  stage_key text
    check (stage_key is null or length(btrim(stage_key)) between 1 and 60),
  field_key text not null check (length(btrim(field_key)) between 1 and 60),
  -- The exact value the practitioner confirmed, as the reading stores it.
  confirmed_value numeric not null,
  -- Which warning she was shown. Closed set: the three note codes that mean
  -- "outside a documented range". A hardware limit is a refusal, never a note.
  note_code text not null check (note_code in (
    'outside_published_specification',
    'recommended_protocol_only',
    'documentation_discrepancy'
  )),
  confirmed_by_practitioner_id uuid not null,
  confirmed_at timestamptz not null default now()
);

-- 0179's law: an ACTOR reference is composite and same-studio.
alter table public.treatment_setup_range_confirmations
  add constraint treatment_setup_range_confirmations_actor_same_studio_fk
  foreign key (confirmed_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict;

-- One confirmation per reading of a capture. A capture cannot be confirmed
-- twice or re-confirmed with a different code.
create unique index treatment_setup_range_confirmations_reading_uniq
  on public.treatment_setup_range_confirmations
  (capture_id, coalesce(stage_key, ''), field_key);

create index treatment_setup_range_confirmations_block_idx
  on public.treatment_setup_range_confirmations (session_block_id);

create or replace function public.refuse_range_confirmation_update()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception
    'A recorded range confirmation is immutable.'
    using errcode = 'restrict_violation';
end;
$$;

create trigger treatment_setup_range_confirmations_immutable
  before update on public.treatment_setup_range_confirmations
  for each row execute function public.refuse_range_confirmation_update();

alter table public.treatment_setup_range_confirmations enable row level security;

create policy "treatment_setup_range_confirmations_member_select"
  on public.treatment_setup_range_confirmations for select to authenticated
  using (public.is_studio_member(treatment_setup_range_confirmations.studio_id));

revoke all on public.treatment_setup_range_confirmations from public;
revoke all on public.treatment_setup_range_confirmations from anon;
revoke all on public.treatment_setup_range_confirmations from authenticated;
revoke all on public.treatment_setup_range_confirmations from service_role;
grant select on public.treatment_setup_range_confirmations to authenticated;
grant select on public.treatment_setup_range_confirmations to service_role;

comment on table public.treatment_setup_range_confirmations is
  '0267. A practitioner''s explicit confirmation of a numeric reading outside a documented range, recorded against the capture it belongs to. An attributable assertion, NOT a database finding that the value is out of range (the database holds no ranges). Written only by record_setup_range_confirmations, append-only, clinical data.';

create or replace function public.record_setup_range_confirmations(
  p_capture_id uuid,
  -- [{ "stage_key": text|null, "field_key": text, "value": "<numeric>",
  --    "note_code": text }, ...]
  p_confirmations jsonb,
  -- THE AUTHORIZED ROUTE, required, exactly as the capture commands.
  p_session_id uuid,
  p_client_id uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_cap record;
  v_scope record;
  v_item jsonb;
  v_stage text;
  v_field text;
  v_value numeric;
  v_code text;
  v_count integer := 0;
begin
  if p_confirmations is null or jsonb_typeof(p_confirmations) <> 'array'
     or jsonb_array_length(p_confirmations) not between 1 and 200 then
    raise exception 'Give between 1 and 200 range confirmations.'
      using errcode = 'check_violation';
  end if;

  select c.studio_id, c.session_block_id, c.studio_machine_id,
         c.recorded_by_practitioner_id, c.recorded_at
    into v_cap
    from public.treatment_setup_captures c
   where c.id = p_capture_id;
  if not found then
    raise exception 'That capture does not exist.'
      using errcode = 'no_data_found';
  end if;

  -- The caller must be an active member in the capture's studio AND the block
  -- must be this client's session: the same proof every capture command makes.
  select * into v_scope
    from public.assert_setup_scope(
      v_cap.session_block_id, v_cap.studio_machine_id, p_session_id, p_client_id);

  -- ONLY THE PRACTITIONER WHO RECORDED THE CAPTURE confirms its values, and
  -- only soon after: a confirmation added later is not "recorded with the
  -- capture", it is a rewrite of what she saw.
  if v_cap.recorded_by_practitioner_id is distinct from v_scope.o_practitioner then
    raise exception 'Only the practitioner who recorded this capture can confirm its values.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_cap.recorded_at < now() - interval '10 minutes' then
    raise exception 'A range confirmation must be recorded with the capture, within 10 minutes of it.'
      using errcode = 'check_violation';
  end if;

  for v_item in select * from jsonb_array_elements(p_confirmations) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item->'field_key') is distinct from 'string'
       or jsonb_typeof(v_item->'value') is distinct from 'string'
       or jsonb_typeof(v_item->'note_code') is distinct from 'string'
       or (v_item ? 'stage_key'
           and jsonb_typeof(v_item->'stage_key') not in ('string', 'null')) then
      raise exception 'Each confirmation needs a field_key, a value and a note_code.'
        using errcode = 'check_violation';
    end if;
    v_stage := nullif(v_item->>'stage_key', '');
    v_field := v_item->>'field_key';
    v_code := v_item->>'note_code';
    begin
      v_value := (v_item->>'value')::numeric;
    exception when others then
      raise exception 'A confirmed value must be a number.'
        using errcode = 'check_violation';
    end;

    -- THE READING MUST EXIST IN THIS CAPTURE WITH THIS EXACT NUMBER. Nothing
    -- can be confirmed that was not recorded.
    if not exists (
      select 1 from public.treatment_setup_readings r
       where r.capture_id = p_capture_id
         and r.stage_key is not distinct from v_stage
         and r.field_key = v_field
         and r.value_numeric = v_value
    ) then
      raise exception 'No such reading with that value in this capture.'
        using errcode = 'no_data_found';
    end if;

    -- A repeat raises the unique violation rather than overwriting.
    insert into public.treatment_setup_range_confirmations (
      studio_id, capture_id, session_block_id, stage_key, field_key,
      confirmed_value, note_code, confirmed_by_practitioner_id
    ) values (
      v_scope.o_studio, p_capture_id, v_cap.session_block_id, v_stage, v_field,
      v_value, v_code, v_scope.o_practitioner
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.record_setup_range_confirmations(uuid, jsonb, uuid, uuid) is
  '0267. Records the recording practitioner''s confirmation of numeric readings outside a documented range, against one capture, within 10 minutes of it. Verifies scope, authorship, that each named reading exists in the capture with exactly that value, and a closed note code; does NOT verify the range (the database holds none). Append-only; a repeat raises a unique violation.';

revoke execute on function public.record_setup_range_confirmations(uuid, jsonb, uuid, uuid) from public;
revoke execute on function public.record_setup_range_confirmations(uuid, jsonb, uuid, uuid) from anon;
revoke execute on function public.record_setup_range_confirmations(uuid, jsonb, uuid, uuid) from authenticated;
revoke execute on function public.record_setup_range_confirmations(uuid, jsonb, uuid, uuid) from service_role;
grant execute on function public.record_setup_range_confirmations(uuid, jsonb, uuid, uuid) to authenticated;

commit;
