-- ============================================================================
-- 0132 — Google Calendar B2.3-c1: transactional event-link transitions +
--        corrected placeholder version semantics + placeholder-aware cleanup.
--
-- ADDITIVE + DORMANT. This migration ships the DB half of the c1 outbound
-- event-operation layer. It adds ONE transactional, service-role-only link-
-- transition RPC and CREATE-OR-REPLACEs four existing functions to fix
-- placeholder semantics. It does NOT enable any worker, register any cron,
-- flip any flag, or touch a single existing row (all calendar tables are empty
-- in production). No change to 0124/0125/0131 files.
--
-- record_calendar_sync_result is UNCHANGED: the outbox row is transitioned
-- (processing -> done/pending/dead) ONLY by the existing claim -> handle ->
-- record_calendar_sync_result adapter. The link-transition RPC persists LINK
-- state only and always leaves the outbox row in `processing`.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Transactional event-link transition RPC (service-role only).
--    Closed action set: bind_confirmed | update_confirmed | mark_deleted |
--    rotate_for_recreate. Every action fences the claimed outbox row (must be
--    `processing` + exact claim token) and the link (studio/connection/entity +
--    version CAS / active-entity uniqueness). Returns a PHI-free jsonb status.
--    NEVER marks the outbox done, clears its claim, retries or deads it.
-- ----------------------------------------------------------------------------
create or replace function public.calendar_event_link_transition(
  p_action                  text,
  p_outbox_id               uuid,
  p_claim_token             uuid,
  p_link_id                 uuid,
  p_studio_id               uuid,
  p_connection_id           uuid,
  p_hone_entity_type        text,
  p_hone_entity_id          uuid,
  p_expected_source_version bigint  default null,
  p_google_event_id         text    default null,
  p_google_ical_uid         text    default null,
  p_google_etag             text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_ob    public.calendar_sync_outbox%rowtype;
  v_link  public.calendar_event_links%rowtype;
  v_repl  public.calendar_event_links%rowtype;
  v_conn  public.calendar_connections%rowtype;
  v_appt  public.appointments%rowtype;
  v_new   uuid;
begin
  if p_action not in ('bind_confirmed','update_confirmed','mark_deleted','rotate_for_recreate') then
    return jsonb_build_object('status','rejected','code','unknown_action');
  end if;

  -- (A) Fence the claimed outbox row: must exist, be `processing`, and carry the
  --     exact claim token. This rejects a stale worker whose lease was reclaimed.
  select * into v_ob from public.calendar_sync_outbox where id = p_outbox_id for update;
  if not found then
    return jsonb_build_object('status','rejected','code','outbox_not_found');
  end if;
  if v_ob.status <> 'processing' then
    return jsonb_build_object('status','rejected','code','outbox_not_processing');
  end if;
  if v_ob.claim_token is null or v_ob.claim_token <> p_claim_token then
    return jsonb_build_object('status','rejected','code','stale_token');
  end if;

  -- ==========================================================================
  -- rotate_for_recreate — retire the current link and mint a fresh active
  -- placeholder (a NEW provider lifecycle / a NEW deterministic event id). The
  -- outbox row is left in `processing`; the worker continues create-and-bind on
  -- the returned replacement link id.
  -- ==========================================================================
  if p_action = 'rotate_for_recreate' then
    -- Idempotency: if a valid active replacement placeholder already exists for
    -- this entity (crash-after-rotation resume), return it rather than minting a
    -- second one. A REAL active replacement owned by a newer op supersedes us.
    select * into v_repl from public.calendar_event_links
     where studio_id = p_studio_id and hone_entity_type = p_hone_entity_type
       and hone_entity_id = p_hone_entity_id and deleted_at is null
     for update;
    if found and v_repl.id <> p_link_id then
      if v_repl.google_event_id is not null then
        return jsonb_build_object('status','rejected','code','superseded');
      end if;
      return jsonb_build_object('status','ok','code','rotated_existing','link_id', v_repl.id);
    end if;

    -- Lock the current link. It may be the active real/placeholder link, or (on
    -- resume) already retired.
    select * into v_link from public.calendar_event_links where id = p_link_id for update;
    if not found then
      return jsonb_build_object('status','rejected','code','link_not_found');
    end if;
    if v_link.studio_id <> p_studio_id
       or v_link.connection_id <> p_connection_id
       or v_link.hone_entity_type <> p_hone_entity_type
       or v_link.hone_entity_id <> p_hone_entity_id then
      return jsonb_build_object('status','rejected','code','link_mismatch');
    end if;

    -- The appointment must still exist and remain confirmed (rotation recreates
    -- a live event). hone_entity_type is 'appointment' in c1.
    if p_hone_entity_type <> 'appointment' then
      return jsonb_build_object('status','rejected','code','entity_unsupported');
    end if;
    select * into v_appt from public.appointments where id = p_hone_entity_id;
    if not found then
      return jsonb_build_object('status','rejected','code','appointment_gone');
    end if;
    if v_appt.status <> 'confirmed' then
      return jsonb_build_object('status','rejected','code','appointment_not_confirmed');
    end if;

    -- The replacement inherits the CURRENT write calendar id from the connection.
    select * into v_conn from public.calendar_connections
     where id = p_connection_id and studio_id = p_studio_id;
    if not found or v_conn.write_calendar_id is null then
      return jsonb_build_object('status','rejected','code','connection_not_ready');
    end if;

    -- Retire the old link (frees the active-entity partial-unique slot), then
    -- insert the fresh placeholder. Order matters: soft-delete BEFORE insert.
    if v_link.deleted_at is null then
      update public.calendar_event_links
         set deleted_at = now(), sync_status = 'deleted', updated_at = now()
       where id = v_link.id;
    end if;

    insert into public.calendar_event_links
      (studio_id, connection_id, hone_entity_type, hone_entity_id,
       google_calendar_id, google_event_id, google_ical_uid, google_etag,
       last_hone_version, sync_status, source_system)
    values (p_studio_id, p_connection_id, p_hone_entity_type, p_hone_entity_id,
            v_conn.write_calendar_id, null, null, null,
            0, 'pending', 'hone')
    returning id into v_new;

    return jsonb_build_object('status','ok','code','rotated','link_id', v_new);
  end if;

  -- ==========================================================================
  -- The remaining actions operate on a specified link row.
  -- ==========================================================================
  select * into v_link from public.calendar_event_links where id = p_link_id for update;
  if not found then
    return jsonb_build_object('status','rejected','code','link_not_found');
  end if;

  if p_action = 'mark_deleted' then
    -- Idempotent: already-retired link is a converged no-op.
    if v_link.studio_id <> p_studio_id or v_link.connection_id <> p_connection_id then
      return jsonb_build_object('status','rejected','code','link_mismatch');
    end if;
    if v_link.deleted_at is not null then
      return jsonb_build_object('status','ok','code','already_deleted','link_id', v_link.id);
    end if;
    update public.calendar_event_links
       set deleted_at = now(), sync_status = 'deleted', updated_at = now()
     where id = v_link.id;   -- retains google_event_id / google_ical_uid / google_etag history
    return jsonb_build_object('status','ok','code','deleted','link_id', v_link.id);
  end if;

  -- bind_confirmed / update_confirmed share identity + version fencing.
  if v_link.deleted_at is not null then
    return jsonb_build_object('status','rejected','code','link_deleted');
  end if;
  if v_link.studio_id <> p_studio_id
     or v_link.connection_id <> p_connection_id
     or v_link.hone_entity_type <> p_hone_entity_type
     or v_link.hone_entity_id <> p_hone_entity_id then
    return jsonb_build_object('status','rejected','code','link_mismatch');
  end if;
  -- Version CAS: a stale worker (older applied version) may not clobber a link a
  -- newer op already advanced.
  if p_expected_source_version is not null
     and v_link.last_hone_version > p_expected_source_version then
    return jsonb_build_object('status','rejected','code','stale_version');
  end if;

  if p_action = 'bind_confirmed' then
    if v_link.google_event_id is not null then
      -- Already bound. Idempotent iff the bound id matches; else a conflict.
      if v_link.google_event_id = p_google_event_id then
        return jsonb_build_object('status','ok','code','already_bound','link_id', v_link.id);
      end if;
      return jsonb_build_object('status','rejected','code','already_bound_other');
    end if;
    if p_google_event_id is null then
      return jsonb_build_object('status','rejected','code','missing_provider_id');
    end if;
    begin
      update public.calendar_event_links
         set google_event_id    = p_google_event_id,
             google_ical_uid    = p_google_ical_uid,
             google_etag        = p_google_etag,
             sync_status        = 'synced',
             last_hone_version  = coalesce(p_expected_source_version, v_link.last_hone_version),
             last_sync_direction= 'hone_to_google',
             last_synced_at     = now(),
             last_error_code    = null,
             updated_at         = now()
       where id = v_link.id;
    exception when unique_violation then
      -- The provider event id is already actively mapped to a DIFFERENT link.
      return jsonb_build_object('status','rejected','code','foreign_event_conflict');
    end;
    return jsonb_build_object('status','ok','code','bound','link_id', v_link.id);
  end if;

  -- update_confirmed: an already-bound real link whose provider id matches.
  if v_link.google_event_id is null then
    return jsonb_build_object('status','rejected','code','link_is_placeholder');
  end if;
  if p_google_event_id is null or v_link.google_event_id <> p_google_event_id then
    return jsonb_build_object('status','rejected','code','provider_id_mismatch');
  end if;
  update public.calendar_event_links
     set google_etag        = coalesce(p_google_etag, v_link.google_etag),
         google_ical_uid    = coalesce(p_google_ical_uid, v_link.google_ical_uid),
         sync_status        = 'synced',
         last_hone_version  = coalesce(p_expected_source_version, v_link.last_hone_version),
         last_sync_direction= 'hone_to_google',
         last_synced_at     = now(),
         last_error_code    = null,
         updated_at         = now()
   where id = v_link.id;
  return jsonb_build_object('status','ok','code','updated','link_id', v_link.id);
end $$;

revoke all on function public.calendar_event_link_transition(
  text, uuid, uuid, uuid, uuid, uuid, text, uuid, bigint, text, text, text
) from public, anon, authenticated;
grant execute on function public.calendar_event_link_transition(
  text, uuid, uuid, uuid, uuid, uuid, text, uuid, bigint, text, text, text
) to service_role;

-- ----------------------------------------------------------------------------
-- 2) enqueue_calendar_outbound — CREATE OR REPLACE. Corrected placeholder /
--    reschedule version semantics (§6): a placeholder link (and a rebind) must
--    NOT claim the source version was applied before Google confirms it.
--    Only bind_confirmed/update_confirmed may advance last_hone_version.
--    IDENTICAL to the 0125 body except the two version writes.
-- ----------------------------------------------------------------------------
create or replace function public.enqueue_calendar_outbound()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_conn        public.calendar_connections%rowtype;
  v_op          text;
  v_key         text;
  v_ins         uuid;
  v_need_upsert boolean := false;
  v_has_link    boolean;
begin
  select c.* into v_conn
    from public.calendar_connections c
    join public.studios s on s.id = c.studio_id
   where c.studio_id = new.studio_id
     and c.is_studio_calendar_owner
     and s.google_calendar_outbound_sync_enabled
     and c.write_calendar_id is not null
   limit 1;
  if not found then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'confirmed' then v_need_upsert := true; end if;
  elsif new.status = 'confirmed'
        and (old.status <> 'confirmed'
             or new.starts_at is distinct from old.starts_at
             or new.ends_at  is distinct from old.ends_at
             or new.sync_version > old.sync_version) then
    v_need_upsert := true;
  end if;

  if v_need_upsert then
    -- Reschedule carry-forward: adopt the predecessor's active link, PRESERVING
    -- its provider identity + coordinates, but RESET the applied-version proof to
    -- pending/0 so the successor's timing is not falsely marked applied before
    -- Google is updated. bind_confirmed/update_confirmed advances the version.
    if tg_op = 'INSERT' and new.rescheduled_from_appointment_id is not null then
      update public.calendar_event_links
         set hone_entity_id    = new.id,
             last_hone_version = 0,
             sync_status       = 'pending',
             updated_at        = now()
       where studio_id = new.studio_id and hone_entity_type = 'appointment'
         and hone_entity_id = new.rescheduled_from_appointment_id and deleted_at is null;
    end if;

    select exists (
      select 1 from public.calendar_event_links
       where studio_id = new.studio_id and hone_entity_type = 'appointment'
         and hone_entity_id = new.id and deleted_at is null) into v_has_link;
    if v_has_link then
      v_op := 'event.update';
    else
      v_op := 'event.create';
      -- New placeholder: no provider event exists yet. google_event_id/etag/
      -- ical null, sync_status pending, last_hone_version 0 (NOT the appointment
      -- version — a placeholder never proves provider completion by existing).
      insert into public.calendar_event_links
        (studio_id, connection_id, hone_entity_type, hone_entity_id,
         google_calendar_id, last_hone_version, sync_status, source_system)
      values (new.studio_id, v_conn.id, 'appointment', new.id,
              v_conn.write_calendar_id, 0, 'pending', 'hone')
      on conflict (studio_id, hone_entity_type, hone_entity_id) where deleted_at is null do nothing;
    end if;

  elsif tg_op = 'UPDATE' and new.status = 'cancelled'
        and (old.status <> 'cancelled'
             or new.sync_version > old.sync_version) then
    if new.cancellation_kind = 'rescheduled' then
      return new;
    end if;
    select exists (
      select 1 from public.calendar_event_links
       where studio_id = new.studio_id and hone_entity_type = 'appointment'
         and hone_entity_id = new.id and deleted_at is null) into v_has_link;
    if not v_has_link then return new; end if;
    v_op := 'event.delete';
  else
    return new;
  end if;

  v_key := 'appointment:' || new.id::text || ':' || v_op || ':' || new.sync_version::text;
  insert into public.calendar_sync_outbox
    (studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, payload, idempotency_key, priority)
  values (new.studio_id, v_conn.id, v_op, 'appointment', new.id,
          jsonb_build_object('schema_version', 1, 'sync_version', new.sync_version, 'op', v_op),
          v_key, 100)
  on conflict (idempotency_key) do nothing
  returning id into v_ins;

  if v_ins is null then
    begin
      insert into public.calendar_sync_metric_events (studio_id, metric, safe_details)
      values (new.studio_id, 'idempotency_suppressed',
              jsonb_build_object('op', v_op, 'hone_entity_type', 'appointment'));
    exception when others then null; end;
  end if;
  return new;

exception when others then
  begin
    insert into public.ops_alerts (severity, event, message, studio_id, appointment_id, route, safe_details)
    values ('warning', 'calendar_enqueue_skipped',
            'Outbound calendar enqueue failed; a Google event may be missing or stale.',
            new.studio_id, new.id, 'trigger:enqueue_calendar_outbound',
            jsonb_build_object('tg_op', tg_op, 'sqlstate', sqlstate,
                               'dedup_key', 'appointment:' || new.id::text))
    on conflict (studio_id, (safe_details->>'dedup_key'))
      where event = 'calendar_enqueue_skipped' and resolved_at is null
    do nothing;
  exception when others then null; end;
  return new;
end $$;
revoke all on function public.enqueue_calendar_outbound() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3) enqueue_calendar_outbound_on_delete — CREATE OR REPLACE. Placeholder-aware
--    (§14): an ACTIVE link now enqueues an event.delete whether google_event_id
--    is present OR null. For a placeholder, carry the link id + calendar id so
--    the worker can derive the deterministic event id and GET-verify before any
--    provider delete. No PHI in the payload.
-- ----------------------------------------------------------------------------
create or replace function public.enqueue_calendar_outbound_on_delete()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_link public.calendar_event_links%rowtype;
begin
  select * into v_link from public.calendar_event_links
   where studio_id = old.studio_id and hone_entity_type = 'appointment'
     and hone_entity_id = old.id and deleted_at is null limit 1;
  if not found then return old; end if;

  if v_link.google_event_id is not null then
    -- Real link: entity-carrying delete keyed off the applied version.
    insert into public.calendar_sync_outbox
      (studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, payload, idempotency_key, priority)
    values (old.studio_id, v_link.connection_id, 'event.delete', 'appointment', old.id,
            jsonb_build_object('schema_version', 1, 'reason', 'entity_deleted',
                               'hone_link_id', v_link.id,
                               'google_event_id', v_link.google_event_id,
                               'google_calendar_id', v_link.google_calendar_id),
            'appointment:' || old.id::text || ':event.delete:' || v_link.last_hone_version::text, 100)
    on conflict (idempotency_key) do nothing;
  else
    -- Placeholder link: no confirmed provider event, but a create may have
    -- succeeded-but-unbound. Enqueue a GET-verified delete keyed by the LINK id
    -- (stable across the placeholder's life) so the worker can derive the id and
    -- verify ownership before deleting an orphan.
    insert into public.calendar_sync_outbox
      (studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, payload, idempotency_key, priority)
    values (old.studio_id, v_link.connection_id, 'event.delete', 'appointment', old.id,
            jsonb_build_object('schema_version', 1, 'reason', 'entity_deleted_placeholder',
                               'hone_link_id', v_link.id,
                               'google_calendar_id', v_link.google_calendar_id),
            'appointment:' || old.id::text || ':event.delete:placeholder:' || v_link.id::text, 100)
    on conflict (idempotency_key) do nothing;
  end if;
  return old;
exception when others then
  begin
    insert into public.ops_alerts (severity, event, message, studio_id, route, safe_details)
    values ('warning', 'calendar_enqueue_skipped',
            'Outbound calendar delete enqueue failed; an event may remain in Google.',
            old.studio_id, 'trigger:enqueue_calendar_outbound_on_delete',
            jsonb_build_object('sqlstate', sqlstate,
                               'dedup_key', 'appointment:' || old.id::text))
    on conflict (studio_id, (safe_details->>'dedup_key'))
      where event = 'calendar_enqueue_skipped' and resolved_at is null
    do nothing;
  exception when others then null; end;
  return old;
end $$;
revoke all on function public.enqueue_calendar_outbound_on_delete() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4) repair_enqueue_orphan_link_delete — CREATE OR REPLACE. Placeholder-aware
--    (§14): supports real AND placeholder links. For a placeholder, enqueue an
--    entity-less GET-verified delete carrying the link id + calendar context,
--    under a genuinely new reconcile-generation-scoped idempotency key. The
--    in-flight guard now covers both the provider-id and the link-id form.
-- ----------------------------------------------------------------------------
create or replace function public.repair_enqueue_orphan_link_delete(p_link_id uuid)
returns text language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_link public.calendar_event_links%rowtype; v_gen bigint; v_key text; v_ins uuid;
begin
  select * into v_link from public.calendar_event_links where id = p_link_id and deleted_at is null;
  if not found then return 'no_active_link'; end if;

  select reconcile_generation into v_gen from public.calendar_connections where id = v_link.connection_id;

  if v_link.google_event_id is not null then
    if exists (select 1 from public.calendar_sync_outbox
                where op_type = 'event.delete' and status in ('pending','processing')
                  and payload->>'google_event_id' = v_link.google_event_id) then
      return 'delete_in_flight';
    end if;
    v_key := 'connection:' || v_link.connection_id::text || ':link:' || v_link.id::text
             || ':event.delete#reconcile:' || coalesce(v_gen, 0)::text;
    insert into public.calendar_sync_outbox
      (studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, payload, idempotency_key, priority)
    values (v_link.studio_id, v_link.connection_id, 'event.delete', null, null,
            jsonb_build_object('schema_version', 1, 'reason', 'orphan_link_delete',
                               'hone_link_id', v_link.id,
                               'google_event_id', v_link.google_event_id,
                               'google_calendar_id', v_link.google_calendar_id),
            v_key, 100)
    on conflict (idempotency_key) do nothing returning id into v_ins;
    return coalesce(v_ins::text, 'suppressed');
  end if;

  -- Placeholder orphan: no confirmed provider event, but a create may have
  -- succeeded-but-unbound. Enqueue a GET-verified delete keyed by the link id.
  if exists (select 1 from public.calendar_sync_outbox
              where op_type = 'event.delete' and status in ('pending','processing')
                and payload->>'hone_link_id' = v_link.id::text) then
    return 'delete_in_flight';
  end if;
  v_key := 'connection:' || v_link.connection_id::text || ':link:' || v_link.id::text
           || ':event.delete.placeholder#reconcile:' || coalesce(v_gen, 0)::text;
  insert into public.calendar_sync_outbox
    (studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, payload, idempotency_key, priority)
  values (v_link.studio_id, v_link.connection_id, 'event.delete', null, null,
          jsonb_build_object('schema_version', 1, 'reason', 'orphan_link_delete_placeholder',
                             'hone_link_id', v_link.id,
                             'google_calendar_id', v_link.google_calendar_id),
          v_key, 100)
  on conflict (idempotency_key) do nothing returning id into v_ins;
  return coalesce(v_ins::text, 'suppressed');
end $$;
revoke all on function public.repair_enqueue_orphan_link_delete(uuid) from public, anon, authenticated;
grant execute on function public.repair_enqueue_orphan_link_delete(uuid) to service_role;
