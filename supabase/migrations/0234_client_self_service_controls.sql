-- 0234 — HON-47: a studio may disable CLIENT self-service cancellation and
-- rescheduling.
--
-- WHAT THIS IS FOR. Sabrina asked for client self-service cancellation and
-- rescheduling to be switchable off. Before this migration there was NO control
-- at all: with a valid token, cancel and reschedule were unconditional. The
-- only related columns were `cancellation_policy_text` (the text a client
-- acknowledges) and `late_cancel_fee_cents` (a fee, not a block), and
-- 0064_manual_fee_protection.sql:37 records that no cancellation window existed.
--
-- WHICH ACTIONS TO DISABLE IS NOT DECIDED HERE. Two independent flags default
-- TRUE, so applying this migration changes NO studio's behaviour. Turning them
-- on or off is configuration, which keeps the product decision with the owner
-- instead of encoding it in a migration.
--
-- THESE ARE THEIR OWN CONTROLS. Neither is derived from, nor folded into,
-- `new_client_admission_mode`. Folding them in would make disabling client
-- cancellation silently change Willow's new-client admission behaviour, which
-- is a different decision by a different person.
--
-- WHY THE ENFORCEMENT IS IN THE COMMANDS. Both commands are client-only — each
-- has exactly one caller — so gating them cannot reach staff scheduling, which
-- uses `move_or_reassign_appointment`, `receptionist_move_appointment` and
-- `receptionist_cancel_appointment`. Putting the rule in the command rather
-- than the action means a future entry point inherits the refusal, the way
-- EMERG-01's free-consultation rule already does.
--
-- THE TWO FUNCTIONS ARE RE-EMITTED, NOT EDITED IN PLACE. 0176 and 0171 are
-- applied and frozen. Their bodies were extracted verbatim and transformed
-- programmatically; the diff against the originals is ADDITIONS ONLY except for
-- two `select … into` lines per function, rewritten to carry one more column.
--
-- GRANTS ARE RE-ESTABLISHED BELOW. `create or replace function` re-runs
-- Supabase's `ALTER DEFAULT PRIVILEGES`, which grants EXECUTE to anon,
-- authenticated AND service_role at create time, so each function revokes from
-- every unintended role BY NAME and re-grants only service_role — the omission
-- that bit 0129 (anon) and 0164 (service_role).
--
-- NO DATA IS WRITTEN. Both columns are `not null default true`, which Postgres
-- adds as metadata without rewriting the table because the default is
-- non-volatile. No existing row is touched and no backfill is needed.

begin;

-- A lock wait must fail the migration rather than queue behind a long
-- transaction and stall writes. `supabase db push` does not wrap a file in a
-- transaction, so this is set INSIDE the explicit transaction above: a bare
-- `set local` outside one emits 25P01 and never arms.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- The two flags
-- ---------------------------------------------------------------------------

alter table public.studios
  add column if not exists client_cancellation_enabled boolean not null default true;

alter table public.studios
  add column if not exists client_reschedule_enabled boolean not null default true;

comment on column public.studios.client_cancellation_enabled is
  'HON-47. FALSE disables CLIENT self-service cancellation: '
  'public_cancel_appointment_with_token refuses with cancellation_disabled '
  'before any mutation, and the client surfaces withdraw the CTA. Staff '
  'cancellation is unaffected (receptionist_cancel_appointment and the '
  'calendar actions are separate commands). Default TRUE, so an existing '
  'studio is unchanged. Owner-controlled; never derived from '
  'new_client_admission_mode.';

comment on column public.studios.client_reschedule_enabled is
  'HON-47. FALSE disables CLIENT self-service rescheduling: '
  'reschedule_appointment_v2 refuses with reschedule_disabled before taking the '
  'capacity lock and before any mutation, and the client surfaces withdraw the '
  'CTA. Staff moves are unaffected (move_or_reassign_appointment, '
  'receptionist_move_appointment). EMERG-01''s narrower free-consultation rule '
  'is separate and still applies when this flag is TRUE. Default TRUE. '
  'Owner-controlled; never derived from new_client_admission_mode.';

-- ---------------------------------------------------------------------------
-- The client cancellation command, gated
-- ---------------------------------------------------------------------------

create or replace function public.public_cancel_appointment_with_token(
  p_token                 text,
  p_reason                text,
  p_reason_label          text,
  p_note                  text,
  p_follow_up_allowed     boolean,
  p_acknowledged_policy   boolean,
  p_presented_policy_hash text
) returns table (
  result                    text,
  appointment_id            uuid,
  studio_id                 uuid,
  policy_acknowledgement_id uuid
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  -- HON-47.
  v_cancel_allowed boolean;
  v_studio_id    uuid;
  v_appt         public.appointments%rowtype;
  v_cancel_text  text;
  v_noshow_text  text;
  v_needs_ack    boolean;
  v_current_hash text;
  v_ack_id       uuid;
begin
  if p_token is null or length(trim(p_token)) = 0 then
    return query select 'invalid_token'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- PRE-READ (NOT authorisation). Discover the studio so it can be locked
  -- first. No lock is taken here and nothing read here is trusted: the
  -- authoritative re-read happens under both locks below.
  select a.studio_id into v_studio_id
    from public.appointments a
   where a.cancellation_token_hash = p_token;
  if v_studio_id is null then
    return query select 'invalid_token'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- LOCK 1 — the studio. This is what makes the policy decision linearizable:
  -- a concurrent policy UPDATE must now wait, so the hash compared below and
  -- the snapshot stored later are the same policy.
  select s.cancellation_policy_text,
         s.no_show_policy_text,
         -- HON-47. Read under the SAME lock that makes the policy decision
         -- linearizable, so a concurrent flag change serializes with this
         -- cancellation instead of racing it. `coalesce` because a studio row
         -- selected before 0234 applied carries no value.
         coalesce(s.client_cancellation_enabled, true)
    into v_cancel_text, v_noshow_text, v_cancel_allowed
    from public.studios s
   where s.id = v_studio_id
   for update;
  if not found then
    return query select 'invalid_token'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- LOCK 2 — the appointment, re-found by token under the studio lock.
  select * into v_appt
    from public.appointments a
   where a.cancellation_token_hash = p_token
     and a.studio_id = v_studio_id
   for update;
  if not found then
    return query select 'invalid_token'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  if v_appt.status = 'cancelled' then
    return query select 'already_cancelled'::text, v_appt.id, v_appt.studio_id, null::uuid;
    return;
  end if;
  if v_appt.status <> 'confirmed' then
    return query select 'not_cancelable'::text, v_appt.id, v_appt.studio_id, null::uuid;
    return;
  end if;
  if v_appt.starts_at <= now() then
    return query select 'not_cancelable'::text, v_appt.id, v_appt.studio_id, null::uuid;
    return;
  end if;

  -- HON-47 — CLIENT SELF-SERVICE CANCELLATION MAY BE DISABLED BY THE STUDIO.
  --
  -- Enforced HERE, inside the command, so no caller can bypass it: the only
  -- caller today is app/cancel/[token]/actions.ts, and the 5-argument overload
  -- below delegates to this function, so it inherits the refusal. A future
  -- entry point inherits it too, which is the whole reason it is not in the
  -- action.
  --
  -- ORDERING IS PART OF THE CONTRACT, and an earlier revision had it wrong
  -- (Codex P1 4308948303). This check sat immediately after the studio lock,
  -- BEFORE the token and state checks above — so a cancelled, completed or
  -- past appointment at a disabled studio was answered `cancellation_disabled`,
  -- and the surface then told the client "your appointment is still booked and
  -- has not been changed". That sentence was FALSE for a cancelled appointment,
  -- and it distinguished a studio's policy on a token state that the public
  -- collapse rule above deliberately refuses to distinguish.
  --
  -- So the flag speaks only about an appointment that could otherwise have been
  -- cancelled. An ineligible one keeps its existing generic answer —
  -- `invalid_token`, `already_cancelled` or `not_cancelable` — whatever the
  -- flag says. The flag VALUE is still read under the studio lock far above, so
  -- the decision stays linearizable against a concurrent policy change; only
  -- the refusal moved.
  --
  -- Refused BEFORE any mutation and before any acknowledgement is recorded: a
  -- disabled studio leaves no trace of the attempt. `appointment_id` and
  -- `studio_id` are both returned, as every other post-validation refusal here
  -- does, so the caller can present studio-specific contact copy.
  --
  -- This flag is its OWN control. It is never derived from, and never folded
  -- into, `new_client_admission_mode` — that would make disabling client
  -- cancellation silently change Willow's admission behaviour.
  if not v_cancel_allowed then
    return query select 'cancellation_disabled'::text, v_appt.id, v_appt.studio_id, null::uuid;
    return;
  end if;

  -- CURRENT policy hash, derived under the studio lock.
  v_current_hash := encode(
    extensions.digest(
      coalesce(v_cancel_text, '') || E'\n---\n' || coalesce(v_noshow_text, ''),
      'sha256'
    ),
    'hex'
  );

  -- PRESENTATION PROOF — unconditional (see header). A missing hash is a
  -- mismatch, never consent: an older client that posts only the checkbox must
  -- not be able to acknowledge unseen text, and a client that saw a policy the
  -- studio has since deleted must not slip through on an empty current policy.
  if p_presented_policy_hash is null
     or lower(p_presented_policy_hash) is distinct from v_current_hash
  then
    return query select 'policy_changed'::text, v_appt.id, v_appt.studio_id, null::uuid;
    return;
  end if;

  -- REQUIREMENT predicate — trims, so whitespace-only policy text requires no
  -- acknowledgement. U&'\FEFF' is a BOM, written escaped because a literal one
  -- is invisible in a .sql file. Identical to 0171 and to hasAnyPolicy().
  v_needs_ack := coalesce(v_cancel_text, '') ~ ('[^[:space:]' || U&'\FEFF' || ']')
              or coalesce(v_noshow_text, '') ~ ('[^[:space:]' || U&'\FEFF' || ']');

  if v_needs_ack and coalesce(p_acknowledged_policy, false) is not true then
    return query select 'ack_required'::text, v_appt.id, v_appt.studio_id, null::uuid;
    return;
  end if;

  -- ======================================================================
  -- MUTATION. Everything below commits together or not at all.
  -- ======================================================================
  --
  -- `updated_at` is deliberately NOT assigned here: B6/0175 made it
  -- DB-authoritative via appointments_set_updated_at_trg, and a hand-written
  -- assignment would only be as good as the next writer remembering. The
  -- confirmed -> cancelled edge travels through B6's transition guard; this
  -- command has no bypass for it.
  --
  -- cancelled_by stays 'client' and cancelled_by_practitioner_id is left NULL:
  -- a public token cancellation is the CLIENT acting, and manufacturing a
  -- practitioner identity would falsify B5's attribution.
  update public.appointments
     set status              = 'cancelled',
         cancelled_at        = now(),
         cancelled_by        = 'client',
         cancellation_reason = nullif(p_reason_label, '')
   where id = v_appt.id;

  -- Exactly ONE semantic cancellation event, with the same details shape the
  -- route already depends on. actor_type 'client', actor_id NULL.
  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  ) values (
    v_appt.id, 'client', null, 'cancelled',
    jsonb_build_object(
      'source',            'public_token',
      'reason',            coalesce(p_reason, ''),
      'reason_label',      coalesce(p_reason_label, ''),
      'note',              coalesce(p_note, ''),
      'follow_up_allowed', coalesce(p_follow_up_allowed, false)
    )
  );

  -- THE FIX. This used to run after the RPC committed, in a swallowed
  -- statement. The snapshot is the CURRENT policy that was just proven equal to
  -- what the client was shown — not a second, later read.
  if v_needs_ack then
    insert into public.appointment_policy_acknowledgements
      (studio_id, appointment_id, client_id, action,
       cancellation_policy_text_snapshot, no_show_policy_text_snapshot,
       policy_snapshot_hash)
    values
      (v_appt.studio_id, v_appt.id, v_appt.client_id, 'cancel',
       coalesce(v_cancel_text, ''), coalesce(v_noshow_text, ''),
       v_current_hash)
    returning id into v_ack_id;
  end if;

  return query select 'cancelled'::text, v_appt.id, v_appt.studio_id, v_ack_id;
end;
$$;

comment on function public.public_cancel_appointment_with_token(
  text, text, text, text, boolean, boolean, text
) is
  'B7/0176, gated by HON-47/0234. Atomic public cancellation: token check, '
  'policy presentation proof, confirmed->cancelled, one cancelled audit event '
  'and the policy acknowledgement all commit together. Locks studios before '
  'appointments. Refuses cancellation_disabled, before any mutation, when the '
  'studio has client_cancellation_enabled = false.';

revoke execute on function public.public_cancel_appointment_with_token(
  text, text, text, text, boolean, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.public_cancel_appointment_with_token(
  text, text, text, text, boolean, boolean, text
) to service_role;

-- ---------------------------------------------------------------------------
-- The client reschedule command, gated
-- ---------------------------------------------------------------------------

create or replace function public.reschedule_appointment_v2(
  p_original_appointment_id       uuid,
  p_current_cancellation_token_hash text,
  p_new_starts_at                 timestamptz,
  p_new_cancellation_token_hash   text,
  p_acknowledged_policy           boolean,
  p_presented_policy_snapshot_hash text default null
)
returns table (
  result                    text,
  original_appointment_id   uuid,
  new_appointment_id        uuid,
  studio_id                 uuid,
  client_id                 uuid,
  service_id                uuid,
  practitioner_id           uuid,
  original_starts_at        timestamptz,
  starts_at                 timestamptz,
  ends_at                   timestamptz,
  duration_minutes          integer,
  created_at                timestamptz,
  policy_acknowledgement_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- HON-47.
  v_reschedule_allowed boolean;
  v_studio_id   uuid;
  v_orig        public.appointments%rowtype;
  v_tz          text;
  v_horizon     integer;
  v_cap_flag    boolean;
  v_cancel_text text;
  v_noshow_text text;
  v_now         timestamptz := now();
  v_new_starts  timestamptz;
  v_new_ends    timestamptz;
  v_duration    integer;
  v_local_date  date;
  v_today       date;
  v_win_start   timestamptz;
  v_win_end     timestamptz;
  v_new_id      uuid;
  v_created_at  timestamptz;
  v_ack_id      uuid;
  v_needs_ack   boolean;
  v_current_hash text;
  v_avail       text;
begin
  -- =========================================================================
  -- STEP A — RESOLVE, LOCK, AND AUTHENTICATE THE ORIGINAL
  -- =========================================================================

  -- Nothing is authorised yet. The caller gives an appointment id but no studio,
  -- so the studio has to be discovered before it can be locked. This read is
  -- used for exactly ONE purpose: choosing the studio row to lock. It proves
  -- nothing and is never trusted again.
  if p_original_appointment_id is null then
    return query select 'appointment_not_found'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  select a.studio_id into v_studio_id
    from public.appointments a
   where a.id = p_original_appointment_id;
  if not found then
    return query select 'appointment_not_found'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- LOCK ORDER: studios -> advisory -> appointments. Same order as 0170 and
  -- move_or_reassign_appointment; no path acquires the advisory lock after an
  -- appointment row lock, so no cycle exists.
  select s.timezone,
         coalesce(s.public_booking_horizon_months, 3),
         coalesce(s.practitioner_capacity_enabled, false),
         s.cancellation_policy_text,
         s.no_show_policy_text,
         -- HON-47. Read under the studio lock this function already takes, so a
         -- concurrent flag change serializes with the reschedule.
         coalesce(s.client_reschedule_enabled, true)
    into v_tz, v_horizon, v_cap_flag, v_cancel_text, v_noshow_text,
         v_reschedule_allowed
    from public.studios s
   where s.id = v_studio_id
   for update;
  if not found then
    return query select 'appointment_not_found'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;
  perform public.acquire_studio_capacity_lock(v_studio_id);

  -- SERIALIZE AGAINST APPOINTMENT-SOURCE MUTATION (the candidate-set race, and
  -- the duplicate-submit race).
  --
  -- A conflict-derived candidate exists only BECAUSE some appointment generates
  -- it. If that appointment is cancelled between validation and insert, the
  -- candidate silently stops being offered and nothing else rejects the write:
  -- with the conflict gone there is no GiST overlap and no HB001 gap. 0170
  -- documents this at length; the same hazard applies here.
  --
  -- This lock ALSO serialises two concurrent reschedules of the SAME original.
  -- The original is inside this set by construction — the predicate is a plain
  -- OR on its id, so it is locked even when its current start lies outside the
  -- replacement date window (moving an appointment from next month to next week
  -- is the normal case, and the window-only form would not have locked it).
  -- The second caller therefore blocks here, and when it proceeds its
  -- authoritative re-read below sees status = 'cancelled' and refuses with
  -- `appointment_not_reschedulable`.
  --
  -- SCOPE: the REPLACEMENT day's candidate window, plus the original. Not the
  -- whole studio, and not a wide fixed span — locking every future appointment
  -- would serialise unrelated work and, worse, would make the explicit
  -- `a.id = p_original_appointment_id` disjunct below redundant, so nothing
  -- would ever prove the original is locked at all.
  --
  -- The window matches public_reschedule_slot_candidates exactly: local
  -- midnight of the target date through +36 hours, which is the span over which
  -- it loads reservations. A 24-hour back-off catches an appointment that
  -- STARTED before that window but whose protected interval reaches into it.
  --
  -- THE ORIGINAL IS INCLUDED BY ID, UNCONDITIONALLY. Its current start is
  -- usually NOT in the replacement window — moving an appointment from next
  -- month to next week is the ordinary case — so a window-only predicate would
  -- leave the very row being mutated unlocked, and a concurrent cancel/
  -- complete/no-show could interleave between this command's validation and its
  -- UPDATE.
  --
  -- Deterministic id order prevents lock-order inversion between two callers
  -- locking overlapping sets.
  --
  -- p_new_starts_at is still unvalidated here; only its timezone projection is
  -- used, and a null simply yields a null date whose comparisons exclude every
  -- row, leaving the original locked on its own. Validation happens below.
  v_local_date := (coalesce(p_new_starts_at, v_now) at time zone v_tz)::date;
  v_win_start  := public.public_booking_local_to_utc(v_local_date, '00:00'::time, v_tz);
  v_win_end    := v_win_start + interval '36 hours';
  perform 1
     from public.appointments a
    where a.studio_id = v_studio_id
      and (
        a.id = p_original_appointment_id
        or (a.status in ('confirmed', 'completed')
            and a.starts_at < v_win_end
            and a.ends_at   > v_win_start - make_interval(mins => 24 * 60))
      )
    order by a.id
      for update;

  -- AUTHORITATIVE RE-READ, UNDER THE LOCKS. Every check below runs against this
  -- row, never against the pre-read. Identity AND token are re-verified together
  -- so a row that changed hands between the two reads cannot be acted on.
  select * into v_orig
    from public.appointments a
   where a.id = p_original_appointment_id
     and a.studio_id = v_studio_id;
  if not found then
    return query select 'appointment_not_found'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- TOKEN. A wrong hash, a null hash, and a hash belonging to a DIFFERENT
  -- appointment all collapse to the same code as "no such appointment" — the
  -- public surface must not distinguish "valid token, wrong state" from
  -- "unknown token". `is distinct from` so a null stored hash never matches a
  -- null input.
  if p_current_cancellation_token_hash is null
     or v_orig.cancellation_token_hash is null
     or v_orig.cancellation_token_hash is distinct from p_current_cancellation_token_hash
  then
    return query select 'appointment_not_found'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- STATE. Cancelled / completed / no_show / already-started all collapse to one
  -- code. This is also the arm that refuses the LOSER of a duplicate submit.
  if v_orig.status <> 'confirmed' or v_orig.starts_at <= v_now then
    return query select 'appointment_not_reschedulable'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- HON-47 — CLIENT SELF-SERVICE RESCHEDULING MAY BE DISABLED BY THE STUDIO.
  --
  -- SAME ORDERING DEFECT AS THE CANCEL PATH, fixed the same way. Codex raised
  -- it against the cancel command (P1 4308948303); it was true here too, and
  -- for the identical reason: this check sat right after the studio lock, so a
  -- cancelled or past appointment at a disabled studio was answered
  -- `reschedule_disabled` and the page said "your appointment is still booked
  -- at its original time" — false, and a state distinction the collapse rule
  -- above exists to prevent. It was not in the report; it is the same class.
  --
  -- THE COST, stated because it is a real trade: a disabled studio now reaches
  -- the capacity advisory lock and the row locks before being refused, where
  -- before it paid nothing. Correct, truthful copy on a path that mutates
  -- nothing is worth more than saving a lock on a request that is about to be
  -- refused either way. The flag VALUE is still read under the studio lock, so
  -- the decision remains linearizable; only the refusal moved.
  --
  -- Its own control, never derived from `new_client_admission_mode`. EMERG-01's
  -- free-consultation rule is a SEPARATE, narrower refusal and keeps its own
  -- code: this one does not replace it, and a studio with rescheduling enabled
  -- still gets that rule.
  if not v_reschedule_allowed then
    return query select 'reschedule_disabled'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- THE BOOKED CONTRACT. Duration comes from the LOCKED ORIGINAL, never from the
  -- service default and never from the caller: a reschedule MOVES a booking, it
  -- does not silently relength it because the studio edited the service after
  -- the client booked.
  v_duration := v_orig.duration_minutes;
  if v_duration is null or v_duration <= 0 then
    return query select 'appointment_not_reschedulable'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- The client must still exist, belong to this studio, and not be archived.
  -- Rescheduling onto an archived client would resurrect a hidden record into
  -- the active calendar.
  if not exists (
    select 1 from public.clients c
     where c.id = v_orig.client_id
       and c.studio_id = v_studio_id
       and c.archived_at is null
  ) then
    return query select 'appointment_not_reschedulable'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- The successor's token hash must be well-formed. The column CHECK
  -- (`^[a-f0-9]{64}$`) would raise on a bad value; raising here would roll the
  -- transaction back with a raw constraint name, so it is refused cleanly first.
  if p_new_cancellation_token_hash is null
     or p_new_cancellation_token_hash !~ '^[a-f0-9]{64}$'
  then
    return query select 'invalid_time'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- =========================================================================
  -- STEP B — VALIDATE THE REQUESTED NEW START
  -- =========================================================================

  -- ONE AUTHORITATIVE START VALUE. Sub-millisecond input is REJECTED, never
  -- truncated: validating a truncated value while persisting the raw one is two
  -- precision domains, which is exactly the defect 0170's fourth amendment
  -- closed. A browser ISO string is always millisecond-precise.
  if p_new_starts_at is null
     or p_new_starts_at is distinct from date_trunc('milliseconds', p_new_starts_at)
  then
    return query select 'invalid_time'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;
  v_new_starts := p_new_starts_at;
  v_new_ends   := v_new_starts + make_interval(mins => v_duration);

  -- SAME-TIME NO-OP. Excluding the original's own reservation makes its current
  -- start legally free again, so without this it would be a valid candidate and
  -- the command would cancel-and-recreate purely to rotate the token — churning
  -- the audit trail, the Google event and the client's links for no change.
  -- Checked BEFORE the future/horizon rules so the visitor gets the accurate
  -- reason.
  if v_new_starts = v_orig.starts_at then
    return query select 'same_time'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  if v_new_starts <= v_now then
    return query select 'invalid_time'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- Booking horizon in the studio's LOCAL calendar. DAYS_PER_HORIZON_MONTH = 31
  -- (lib/booking/horizon.ts:28); both bounds inclusive there.
  v_today      := (v_now at time zone v_tz)::date;
  v_local_date := (v_new_starts at time zone v_tz)::date;
  if v_local_date < v_today or v_local_date > (v_today + (v_horizon * 31)) then
    return query select 'outside_horizon'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- =========================================================================
  -- POLICY FRESHNESS — prove WHAT was displayed, not merely that a box was
  -- ticked.
  -- =========================================================================
  --
  -- `hasAnyPolicy` semantics: TRIMMED emptiness decides whether an
  -- acknowledgement is required at all, so null / '' / whitespace-only all mean
  -- "no policy". The SNAPSHOT that gets hashed and stored is deliberately
  -- UNTRIMMED — it must be the exact column content the page rendered.
  --
  -- THE PREDICATE MUST MATCH JAVASCRIPT `String.prototype.trim()`, NOT
  -- `btrim()`. This is not pedantry: `hasAnyPolicy` decides on the PAGE whether
  -- to render the checkbox at all, and this decides in the COMMAND whether to
  -- demand one. If they disagree, the page renders no checkbox, the form posts
  -- no acknowledgement, and the command refuses every submission — public
  -- rescheduling is permanently broken for that studio with no way for the
  -- visitor to satisfy it.
  --
  -- Postgres `btrim(x)` with no second argument strips ONLY U+0020 spaces, so
  -- a policy of "   \n\t  " survives it non-empty while JS trims it to "".
  -- Measured on this schema: btrim(E'   \n\t  ') = E'\t'.
  --
  -- `[^[:space:]]` is the right family — in this UTF-8 database it covers
  -- space, tab, LF, CR, VT, FF and U+00A0 NBSP, matching JS on all of them.
  -- It does NOT cover U+FEFF (ZERO WIDTH NO-BREAK SPACE / BOM), which JS
  -- `trim()` DOES treat as whitespace, so U+FEFF is added to the class
  -- explicitly. Written as U&'\FEFF' rather than a literal character because a
  -- raw BOM in a .sql file is invisible and editors strip or relocate it.
  --
  -- Verified against JS for: whitespace mixes, NBSP-only, BOM-only, BOM+text,
  -- ordinary text and the empty string (tests/db/public-reschedule-command.db.test.ts).
  v_needs_ack := coalesce(v_cancel_text, '') ~ ('[^[:space:]' || U&'\FEFF' || ']')
              or coalesce(v_noshow_text, '') ~ ('[^[:space:]' || U&'\FEFF' || ']');

  if v_needs_ack then
    if coalesce(p_acknowledged_policy, false) is not true then
      return query select 'policy_ack_required'::text, null::uuid, null::uuid, null::uuid,
                          null::uuid, null::uuid, null::uuid, null::timestamptz,
                          null::timestamptz, null::timestamptz, null::integer,
                          null::timestamptz, null::uuid;
      return;
    end if;

    -- Byte-identical to buildPolicySnapshot(): coalesce each side to '' (NO
    -- trim), join with a literal LF, three hyphens, LF, and hash as lowercase
    -- SHA-256 hex. `encode` is a pg_catalog builtin; `digest` is pgcrypto, which
    -- this database installs into the `extensions` schema.
    v_current_hash := encode(
      extensions.digest(
        coalesce(v_cancel_text, '') || E'\n---\n' || coalesce(v_noshow_text, ''),
        'sha256'
      ),
      'hex'
    );

    -- A missing presented hash is treated as a mismatch, not as consent. An
    -- older client that posts only the checkbox must NOT be able to acknowledge
    -- unseen policy text.
    if p_presented_policy_snapshot_hash is null
       or lower(p_presented_policy_snapshot_hash) is distinct from v_current_hash
    then
      return query select 'policy_changed'::text, null::uuid, null::uuid, null::uuid,
                          null::uuid, null::uuid, null::uuid, null::timestamptz,
                          null::timestamptz, null::timestamptz, null::integer,
                          null::timestamptz, null::uuid;
      return;
    end if;
  end if;

  -- =========================================================================
  -- FINANCIAL SAFETY — refuse rather than move money. See the header census.
  -- =========================================================================
  if exists (
        select 1 from public.appointment_payments ap
         where ap.appointment_id = v_orig.id
      )
     or exists (
        select 1 from public.payment_charge_attempts pca
         where pca.appointment_id = v_orig.id
           and pca.status not in ('cancelled', 'failed')
      )
     or exists (
        select 1 from public.manual_fee_charge_attempts mfa
         where mfa.appointment_id = v_orig.id
           and mfa.status not in ('cancelled', 'failed')
      )
  then
    return query select 'payment_state_requires_studio'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- =========================================================================
  -- PRESERVED PRACTITIONER — never silently reassign.
  -- =========================================================================
  --
  -- The successor keeps the original's practitioner. There is no public
  -- practitioner selection, no "current owner" lookup, and no fallback to
  -- another practitioner: a client who booked with one person must not be moved
  -- to another by a self-service reschedule.
  --
  -- CAPACITY ON — the preserved practitioner is load-bearing (it selects the
  -- availability rows and the resource_key timeline, and
  -- appointments_capacity_requires_practitioner makes it mandatory on a
  -- confirmed row), so it must still belong to the studio, still be active, and
  -- still satisfy service eligibility. When it does not, the command refuses; it
  -- does not pick a replacement.
  --
  -- CAPACITY OFF — the practitioner is preserved EXACTLY as booked and nothing
  -- about its current state is a condition of the reschedule: an active
  -- practitioner, an INACTIVE historical practitioner, and NULL are all carried
  -- through unchanged. This is not leniency, it is parity: the capacity-OFF slot
  -- loader generates from studio-wide availability and studio-wide reservations
  -- and never consults practitioner activity or service_practitioners, so
  -- refusing here would refuse every slot the page had just offered. The
  -- validator's own membership/eligibility gate is fenced behind the same
  -- capacity predicate for exactly this reason.
  if v_cap_flag then
    if v_orig.practitioner_id is null
       or not exists (
         select 1 from public.practitioners pr
          where pr.id = v_orig.practitioner_id
            and pr.studio_id = v_studio_id
            and pr.active = true
       )
    then
      return query select 'practitioner_unavailable'::text, null::uuid, null::uuid, null::uuid,
                          null::uuid, null::uuid, null::uuid, null::timestamptz,
                          null::timestamptz, null::timestamptz, null::integer,
                          null::timestamptz, null::uuid;
      return;
    end if;

    -- Service eligibility, only when the service HAS an eligibility list —
    -- identical shape to validate_public_booking_slot (0170), so a studio that
    -- never configured service_practitioners is unaffected.
    if v_orig.service_id is not null
       and exists (
         select 1 from public.service_practitioners sp
          where sp.service_id = v_orig.service_id
       )
       and not exists (
         select 1 from public.service_practitioners sp
          where sp.service_id = v_orig.service_id
            and sp.practitioner_id = v_orig.practitioner_id
       )
    then
      return query select 'practitioner_unavailable'::text, null::uuid, null::uuid, null::uuid,
                          null::uuid, null::uuid, null::uuid, null::timestamptz,
                          null::timestamptz, null::timestamptz, null::integer,
                          null::timestamptz, null::uuid;
      return;
    end if;
  end if;

  -- =========================================================================
  -- AVAILABILITY + EXACT REPLACEMENT-SLOT MEMBERSHIP
  -- =========================================================================
  --
  -- ONE delegated predicate, evaluated UNDER the locks this command already
  -- holds. It enforces the full-day blockout, the working-hours window with the
  -- loader's practitioner-scoped precedence, the local-midnight rule, the
  -- SERVICE-end-before-close rule, the exclusion-aware collision test, and
  -- exact membership of the current reschedule candidate set — all with the
  -- PRESERVED practitioner and the original's reservation excluded.
  --
  -- Its membership arm is the authority that the requested instant is one the
  -- page would OFFER, not merely one that is legal. Without it a direct
  -- service-role call could move an appointment to 10:17 on an open,
  -- conflict-free day.
  v_avail := public.validate_public_reschedule_slot(
    v_studio_id, v_orig.practitioner_id, v_orig.service_id,
    v_new_starts, v_new_ends, v_orig.id
  );
  if v_avail <> 'ok' then
    -- `invalid_practitioner` and `not_eligible` are collapsed into the single
    -- practitioner code so the public surface never learns which of the two
    -- internal conditions failed. `invalid_studio` cannot occur — the studio row
    -- was locked above — but is mapped defensively rather than passed through as
    -- a code the route has no mapping for.
    if v_avail in ('invalid_practitioner', 'not_eligible') then
      v_avail := 'practitioner_unavailable';
    elsif v_avail = 'invalid_studio' then
      v_avail := 'appointment_not_found';
    end if;
    return query select v_avail, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- =========================================================================
  -- STEP C — GENERATE THE SUCCESSOR ID
  -- =========================================================================
  -- Generated HERE, before any audit is constructed, so the cancellation audit
  -- can name the successor and the successor audit can name the original without
  -- a second pass. The caller cannot supply it.
  v_new_id := extensions.gen_random_uuid();

  -- =========================================================================
  -- STEP D — CANCEL THE ORIGINAL
  -- =========================================================================
  -- cancellation_kind = 'rescheduled' is set in the SAME statement that flips
  -- the status. This is load-bearing, not cosmetic: enqueue_calendar_outbound
  -- inspects NEW.cancellation_kind on the cancelled-status branch and returns
  -- early when it is 'rescheduled'. Setting it in a later UPDATE would let the
  -- trigger see NULL and enqueue an event.delete for an appointment that is
  -- being MOVED, destroying the Google event the successor is about to adopt.
  update public.appointments a
     set status              = 'cancelled',
         cancelled_at        = v_now,
         cancelled_by        = 'client',
         cancellation_reason = 'Rescheduled via email link',
         cancellation_kind   = 'rescheduled',
         updated_at          = v_now
   where a.id = v_orig.id;

  -- =========================================================================
  -- STEP E — INSERT THE SUCCESSOR
  -- =========================================================================
  -- Column-by-column rationale is in the header matrix. Everything not listed
  -- here is either trigger-derived or deliberately reset to its default.
  --
  -- Aliased as `a` because this function's RETURNS TABLE puts `created_at`,
  -- `starts_at`, `ends_at` and the other output names in scope as PL/pgSQL
  -- variables; an unqualified RETURNING would be ambiguous.
  --
  -- 23P01 (GiST overlap) and HB001 (soft buffer) are deliberately NOT caught:
  -- they must roll the entire transaction back, leaving the original confirmed
  -- with its reservation and token intact. The route maps both to the same safe
  -- "that time is no longer available" copy.
  insert into public.appointments as a
    (id, studio_id, practitioner_id, client_id, service_id,
     starts_at, ends_at, duration_minutes, status,
     notes, referral_source, cancellation_token_hash,
     rescheduled_from_appointment_id)
  values
    (v_new_id, v_studio_id, v_orig.practitioner_id, v_orig.client_id, v_orig.service_id,
     v_new_starts, v_new_ends, v_duration, 'confirmed',
     v_orig.notes, v_orig.referral_source, p_new_cancellation_token_hash,
     v_orig.id)
  returning a.created_at into v_created_at;

  -- =========================================================================
  -- STEP F — COMPLETE THE REVERSE LINEAGE
  -- =========================================================================
  -- Must follow the successor INSERT: rescheduled_to_appointment_id is a FK to
  -- appointments(id), so the row has to exist first.
  --
  -- NO GOOGLE CHURN. bump_appointment_sync_version only bumps when starts_at,
  -- ends_at or status changes, and none of them changes here — so sync_version
  -- is unchanged. enqueue_calendar_outbound's cancelled-status branch requires
  -- (old.status <> 'cancelled' OR new.sync_version > old.sync_version); the
  -- original is already cancelled and the version is static, so BOTH are false
  -- and the trigger falls through to `return new` without enqueuing anything.
  -- The cancellation_kind guard is a second, independent line of defence.
  update public.appointments a
     set rescheduled_to_appointment_id = v_new_id,
         updated_at = v_now
   where a.id = v_orig.id;

  -- =========================================================================
  -- STEP G — BOTH AUDIT ROWS
  -- =========================================================================
  -- Shapes preserve the legacy canonical vocabulary exactly
  -- (`reason: rescheduled` + `new_appointment_id` on the original;
  -- `source: reschedule_link` + `original_appointment_id` on the successor) so
  -- existing readers are unaffected. `source: reschedule_link` is ADDED to the
  -- cancellation details for symmetry with every other audit row, which all
  -- carry a source.
  insert into public.appointment_audit
    (appointment_id, actor_type, actor_id, action, details)
  values
    (v_orig.id, 'client', null, 'cancelled',
     jsonb_build_object(
       'reason',             'rescheduled',
       'source',             'reschedule_link',
       'new_appointment_id', v_new_id
     ));

  insert into public.appointment_audit
    (appointment_id, actor_type, actor_id, action, details)
  values
    (v_new_id, 'client', null, 'created',
     jsonb_build_object(
       'source',                  'reschedule_link',
       'original_appointment_id', v_orig.id
     ));

  -- =========================================================================
  -- STEP H — THE POLICY ACKNOWLEDGEMENT, IN THIS TRANSACTION
  -- =========================================================================
  -- Linked to the ORIGINAL appointment, preserving the existing semantic: "the
  -- client accepted these policies before rescheduling appointment X", and X is
  -- what the token referenced. The snapshots stored are the exact current column
  -- values, and the hash is the one just proven to match what was displayed.
  --
  -- The route used to write this AFTER the RPC committed, in a statement whose
  -- error was logged and swallowed — so a confirmed reschedule could exist with
  -- no acknowledgement, which is precisely the evidence a fee dispute needs.
  if v_needs_ack then
    insert into public.appointment_policy_acknowledgements
      (studio_id, appointment_id, client_id, action,
       cancellation_policy_text_snapshot, no_show_policy_text_snapshot,
       policy_snapshot_hash)
    values
      (v_studio_id, v_orig.id, v_orig.client_id, 'reschedule',
       coalesce(v_cancel_text, ''), coalesce(v_noshow_text, ''),
       v_current_hash)
    returning id into v_ack_id;
  end if;

  -- =========================================================================
  -- STEP I — RETURN AUTHORITATIVE STATE
  -- =========================================================================
  -- Everything the caller needs to send the confirmation, notify the correct
  -- practitioner and build the management links comes straight from what was
  -- just written. No post-commit re-read of the successor is required, and
  -- therefore no post-commit read failure can turn a committed reschedule into
  -- a reported failure — which matters because the raw successor token lives
  -- only in the caller's memory and only its SHA-256 is persisted, so a lost
  -- confirmation email is unrecoverable.
  return query select 'success'::text, v_orig.id, v_new_id, v_studio_id,
                      v_orig.client_id, v_orig.service_id, v_orig.practitioner_id,
                      v_orig.starts_at, v_new_starts, v_new_ends, v_duration,
                      v_created_at, v_ack_id;
  return;
end;
$$;

comment on function public.reschedule_appointment_v2(uuid, text, timestamptz, text, boolean, text) is
  '0171, gated by HON-47/0234. Atomic public reschedule. Refuses '
  'reschedule_disabled, before the capacity lock and before any mutation, when '
  'the studio has client_reschedule_enabled = false. EMERG-01''s '
  'free-consultation refusal is separate and unchanged.';

revoke execute on function public.reschedule_appointment_v2(uuid, text, timestamptz, text, boolean, text) from public;
revoke execute on function public.reschedule_appointment_v2(uuid, text, timestamptz, text, boolean, text) from anon;
revoke execute on function public.reschedule_appointment_v2(uuid, text, timestamptz, text, boolean, text) from authenticated;
revoke execute on function public.reschedule_appointment_v2(uuid, text, timestamptz, text, boolean, text) from service_role;
grant execute on function public.reschedule_appointment_v2(uuid, text, timestamptz, text, boolean, text) to service_role;

commit;
