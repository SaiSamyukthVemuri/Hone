-- 0220 — STUDIO-READY-02c (#824): receptionist scheduling over the SHARED core.
--
-- A receptionist (0216, `studio_receptionists`) may create, move/reassign and
-- cancel a treating practitioner's booking. They are never a treating
-- practitioner and never borrow one's identity. This file gives them that
-- authority WITHOUT a second scheduling engine (contract §2.4 item 4):
--
--   1. Each of the three authoritative internal commands keeps its signature,
--      grants and every sentinel, and becomes a thin wrapper over ONE internal
--      core that takes a server-resolved ACTOR KIND. The core is the 0174 body
--      (unchanged since 0174, read from the live catalog on a fresh chain) with
--      its actor-resolution block generalized and the attribution writes made
--      kind-aware. For actor kind 'practitioner' every gate, lock order,
--      sentinel, write and audit row is what 0174 produced, pinned by the
--      existing suites (tests/db/*internal*/*move*/*cancel*).
--
--        create_internal_appointment_v2  -> create_appointment_core
--        move_or_reassign_appointment    -> move_appointment_core
--        practitioner_cancel_appointment -> cancel_appointment_core
--
--   2. Three NEW receptionist commands, granted to `authenticated` ONLY. Each
--      derives the actor from the signed-in user (receptionist_actor_id, 0216)
--      and passes it to the same core. Nothing the caller sends names the
--      actor. The receptionist kind:
--        * may target any ACTIVE owner or practitioner of the studio (never
--          themselves: they have no practitioners row);
--        * may NOT override duration or outside-hours availability (owner-only,
--          as for every non-owner);
--        * writes no appointment notes.
--
--   3. Attribution records the HUMAN actor:
--        * appointments.created_by_receptionist_id / cancelled_by_receptionist_id,
--          NULLABLE with NO DEFAULT, so create_public_appointment's explicit
--          11-column INSERT (0170) is unaffected. Composite same-studio FKs,
--          ON DELETE RESTRICT (the 0174 attribution convention), and a CHECK
--          that a row names at most one creator kind and one canceller kind;
--        * cancelled_by (the role word) admits 'receptionist';
--        * appointment_audit.actor_type admits 'receptionist', with a derived,
--          same-studio-validated actor_receptionist_id beside 0174's
--          actor_practitioner_id.
--
--   4. One projection for the booking form: the studio's active services and
--      bookable practitioners (receptionist_booking_options). Names, durations
--      and colours only: no price, no email, no clinical field.
--
--   5. revert_appointment_outcome (B4) also clears both canceller attribution
--      columns when it restores an appointment; nothing else in it changes.
--
-- NOT touched: create_public_appointment, reschedule_appointment_v2, public
-- cancellation, the slot files, WAIT round storage and the launch transaction.
-- DB/WAIT confirmed it re-emits none of the scheduling commands (#824). No row
-- is written at top level.
--
-- Migration 0220. 0219 is DB/WAIT's G1 queue position (#824).

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1) Attribution columns on public.appointments (nullable, no default).
-- ---------------------------------------------------------------------------
alter table public.appointments
  add column if not exists created_by_receptionist_id   uuid,
  add column if not exists cancelled_by_receptionist_id uuid;

comment on column public.appointments.created_by_receptionist_id is
  '0220. The receptionist who CREATED this appointment through receptionist_create_appointment. NULL otherwise. At most one creator kind per row (appointments_one_creator_kind_ck). Composite same-studio FK, ON DELETE RESTRICT.';
comment on column public.appointments.cancelled_by_receptionist_id is
  '0220. The receptionist who CANCELLED this appointment through receptionist_cancel_appointment. NULL otherwise. Complements the cancelled_by role word (''receptionist''). Composite same-studio FK, ON DELETE RESTRICT.';

alter table public.appointments
  drop constraint if exists appointments_created_by_receptionist_same_studio_fk;
alter table public.appointments
  add constraint appointments_created_by_receptionist_same_studio_fk
  foreign key (created_by_receptionist_id, studio_id)
  references public.studio_receptionists (id, studio_id)
  on delete restrict;

alter table public.appointments
  drop constraint if exists appointments_cancelled_by_receptionist_same_studio_fk;
alter table public.appointments
  add constraint appointments_cancelled_by_receptionist_same_studio_fk
  foreign key (cancelled_by_receptionist_id, studio_id)
  references public.studio_receptionists (id, studio_id)
  on delete restrict;

-- The columns are new and empty, so both checks VALIDATE immediately.
alter table public.appointments
  drop constraint if exists appointments_one_creator_kind_ck;
alter table public.appointments
  add constraint appointments_one_creator_kind_ck
  check (created_by_practitioner_id is null or created_by_receptionist_id is null);

alter table public.appointments
  drop constraint if exists appointments_one_canceller_kind_ck;
alter table public.appointments
  add constraint appointments_one_canceller_kind_ck
  check (cancelled_by_practitioner_id is null or cancelled_by_receptionist_id is null);

-- cancelled_by only WIDENS: every existing row stays valid.
alter table public.appointments
  drop constraint if exists appointments_cancelled_by_check;
alter table public.appointments
  add constraint appointments_cancelled_by_check
  check (cancelled_by in ('client', 'practitioner', 'owner', 'receptionist') or cancelled_by is null);

-- ---------------------------------------------------------------------------
-- 2) The audit actor model gains 'receptionist'.
-- ---------------------------------------------------------------------------
alter table public.appointment_audit
  add column if not exists actor_receptionist_id uuid;

comment on column public.appointment_audit.actor_receptionist_id is
  '0220. Durable receptionist correlation for actor_type=''receptionist'' rows, derived and same-studio-validated at INSERT by appointment_audit_derive_trusted_fields(). NULL for every other actor. Never accepted from the caller.';

alter table public.appointment_audit
  drop constraint if exists appointment_audit_actor_receptionist_same_studio_fk;
alter table public.appointment_audit
  add constraint appointment_audit_actor_receptionist_same_studio_fk
  foreign key (actor_receptionist_id, studio_id)
  references public.studio_receptionists (id, studio_id)
  on delete restrict;

alter table public.appointment_audit
  drop constraint if exists appointment_audit_actor_receptionist_type_ck;
alter table public.appointment_audit
  add constraint appointment_audit_actor_receptionist_type_ck
  check (actor_receptionist_id is null or actor_type = 'receptionist');

alter table public.appointment_audit
  drop constraint if exists appointment_audit_actor_type_check;
alter table public.appointment_audit
  add constraint appointment_audit_actor_type_check
  check (actor_type in ('practitioner', 'client', 'system', 'receptionist'));

-- 0174 left this NOT VALID on purpose (history unmeasured). It stays NOT VALID:
-- the new arm is added, and nothing about history is asserted.
alter table public.appointment_audit
  drop constraint if exists appointment_audit_actor_id_type_ck;
alter table public.appointment_audit
  add constraint appointment_audit_actor_id_type_ck
  check (
    (actor_type in ('practitioner', 'receptionist') and actor_id is not null)
    or (actor_type in ('client', 'system') and actor_id is null)
  )
  not valid;

comment on constraint appointment_audit_actor_id_type_ck on public.appointment_audit is
  'B5/0174, widened 0220 for receptionist actors. Correlates the historical bare actor_id with actor_type. Deliberately NOT VALID: production may hold rows written by since-dropped commands (e.g. finalize_card_required_public_booking, dropped 0091:174) and no production probe was performed. Enforced for every new row.';

-- The 0174 trusted-field trigger, with ONE addition: the receptionist
-- correlation, derived exactly as the practitioner one is. Steps 1-3 are 0174's.
create or replace function public.appointment_audit_derive_trusted_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_studio_id uuid;
begin
  -- 1. Tenancy: always derived from the parent when there is one.
  if new.appointment_id is not null then
    select a.studio_id into v_studio_id
      from public.appointments a
     where a.id = new.appointment_id;

    if v_studio_id is null then
      raise exception
        'appointment_audit: appointment % does not exist; cannot derive studio_id.',
        new.appointment_id
        using errcode = 'foreign_key_violation';
    end if;

    new.studio_id := v_studio_id;
  end if;

  if new.studio_id is null then
    raise exception
      'appointment_audit: studio_id could not be derived and none was supplied.'
      using errcode = 'not_null_violation';
  end if;

  -- 2. Time: ALWAYS the database clock.
  new.created_at := now();

  -- 3. Practitioner correlation (0174, unchanged).
  if new.actor_type = 'practitioner'
     and new.actor_id is not null
     and exists (
       select 1 from public.practitioners pr
        where pr.id = new.actor_id
          and pr.studio_id = new.studio_id
     )
  then
    new.actor_practitioner_id := new.actor_id;
  else
    new.actor_practitioner_id := null;
  end if;

  -- 4. Receptionist correlation (0220): the same rule against
  --    studio_receptionists. Overwrites any caller-supplied value.
  if new.actor_type = 'receptionist'
     and new.actor_id is not null
     and exists (
       select 1 from public.studio_receptionists sr
        where sr.id = new.actor_id
          and sr.studio_id = new.studio_id
     )
  then
    new.actor_receptionist_id := new.actor_id;
  else
    new.actor_receptionist_id := null;
  end if;

  return new;
end;
$$;

revoke all on function public.appointment_audit_derive_trusted_fields() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) The shared cores. Internal: revoked from every API role, reachable only
--    through the definer wrappers below. p_actor_kind is never caller-chosen:
--    each wrapper passes a literal.
-- ---------------------------------------------------------------------------

-- 3.1 create_appointment_core: the 0174 body of create_internal_appointment_v2.
create or replace function public.create_appointment_core(
  p_actor_kind                 text,
  p_studio_id                  uuid,
  p_actor_id                   uuid,
  p_target_practitioner_id     uuid,
  p_client_id                  uuid,
  p_service_id                 uuid,
  p_starts_at                  timestamptz,
  p_cancellation_token_hash    text,
  p_notes                      text,
  p_duration_override_minutes  integer,
  p_allow_outside_availability boolean
)
returns table(result text, appointment_id uuid, starts_at timestamptz, ends_at timestamptz)
language plpgsql
security definer
set search_path to 'pg_catalog', 'pg_temp'
as $function$
declare
  v_cap          boolean;
  v_book         boolean;
  v_actor_role   text;
  v_service_dur  integer;
  v_duration     integer;
  v_ends_at      timestamptz;
  v_avail        text;
  v_appt_id      uuid;
  v_now          timestamptz := now();
begin
  select coalesce(s.practitioner_capacity_enabled, false),
         coalesce(s.practitioner_capacity_booking_enabled, false)
    into v_cap, v_book
    from public.studios s
   where s.id = p_studio_id
   for update;
  if not found then
    return query select 'studio_not_found'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  perform public.acquire_studio_capacity_lock(p_studio_id);

  if v_cap and not v_book then
    return query select 'booking_paused'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- ACTOR. 'practitioner' is the 0174 block, verbatim in effect. 'receptionist'
  -- requires an ACTIVE receptionist row of this studio, held FOR SHARE so a
  -- concurrent deactivation waits for this booking or wins before it; and it
  -- may never override (owner-only, as for every non-owner).
  if p_actor_kind = 'practitioner' then
    select pr.role into v_actor_role
      from public.practitioners pr
     where pr.id = p_actor_id and pr.studio_id = p_studio_id and pr.active = true;
    if v_actor_role is null then
      return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
      return;
    end if;
    if v_actor_role <> 'owner'
       and p_target_practitioner_id is distinct from p_actor_id then
      return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
      return;
    end if;
    if v_actor_role <> 'owner'
       and (p_duration_override_minutes is not null or p_allow_outside_availability) then
      return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
      return;
    end if;
  elsif p_actor_kind = 'receptionist' then
    perform 1
      from public.studio_receptionists sr
     where sr.id = p_actor_id and sr.studio_id = p_studio_id and sr.active
     for share;
    if not found then
      return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
      return;
    end if;
    if p_duration_override_minutes is not null or p_allow_outside_availability then
      return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
      return;
    end if;
    v_actor_role := 'receptionist';
  else
    return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if not exists (
    select 1 from public.practitioners pr
     where pr.id = p_target_practitioner_id and pr.studio_id = p_studio_id and pr.active = true
  ) then
    return query select 'invalid_practitioner'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if not exists (
    select 1 from public.clients c where c.id = p_client_id and c.studio_id = p_studio_id
  ) then
    return query select 'invalid_client'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  select sv.default_duration_minutes into v_service_dur
    from public.services sv
   where sv.id = p_service_id and sv.studio_id = p_studio_id and sv.active = true
   for update;
  if not found then
    return query select 'invalid_service'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_cap and not exists (
    select 1 from public.service_practitioners sp
     where sp.service_id = p_service_id and sp.practitioner_id = p_target_practitioner_id
  ) then
    return query select 'not_eligible'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if p_duration_override_minutes is not null then
    if p_duration_override_minutes < 15 or p_duration_override_minutes > 360
       or (p_duration_override_minutes % 15) <> 0 then
      return query select 'invalid_duration'::text, null::uuid, null::timestamptz, null::timestamptz;
      return;
    end if;
    v_duration := p_duration_override_minutes;
  else
    v_duration := v_service_dur;
  end if;
  if v_duration is null or v_duration <= 0 then
    return query select 'invalid_duration'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if p_starts_at is null or p_starts_at <= v_now then
    return query select 'invalid_time'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  v_ends_at := p_starts_at + make_interval(mins => v_duration);

  v_avail := public.validate_appointment_availability(
    p_studio_id, p_target_practitioner_id, p_service_id,
    p_starts_at, v_ends_at, null, p_allow_outside_availability
  );
  if v_avail <> 'ok' then
    return query select v_avail, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  insert into public.appointments
    (studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
     duration_minutes, status, notes, cancellation_token_hash,
     booked_outside_availability,
     created_by_practitioner_id,
     created_by_receptionist_id,
     outside_availability_authorized_by_practitioner_id,
     outside_availability_authorized_role,
     outside_availability_authorized_at)
  values
    (p_studio_id, p_target_practitioner_id, p_client_id, p_service_id, p_starts_at, v_ends_at,
     v_duration, 'confirmed', p_notes, p_cancellation_token_hash,
     p_allow_outside_availability,
     case when p_actor_kind = 'practitioner' then p_actor_id end,
     case when p_actor_kind = 'receptionist' then p_actor_id end,
     -- Only an owner can reach an exercised override (the gates above), so
     -- these stay practitioner-only by construction.
     case when p_allow_outside_availability then p_actor_id end,
     case when p_allow_outside_availability then v_actor_role end,
     case when p_allow_outside_availability then v_now end)
  returning id into v_appt_id;

  insert into public.appointment_audit (appointment_id, actor_type, actor_id, action, details)
  values (
    v_appt_id, p_actor_kind, p_actor_id, 'created',
    jsonb_build_object(
      'source', case when p_actor_kind = 'receptionist'
                     then 'receptionist_booking_command'
                     else 'internal_booking_command_v2' end,
      'target_practitioner_id', p_target_practitioner_id,
      'duration_minutes', v_duration,
      'duration_overridden', (p_duration_override_minutes is not null),
      'outside_availability', p_allow_outside_availability
    )
  );

  return query select 'created'::text, v_appt_id, p_starts_at, v_ends_at;
  return;
end;
$function$;

-- 3.2 cancel_appointment_core: the 0174 body of practitioner_cancel_appointment.
create or replace function public.cancel_appointment_core(
  p_actor_kind     text,
  p_appointment_id uuid,
  p_studio_id      uuid,
  p_actor_id       uuid,
  p_reason         text
)
returns text
language plpgsql
security definer
set search_path to 'pg_catalog', 'pg_temp'
as $function$
declare
  v_role text;
  v_appt public.appointments%rowtype;
begin
  if p_actor_kind = 'practitioner' then
    select pr.role into v_role
      from public.practitioners pr
     where pr.id = p_actor_id
       and pr.studio_id = p_studio_id
       and pr.active = true;
    if not found then
      return 'not_authorized';
    end if;
  elsif p_actor_kind = 'receptionist' then
    perform 1
      from public.studio_receptionists sr
     where sr.id = p_actor_id and sr.studio_id = p_studio_id and sr.active
     for share;
    if not found then
      return 'not_authorized';
    end if;
    v_role := 'receptionist';
  else
    return 'not_authorized';
  end if;

  select * into v_appt
    from public.appointments a
   where a.id = p_appointment_id
     and a.studio_id = p_studio_id
   for update;
  if not found then
    return 'not_cancelable';
  end if;

  if v_appt.status = 'cancelled' then
    return 'already_cancelled';
  end if;

  if v_appt.status <> 'confirmed' then
    return 'not_cancelable';
  end if;

  -- Terminal-safe guard (0033): once an appointment has started, the outcomes
  -- are Mark Complete or Mark No-Show, never cancellation.
  if v_appt.starts_at <= now() then
    return 'not_cancelable';
  end if;

  update public.appointments
     set status              = 'cancelled',
         cancelled_at        = now(),
         cancelled_by        = v_role,
         cancelled_by_practitioner_id = case when p_actor_kind = 'practitioner' then p_actor_id end,
         cancelled_by_receptionist_id = case when p_actor_kind = 'receptionist' then p_actor_id end,
         cancellation_reason = p_reason,
         updated_at          = now()
   where id = p_appointment_id;

  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  ) values (
    p_appointment_id, p_actor_kind, p_actor_id, 'cancelled',
    jsonb_build_object(
      'reason', coalesce(p_reason, ''),
      'role',   v_role,
      'source', case when p_actor_kind = 'receptionist'
                     then 'receptionist_action'
                     else 'practitioner_action' end
    )
  );

  return 'cancelled';
end;
$function$;

-- 3.3 move_appointment_core: the 0174 body of move_or_reassign_appointment.
create or replace function public.move_appointment_core(
  p_actor_kind                 text,
  p_appointment_id             uuid,
  p_studio_id                  uuid,
  p_actor_id                   uuid,
  p_target_practitioner_id     uuid,
  p_expected_starts_at         timestamptz,
  p_expected_ends_at           timestamptz,
  p_new_starts_at              timestamptz,
  p_allow_outside_availability boolean
)
returns table(result text, appointment_id uuid, previous_starts_at timestamptz, previous_ends_at timestamptz, new_starts_at timestamptz, new_ends_at timestamptz, previous_practitioner_id uuid, new_practitioner_id uuid)
language plpgsql
security definer
set search_path to 'pg_catalog', 'pg_temp'
as $function$
declare
  v_cap        boolean;
  v_book       boolean;
  v_actor_role text;
  v_appt       public.appointments%rowtype;
  v_target     uuid;
  v_new_ends   timestamptz;
  v_reassign   boolean;
  v_time_move  boolean;
  v_avail      text;
  v_now        timestamptz := now();
begin
  select coalesce(s.practitioner_capacity_enabled, false),
         coalesce(s.practitioner_capacity_booking_enabled, false)
    into v_cap, v_book
    from public.studios s
   where s.id = p_studio_id
   for update;
  if not found then
    return query select 'studio_not_found'::text, null::uuid, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid;
    return;
  end if;
  perform public.acquire_studio_capacity_lock(p_studio_id);

  select * into v_appt
    from public.appointments a
   where a.id = p_appointment_id and a.studio_id = p_studio_id
   for update;
  if not found then
    return query select 'appointment_not_found'::text, null::uuid, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid;
    return;
  end if;

  v_target := coalesce(p_target_practitioner_id, v_appt.practitioner_id);

  if v_appt.status <> 'confirmed' or v_appt.starts_at <= v_now then
    return query select 'appointment_not_movable'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  if v_appt.starts_at is distinct from p_expected_starts_at
     or v_appt.ends_at is distinct from p_expected_ends_at then
    return query select 'stale_appointment'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  if p_new_starts_at is null or p_new_starts_at <= v_now then
    return query select 'invalid_time'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  v_reassign  := v_target is distinct from v_appt.practitioner_id;
  v_time_move := p_new_starts_at is distinct from v_appt.starts_at;

  if p_actor_kind = 'practitioner' then
    select pr.role into v_actor_role
      from public.practitioners pr
     where pr.id = p_actor_id and pr.studio_id = p_studio_id and pr.active = true;
    if v_actor_role is null then
      return query select 'not_authorized'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
        null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
      return;
    end if;
    if v_actor_role <> 'owner'
       and (v_appt.practitioner_id is distinct from p_actor_id or v_reassign) then
      return query select 'not_authorized'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
        null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
      return;
    end if;
    if p_allow_outside_availability and v_actor_role <> 'owner' then
      return query select 'not_authorized'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
        null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
      return;
    end if;
  elsif p_actor_kind = 'receptionist' then
    perform 1
      from public.studio_receptionists sr
     where sr.id = p_actor_id and sr.studio_id = p_studio_id and sr.active
     for share;
    if not found or p_allow_outside_availability then
      return query select 'not_authorized'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
        null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
      return;
    end if;
    -- The treating practitioner after this move, whether reassigned or kept,
    -- must be an ACTIVE owner or practitioner of this studio, with or without
    -- capacity mode (Codex P2 4244379181 on #862): a time-only move must not
    -- leave a booking on a deactivated practitioner either. The sentinels are
    -- the capacity branch's own.
    if not exists (
      select 1 from public.practitioners pr
       where pr.id = v_target and pr.studio_id = p_studio_id and pr.active = true
    ) then
      return query select
        case when v_reassign then 'invalid_practitioner' else 'practitioner_reassignment_required' end,
        v_appt.id, v_appt.starts_at, v_appt.ends_at,
        null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
      return;
    end if;
    v_actor_role := 'receptionist';
  else
    return query select 'not_authorized'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  if v_cap then
    if not exists (
      select 1 from public.practitioners pr
       where pr.id = v_target and pr.studio_id = p_studio_id and pr.active = true
    ) then
      return query select
        case when v_reassign then 'invalid_practitioner' else 'practitioner_reassignment_required' end,
        v_appt.id, v_appt.starts_at, v_appt.ends_at,
        null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
      return;
    end if;
    if v_appt.service_id is not null and not exists (
      select 1 from public.service_practitioners sp
       where sp.service_id = v_appt.service_id and sp.practitioner_id = v_target
    ) then
      return query select
        case when v_reassign then 'not_eligible' else 'practitioner_reassignment_required' end,
        v_appt.id, v_appt.starts_at, v_appt.ends_at,
        null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
      return;
    end if;
  end if;

  if not v_time_move and not v_reassign then
    return query select 'no_change'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      v_appt.starts_at, v_appt.ends_at, v_appt.practitioner_id, v_appt.practitioner_id;
    return;
  end if;

  if v_cap and not v_book then
    return query select 'booking_paused'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  v_new_ends := p_new_starts_at + make_interval(mins => v_appt.duration_minutes);

  v_avail := public.validate_appointment_availability(
    p_studio_id, v_target, v_appt.service_id,
    p_new_starts_at, v_new_ends, v_appt.id, p_allow_outside_availability
  );
  if v_avail <> 'ok' then
    return query select v_avail, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  update public.appointments
     set starts_at                   = p_new_starts_at,
         ends_at                     = v_new_ends,
         practitioner_id             = v_target,
         booked_outside_availability = p_allow_outside_availability,
         -- 0174: re-attribute the override to THIS move's authoriser, or clear
         -- it. A receptionist can never set the flag (gate above), so a
         -- receptionist move always clears a stale override.
         outside_availability_authorized_by_practitioner_id =
           case when p_allow_outside_availability then p_actor_id end,
         outside_availability_authorized_role =
           case when p_allow_outside_availability then v_actor_role end,
         outside_availability_authorized_at =
           case when p_allow_outside_availability then v_now end,
         updated_at                  = v_now
   where id = v_appt.id and studio_id = p_studio_id;

  insert into public.appointment_audit (appointment_id, actor_type, actor_id, action, details)
  values (
    v_appt.id, p_actor_kind, p_actor_id,
    case when v_reassign and v_time_move then 'moved_and_reassigned'
         when v_reassign then 'reassigned'
         else 'moved' end,
    jsonb_build_object(
      'source', case when p_actor_kind = 'receptionist'
                     then 'receptionist_move_command'
                     else 'internal_move_reassign_command' end,
      'previous_starts_at', v_appt.starts_at,
      'previous_ends_at', v_appt.ends_at,
      'new_starts_at', p_new_starts_at,
      'new_ends_at', v_new_ends,
      'previous_practitioner_id', v_appt.practitioner_id,
      'new_practitioner_id', v_target,
      'outside_availability', p_allow_outside_availability
    )
  );

  return query select
    case when v_reassign and v_time_move then 'moved_and_reassigned'
         when v_reassign then 'reassigned'
         else 'moved' end,
    v_appt.id, v_appt.starts_at, v_appt.ends_at, p_new_starts_at, v_new_ends,
    v_appt.practitioner_id, v_target;
  return;
end;
$function$;

revoke execute on function public.create_appointment_core(text, uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, integer, boolean) from public;
revoke execute on function public.create_appointment_core(text, uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, integer, boolean) from anon;
revoke execute on function public.create_appointment_core(text, uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, integer, boolean) from authenticated;
revoke execute on function public.create_appointment_core(text, uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, integer, boolean) from service_role;
revoke execute on function public.cancel_appointment_core(text, uuid, uuid, uuid, text) from public;
revoke execute on function public.cancel_appointment_core(text, uuid, uuid, uuid, text) from anon;
revoke execute on function public.cancel_appointment_core(text, uuid, uuid, uuid, text) from authenticated;
revoke execute on function public.cancel_appointment_core(text, uuid, uuid, uuid, text) from service_role;
revoke execute on function public.move_appointment_core(text, uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, boolean) from public;
revoke execute on function public.move_appointment_core(text, uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, boolean) from anon;
revoke execute on function public.move_appointment_core(text, uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, boolean) from authenticated;
revoke execute on function public.move_appointment_core(text, uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, boolean) from service_role;

-- ---------------------------------------------------------------------------
-- 4) The existing commands become wrappers. Signatures, return shapes and
--    grants are unchanged (CREATE OR REPLACE preserves the ACL; the revokes
--    below restate it).
-- ---------------------------------------------------------------------------
create or replace function public.create_internal_appointment_v2(
  p_studio_id uuid,
  p_actor_practitioner_id uuid,
  p_target_practitioner_id uuid,
  p_client_id uuid,
  p_service_id uuid,
  p_starts_at timestamp with time zone,
  p_cancellation_token_hash text,
  p_notes text default null::text,
  p_duration_override_minutes integer default null::integer,
  p_allow_outside_availability boolean default false
)
returns table(result text, appointment_id uuid, starts_at timestamp with time zone, ends_at timestamp with time zone)
language plpgsql
security definer
set search_path to 'pg_catalog', 'pg_temp'
as $function$
begin
  return query
    select * from public.create_appointment_core(
      'practitioner', p_studio_id, p_actor_practitioner_id, p_target_practitioner_id,
      p_client_id, p_service_id, p_starts_at, p_cancellation_token_hash, p_notes,
      p_duration_override_minutes, p_allow_outside_availability);
end;
$function$;

create or replace function public.practitioner_cancel_appointment(
  p_appointment_id uuid,
  p_studio_id uuid,
  p_practitioner_id uuid,
  p_reason text
)
returns text
language plpgsql
security definer
set search_path to 'pg_catalog', 'pg_temp'
as $function$
begin
  return public.cancel_appointment_core(
    'practitioner', p_appointment_id, p_studio_id, p_practitioner_id, p_reason);
end;
$function$;

create or replace function public.move_or_reassign_appointment(
  p_appointment_id uuid,
  p_studio_id uuid,
  p_actor_practitioner_id uuid,
  p_target_practitioner_id uuid,
  p_expected_starts_at timestamp with time zone,
  p_expected_ends_at timestamp with time zone,
  p_new_starts_at timestamp with time zone,
  p_allow_outside_availability boolean default false
)
returns table(result text, appointment_id uuid, previous_starts_at timestamp with time zone, previous_ends_at timestamp with time zone, new_starts_at timestamp with time zone, new_ends_at timestamp with time zone, previous_practitioner_id uuid, new_practitioner_id uuid)
language plpgsql
security definer
set search_path to 'pg_catalog', 'pg_temp'
as $function$
begin
  return query
    select * from public.move_appointment_core(
      'practitioner', p_appointment_id, p_studio_id, p_actor_practitioner_id,
      p_target_practitioner_id, p_expected_starts_at, p_expected_ends_at,
      p_new_starts_at, p_allow_outside_availability);
end;
$function$;

revoke execute on function public.create_internal_appointment_v2(uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, integer, boolean) from public;
revoke execute on function public.create_internal_appointment_v2(uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, integer, boolean) from anon;
revoke execute on function public.create_internal_appointment_v2(uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, integer, boolean) from authenticated;
grant execute on function public.create_internal_appointment_v2(uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, integer, boolean) to service_role;
revoke execute on function public.practitioner_cancel_appointment(uuid, uuid, uuid, text) from public;
revoke execute on function public.practitioner_cancel_appointment(uuid, uuid, uuid, text) from anon;
revoke execute on function public.practitioner_cancel_appointment(uuid, uuid, uuid, text) from authenticated;
grant execute on function public.practitioner_cancel_appointment(uuid, uuid, uuid, text) to service_role;
revoke execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, boolean) from public;
revoke execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, boolean) from anon;
revoke execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, boolean) from authenticated;
grant execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 5) The receptionist commands. Authenticated ONLY: the actor is the signed-in
--    user's active receptionist row of p_studio_id (receptionist_actor_id,
--    0216), never a caller-supplied id. A caller who is not one gets
--    'not_authorized' from the same sentinel set the core already returns.
-- ---------------------------------------------------------------------------
create or replace function public.receptionist_create_appointment(
  p_studio_id               uuid,
  p_target_practitioner_id  uuid,
  p_client_id               uuid,
  p_service_id              uuid,
  p_starts_at               timestamptz,
  p_cancellation_token_hash text
)
returns table(result text, appointment_id uuid, starts_at timestamptz, ends_at timestamptz)
language plpgsql
security definer
set search_path to 'pg_catalog', 'pg_temp'
as $function$
declare
  v_desk uuid := public.receptionist_actor_id(p_studio_id);
begin
  if v_desk is null then
    return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  -- No notes, no duration override, no outside-hours override.
  return query
    select * from public.create_appointment_core(
      'receptionist', p_studio_id, v_desk, p_target_practitioner_id,
      p_client_id, p_service_id, p_starts_at, p_cancellation_token_hash,
      null, null, false);
end;
$function$;

create or replace function public.receptionist_cancel_appointment(
  p_studio_id      uuid,
  p_appointment_id uuid,
  p_reason         text
)
returns text
language plpgsql
security definer
set search_path to 'pg_catalog', 'pg_temp'
as $function$
declare
  v_desk uuid := public.receptionist_actor_id(p_studio_id);
begin
  if v_desk is null then
    return 'not_authorized';
  end if;
  return public.cancel_appointment_core(
    'receptionist', p_appointment_id, p_studio_id, v_desk, p_reason);
end;
$function$;

create or replace function public.receptionist_move_appointment(
  p_studio_id              uuid,
  p_appointment_id         uuid,
  p_target_practitioner_id uuid,
  p_expected_starts_at     timestamptz,
  p_expected_ends_at       timestamptz,
  p_new_starts_at          timestamptz
)
returns table(result text, appointment_id uuid, previous_starts_at timestamptz, previous_ends_at timestamptz, new_starts_at timestamptz, new_ends_at timestamptz, previous_practitioner_id uuid, new_practitioner_id uuid)
language plpgsql
security definer
set search_path to 'pg_catalog', 'pg_temp'
as $function$
declare
  v_desk uuid := public.receptionist_actor_id(p_studio_id);
begin
  if v_desk is null then
    return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid;
    return;
  end if;
  return query
    select * from public.move_appointment_core(
      'receptionist', p_appointment_id, p_studio_id, v_desk,
      p_target_practitioner_id, p_expected_starts_at, p_expected_ends_at,
      p_new_starts_at, false);
end;
$function$;

-- 6) The booking-form projection. Same posture as the 0216 projections.
create or replace function public.receptionist_booking_options(p_studio_id uuid)
returns table (
  kind             text,
  id               uuid,
  name             text,
  duration_minutes integer,
  color            text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
begin
  if public.receptionist_actor_id(p_studio_id) is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- Fixed columns only: no price, no practitioner email, no clinical field.
  return query
    select 'service'::text, sv.id, sv.name, sv.default_duration_minutes, null::text
      from public.services sv
     where sv.studio_id = p_studio_id and sv.active = true
    union all
    select 'practitioner'::text, pr.id, pr.display_name, null::integer, pr.color
      from public.practitioners pr
     where pr.studio_id = p_studio_id and pr.active = true
    order by 1, 3;
end;
$function$;

revoke execute on function public.receptionist_create_appointment(uuid, uuid, uuid, uuid, timestamptz, text) from public;
revoke execute on function public.receptionist_create_appointment(uuid, uuid, uuid, uuid, timestamptz, text) from anon;
revoke execute on function public.receptionist_create_appointment(uuid, uuid, uuid, uuid, timestamptz, text) from service_role;
grant execute on function public.receptionist_create_appointment(uuid, uuid, uuid, uuid, timestamptz, text) to authenticated;
revoke execute on function public.receptionist_cancel_appointment(uuid, uuid, text) from public;
revoke execute on function public.receptionist_cancel_appointment(uuid, uuid, text) from anon;
revoke execute on function public.receptionist_cancel_appointment(uuid, uuid, text) from service_role;
grant execute on function public.receptionist_cancel_appointment(uuid, uuid, text) to authenticated;
revoke execute on function public.receptionist_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from public;
revoke execute on function public.receptionist_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from anon;
revoke execute on function public.receptionist_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from service_role;
grant execute on function public.receptionist_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) to authenticated;
revoke execute on function public.receptionist_booking_options(uuid) from public;
revoke execute on function public.receptionist_booking_options(uuid) from anon;
revoke execute on function public.receptionist_booking_options(uuid) from service_role;
grant execute on function public.receptionist_booking_options(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7) revert_appointment_outcome (B4, 0173) clears the canceller attribution.
--    Its live body, read from the catalog on a fresh chain, with ONLY two
--    assignments added to the existing UPDATE. Every gate, the 72-hour window,
--    the audit baseline, the sentinels and the single audit event are unchanged.
--    Without this a reverted receptionist (or practitioner) cancellation kept
--    naming its canceller on a confirmed appointment.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revert_appointment_outcome(p_appointment_id uuid, p_studio_id uuid, p_actor_user_id uuid, p_expected_status text, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
  -- Minimum meaningful reason, AFTER btrim. SQL owns normalisation; the client
  -- cannot satisfy this with whitespace.
  c_min_reason  constant integer  := 10;
  c_window      constant interval := interval '72 hours';

  v_practitioner_id uuid;
  v_role            text;
  v_reason          text;
  v_appt            public.appointments;
  v_blocking        text;
  v_baseline_action text;
  v_baseline_id     uuid;
  v_baseline_at     timestamptz;
  v_updated         integer;
begin
  -- GATE 1 — actor. Membership and role are derived here, never accepted from
  -- the caller. A non-member is refused before any appointment is looked at,
  -- so this command cannot be used to probe another studio's schedule.
  select r.practitioner_id, r.actor_role
    into v_practitioner_id, v_role
    from public.appointment_actor_role(p_studio_id, p_actor_user_id) r;
  if v_practitioner_id is null then
    return 'not_a_member';
  end if;
  if v_role <> 'owner' then
    return 'not_owner';
  end if;

  -- GATE 2 — the requested target must be a terminal status this command
  -- understands. Checked before any row is touched.
  if p_expected_status is null
     or p_expected_status not in ('completed', 'no_show', 'cancelled') then
    return 'not_terminal';
  end if;

  -- GATE 3 — reason. SQL owns the whitespace normalisation.
  v_reason := btrim(coalesce(p_reason, ''));
  if length(v_reason) < c_min_reason then
    return 'reason_too_short';
  end if;

  -- GATE 4 — lock. Cross-studio and unknown are indistinguishable.
  v_appt := public.lock_appointment_for_command(p_appointment_id, p_studio_id);
  if v_appt.id is null then
    return 'appointment_not_found';
  end if;

  -- GATE 5 — optimistic concurrency. The caller states the status it saw; if
  -- the row has moved since, refuse rather than overwrite. A second identical
  -- invocation lands here (the row is now 'confirmed') and is refused
  -- truthfully with `status_mismatch` rather than silently "succeeding".
  if v_appt.status <> p_expected_status then
    return 'status_mismatch';
  end if;

  -- GATE 6 — blocking dependents, checked independently of everything above.
  v_blocking := public.appointment_has_blocking_dependents(p_appointment_id, p_studio_id);
  if v_blocking is not null then
    return 'blocked_' || v_blocking;
  end if;

  -- GATE 7 — the audit baseline that established the CURRENT outcome, and the
  -- repair window measured from it. Absence REFUSES; it never permits.
  v_baseline_action := case v_appt.status
                         when 'completed' then 'marked_complete'
                         when 'no_show'   then 'marked_no_show'
                         when 'cancelled' then 'cancelled'
                       end;

  select aa.id, aa.created_at
    into v_baseline_id, v_baseline_at
    from public.appointment_audit aa
   where aa.appointment_id = p_appointment_id
     and aa.action = v_baseline_action
   order by aa.created_at desc, aa.id desc
   limit 1;

  if v_baseline_id is null then
    return 'no_audit_baseline';
  end if;

  -- Inclusive at exactly 72 hours: a repair AT the boundary is allowed.
  if now() - v_baseline_at > c_window then
    return 'repair_window_expired';
  end if;

  -- MUTATION. The expected status is repeated in the predicate so the
  -- concurrency check is enforced by the UPDATE itself, not merely by GATE 5.
  -- Re-arming the 0029 exclusion (and the 0030 shadow) can raise 23P01.
  begin
    update public.appointments a
       set status              = 'confirmed',
           cancellation_reason = null,
           cancelled_at        = null,
           cancelled_by        = null,
           -- 0220: a reverted appointment has no canceller. Both attribution
           -- columns are cleared with the role word (Codex P2 4244674652 on
           -- #862; 0174 GROUP 3.4 already states this rule for its backfill).
           cancelled_by_practitioner_id = null,
           cancelled_by_receptionist_id = null,
           updated_at          = now()
     where a.id = p_appointment_id
       and a.studio_id = p_studio_id
       and a.status = p_expected_status;
    get diagnostics v_updated = row_count;
  exception
    when exclusion_violation then       -- 23P01
      return 'slot_conflict';
  end;

  if v_updated <> 1 then
    -- Unreachable under the row lock held since GATE 4; treated as a refusal
    -- rather than an assertion so the command cannot report success on zero
    -- rows (the "zero-row write looks like success" trap, 0172 test §1).
    return 'status_mismatch';
  end if;

  -- EXACTLY ONE audit event, only on success.
  perform public.write_appointment_audit(
    p_appointment_id,
    'practitioner',
    v_practitioner_id,
    'outcome_reverted',
    jsonb_build_object(
      'source',            'appointment_repair_command',
      'previous_status',   p_expected_status,
      'new_status',        'confirmed',
      'reason',            v_reason,
      'baseline_audit_id', v_baseline_id,
      'baseline_at',       v_baseline_at
    )
  );

  return 'ok';
end;
$function$;

revoke execute on function public.revert_appointment_outcome(uuid, uuid, uuid, text, text) from public;
revoke execute on function public.revert_appointment_outcome(uuid, uuid, uuid, text, text) from anon;
revoke execute on function public.revert_appointment_outcome(uuid, uuid, uuid, text, text) from authenticated;
grant execute on function public.revert_appointment_outcome(uuid, uuid, uuid, text, text) to service_role;

commit;
