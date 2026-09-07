-- ===========================================================================
-- WAIT-ADMIT-01 — PROSPECT PREFERENCE vs STUDIO ADMISSION POLICY — 0193
-- ===========================================================================
--
-- WHAT THIS ADDS. Three things a studio needs before it can admit from its
-- waitlist deliberately rather than in arrival order: what days a prospect can
-- actually attend, where each entry came from, and how the studio wants its
-- queue ranked.
--
-- ---------------------------------------------------------------------------
-- THE PRIVILEGE SPLIT IS THE POINT OF THIS FILE
-- ---------------------------------------------------------------------------
--
-- Two authorities that must never be one:
--
--   PROSPECT PREFERENCE   the prospect's own answer about when they can come.
--                         Updated by them (through an expiring token) or by a
--                         practitioner relaying a phone call. It is an answer,
--                         never an admission decision.
--
--   ADMISSION POLICY      how the studio ranks its queue and how many it
--                         invites. OWNER-ONLY, for read as well as write.
--
-- They are separate tables with separate commands, so no single write path
-- spans them: a fault in the prospect path cannot reach ranking policy, and a
-- prospect holding a valid token cannot influence their own position.
--
-- WHY ADMISSION POLICY IS NOT A COLUMN ON `studios`. It was, in an earlier
-- draft, and that was disproved. ALTER DEFAULT PRIVILEGES grants anon,
-- authenticated AND service_role full DML (arwdDxtm) on every new table in
-- `public`, so `studios` carries UPDATE for anon and authenticated across all
-- 47 of its columns with no granting statement anywhere in the migrations --
-- the default did it. That grant cannot be narrowed per column: `REVOKE UPDATE
-- (col)` succeeds and changes nothing, and an RLS policy authorises a ROW, not
-- a column. So on `studios` there is NO mechanism able to say "owners may edit
-- the studio, but admission policy needs a command".
--
-- An ordinary member cannot write `studios` today -- is_studio_owner requires
-- role='owner' AND active -- so this was never a live hole. The defect is that
-- the design could not STRUCTURALLY prevent one: a future permissive UPDATE
-- policy added to `studios` for any unrelated reason would admit members to
-- admission policy in the same statement. WAIT-03B/B1 found this first for its
-- own allowance column and moved it to its own table; this file does the same.
--
-- EVERY NEW OBJECT HERE STRIPS ITS CREATE-TIME DEFAULTS EXPLICITLY. Nothing
-- below relies on what PostgreSQL or Supabase grants on creation. See the
-- PRIVILEGES section: `revoke all` from all four grantees on every table, then
-- a POSITIVE COLUMN LIST for the one role that needs to read.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS FILE DOES NOT DO
-- ---------------------------------------------------------------------------
--
--   * It does NOT create public.studio_waitlist_admission_rounds. That table
--     belongs to WAIT-03B/B1 and holds THIS ROUND's allowance. This file adds
--     only standing configuration (invite_batch_default / invite_batch_max),
--     which are DEFAULTS AND BOUNDS for a recommendation and never permission
--     to admit. When B1 lands, its per-round allowance is the tighter
--     authority and the ordered claim below must consult it.
--   * It does NOT relax `name`. An email-only legacy row still needs a real
--     name from the operator; there is no name_provenance column and no
--     placeholder path.
--   * It creates no appointment, sends nothing, and admits nobody. Every
--     command here records or authorises; none of them books.
--   * It does not touch the repo-wide default-grant weakness beyond its own
--     objects. That is a separate finding with its own ticket.
--
-- Re-runnable: create-if-not-exists / drop-if-exists throughout.

begin;
set local lock_timeout = '5s';

-- ===========================================================================
-- UNIT A — ENTRY ORIGIN AND PROVENANCE
-- ===========================================================================
--
-- SAFE AS COLUMNS ON THE EXISTING TABLE, and the reason is specific rather
-- than assumed: 0185 already stripped this table's create-time defaults, so it
-- holds exactly `authenticated SELECT` and nothing else. A new column inherits
-- that SELECT (the operator queue needs to read it) and inherits NO write
-- grant. The `studios` hazard does not reach here.
--
-- STANDING RULE: never take a TABLE-level UPDATE grant on this table. While it
-- holds none, a future column can still be made writable with a COLUMN-level
-- grant; once a table-level grant exists that door cannot be shut again.

alter table public.new_client_waitlist_entries
  add column if not exists created_by_practitioner_id uuid,
  add column if not exists joined_at_provenance       text not null default 'form';

-- SOURCE. Was CHECK (source = 'public_booking') -- single-valued, and the one
-- line that made a practitioner-created entry and a legacy import structurally
-- impossible.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_source_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_source_check
  check (source in ('public_booking', 'practitioner', 'legacy_import'));

-- PROVENANCE OF `joined_at`.
--   'form'              the public form stamped it as it happened. Strongest.
--   'operator_supplied' a human asserted it from their records. Weaker: the
--                       difference between an observation and a recollection.
--   'unknown'           nobody has a date. `joined_at` then holds the import
--                       instant and is a QUEUE ANCHOR ONLY.
--
-- THE DEFAULT 'form' FABRICATES NOTHING, and the constraint replaced above is
-- the proof: every existing row satisfied source = 'public_booking', so every
-- existing row demonstrably arrived through the public form. That is a verified
-- fact about the current data, not an assumption about it.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_joined_at_provenance_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_joined_at_provenance_check
  check (joined_at_provenance in ('form', 'operator_supplied', 'unknown'));

-- ONLY THE FORM MAY CLAIM 'form'. Without this the column stops meaning
-- anything: an import could write 'form' and a recollection would be
-- indistinguishable from an observation, which is the exact confusion the
-- column exists to prevent.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_provenance_source_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_provenance_source_check
  check (
    (source = 'public_booking' and joined_at_provenance = 'form')
    or
    (source <> 'public_booking' and joined_at_provenance in ('operator_supplied', 'unknown'))
  );

-- STRUCTURAL TENANCY. Composite (id, studio_id) foreign key, exactly like the
-- three actor columns 0185 already carries: a practitioner from another studio
-- cannot be referenced even if a policy or a command were wrong.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_created_by_same_studio_fk;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_created_by_same_studio_fk
  foreign key (created_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id) on delete restrict;

-- An operator-originated entry NAMES the operator; a public one must not,
-- because nobody at the studio created it. Both directions.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_created_by_evidence_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_created_by_evidence_check
  check (
    (source = 'public_booking' and created_by_practitioner_id is null)
    or
    (source <> 'public_booking' and created_by_practitioner_id is not null)
  );

-- ===========================================================================
-- UNIT B — PROSPECT PREFERENCE
-- ===========================================================================
--
-- NOT STATED IS THE ABSENCE OF A ROW. That is why this is a table and not four
-- columns: every column here can then be NOT NULL, and "we never asked" becomes
-- structurally unforgeable rather than enforced by a four-way CHECK that a
-- later migration could weaken. It also contains the write surface -- a command
-- scoped to this table cannot touch status, claimed_at or invited_at.
create table if not exists public.new_client_waitlist_entry_preferences (
  entry_id     uuid primary key,
  studio_id    uuid not null,
  preference   text not null,
  -- TWO TIMESTAMPS, NOT ONE, AND THIS IS THE PART MOST LIKELY TO BE
  -- "SIMPLIFIED" LATER. stated_at is when the VALUE was last set or changed;
  -- confirmed_at is when it was last AFFIRMED, changed or not. Collapse them
  -- and you must choose which truth to lose: move one column on
  -- re-confirmation and the history of the value is destroyed (a preference
  -- held for eight months looks like one set last week); do not move it and the
  -- preference ages out while the person is actively telling you it still
  -- holds, so the studio re-asks someone who answered last week.
  stated_at    timestamptz not null,
  confirmed_at timestamptz not null,
  source       text not null,
  recorded_by_practitioner_id uuid,

  constraint new_client_waitlist_entry_preferences_preference_check
    check (preference in ('weekdays', 'weekends', 'both')),
  constraint new_client_waitlist_entry_preferences_source_check
    check (source in ('public_form', 'practitioner', 'prospect_link')),
  -- Setting a value IS confirming it, so a fresh statement seeds both to the
  -- same instant. A confirmation predating the value it confirms describes a
  -- write ordering nobody intended.
  constraint new_client_waitlist_entry_preferences_order_check
    check (confirmed_at >= stated_at),
  -- Only a practitioner-recorded preference names a practitioner. Both
  -- directions, so a token-authenticated answer cannot be attributed to a
  -- human who was not involved.
  constraint new_client_waitlist_entry_preferences_recorder_check
    check (
      (source = 'practitioner' and recorded_by_practitioner_id is not null)
      or
      (source <> 'practitioner' and recorded_by_practitioner_id is null)
    ),
  constraint new_client_waitlist_entry_preferences_entry_same_studio_fk
    foreign key (entry_id, studio_id)
    references public.new_client_waitlist_entries (id, studio_id) on delete cascade,
  constraint new_client_waitlist_entry_preferences_recorder_same_studio_fk
    foreign key (recorded_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict
);

-- ---------------------------------------------------------------------------
-- PREFERENCE-UPDATE GRANTS
-- ---------------------------------------------------------------------------
--
-- A SEPARATE TABLE FROM new_client_waitlist_invitations, deliberately. That
-- table's cycle-evidence CHECK requires claimed_at, claimed_by_practitioner_id
-- and invited_at for status 'invited', so issuing one drags a waiting prospect
-- through claim -> invite. Asking someone which days suit them is not an offer
-- of an appointment, and reusing the invitation would consume an admission
-- allowance to ask a question.
create table if not exists public.new_client_waitlist_preference_grants (
  id                        uuid primary key default gen_random_uuid(),
  studio_id                 uuid not null references public.studios (id) on delete cascade,
  entry_id                  uuid not null,
  -- The raw token exists only in the single return value of the issue command
  -- and is stored nowhere. Same shape as 0188's invitation verifier.
  token_hash                text not null,
  issued_at                 timestamptz not null default now(),
  expires_at                timestamptz not null,
  issued_by_practitioner_id uuid not null,
  redeemed_at               timestamptz,
  revoked_at                timestamptz,

  constraint new_client_waitlist_preference_grants_token_hash_check
    check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint new_client_waitlist_preference_grants_ttl_check
    check (expires_at > issued_at),
  -- Redeemed and revoked are both terminal and mutually exclusive.
  constraint new_client_waitlist_preference_grants_terminal_outcome_check
    check (redeemed_at is null or revoked_at is null),
  constraint new_client_waitlist_preference_grants_entry_same_studio_fk
    foreign key (entry_id, studio_id)
    references public.new_client_waitlist_entries (id, studio_id) on delete cascade,
  constraint new_client_waitlist_preference_grants_issuer_same_studio_fk
    foreign key (issued_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict
);

create unique index if not exists new_client_waitlist_preference_grants_token_hash_uniq
  on public.new_client_waitlist_preference_grants (token_hash);

-- AT MOST ONE LIVE GRANT PER ENTRY. Two outstanding links means two people can
-- answer the same question and the later answer silently wins.
create unique index if not exists new_client_waitlist_preference_grants_one_live_per_entry
  on public.new_client_waitlist_preference_grants (entry_id)
  where redeemed_at is null and revoked_at is null;

-- ===========================================================================
-- UNIT C — STUDIO ADMISSION POLICY  (OWNER-ONLY)
-- ===========================================================================
--
-- NO ROW = FIFO ordering and no configured batch = today's exact behaviour, so
-- applying this file changes nothing for any studio until an owner configures
-- one. Same "absence is the default" shape B1 uses for its allowance.
create table if not exists public.studio_waitlist_admission_policy (
  studio_id            uuid primary key references public.studios (id) on delete cascade,
  -- STORAGE, NEVER A TYPE. Every parse rule lives in lib/waitlist/policy.ts,
  -- where ABSENT means FIFO and MALFORMED means refuse -- kept distinct so a
  -- corrupt document cannot silently reorder a queue while the operator
  -- believes their policy is running.
  ranking_policy       jsonb not null,
  -- ADMISSION-ROUND SUPPORT. Defaults and BOUNDS for a recommendation, never
  -- permission to admit. B1's per-round allowance, when it lands, is the
  -- tighter authority and this never overrides it.
  invite_batch_default integer not null,
  invite_batch_max     integer not null,
  updated_at           timestamptz not null default now(),
  updated_by_practitioner_id uuid not null,

  constraint studio_waitlist_admission_policy_batch_default_check
    check (invite_batch_default >= 0),
  constraint studio_waitlist_admission_policy_batch_max_check
    check (invite_batch_max >= invite_batch_default),
  -- The same 1..100 ceiling the existing FIFO claim enforces, so a policy
  -- cannot authorise a batch the claim command would refuse anyway.
  constraint studio_waitlist_admission_policy_batch_ceiling_check
    check (invite_batch_max <= 100),
  constraint studio_waitlist_admission_policy_updater_same_studio_fk
    foreign key (updated_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict
);

-- ===========================================================================
-- ROW LEVEL SECURITY
-- ===========================================================================
--
-- SELECT-ONLY policies, role-scoped TO authenticated, matching the two policies
-- 0185 already carries. No insert/update/delete policy on any table here: every
-- write goes through a SECURITY DEFINER command, which re-derives authority in
-- the database from (studio_id, auth user id) and never takes a role from a
-- request body.
alter table public.new_client_waitlist_entry_preferences enable row level security;
alter table public.new_client_waitlist_preference_grants enable row level security;
alter table public.studio_waitlist_admission_policy enable row level security;

drop policy if exists "new_client_waitlist_entry_preferences_owner_select"
  on public.new_client_waitlist_entry_preferences;
create policy "new_client_waitlist_entry_preferences_owner_select"
  on public.new_client_waitlist_entry_preferences
  for select to authenticated
  using (public.is_studio_owner(studio_id));

drop policy if exists "new_client_waitlist_preference_grants_owner_select"
  on public.new_client_waitlist_preference_grants;
create policy "new_client_waitlist_preference_grants_owner_select"
  on public.new_client_waitlist_preference_grants
  for select to authenticated
  using (public.is_studio_owner(studio_id));

-- OWNER-ONLY FOR READ AS WELL AS WRITE. A member has no business reading how
-- the studio ranks its queue; is_studio_member would have been the broader,
-- lazier predicate.
drop policy if exists "studio_waitlist_admission_policy_owner_select"
  on public.studio_waitlist_admission_policy;
create policy "studio_waitlist_admission_policy_owner_select"
  on public.studio_waitlist_admission_policy
  for select to authenticated
  using (public.is_studio_owner(studio_id));

-- ===========================================================================
-- THE SERVER-TIMESTAMP TRIGGER MUST STOP OVERWRITING AN IMPORTED joined_at
-- ===========================================================================
--
-- 0185 installed a BEFORE INSERT trigger that does `new.joined_at := now()`
-- UNCONDITIONALLY. That is correct and load-bearing for the public form: an
-- anonymous submitter must not be able to forge an earlier join time and buy
-- themselves a better queue position. It is left exactly as it was for that
-- path.
--
-- But it would SILENTLY DEFEAT this file's entire provenance model. A legacy
-- import passing a real join date would have that date discarded and replaced
-- with today, with no error anywhere -- the precise fabrication
-- joined_at_provenance exists to prevent, performed by the database itself.
--
-- So the rule becomes conditional on the ROW'S OWN SOURCE, which is set in the
-- same INSERT and constrained by the CHECKs above:
--
--   source = 'public_booking'  -> joined_at := now(), exactly as before. The
--                                 public path cannot supply one.
--   source <> 'public_booking' -> the caller's joined_at is preserved. Those
--                                 rows are reachable only through the
--                                 owner-authorised commands below, which
--                                 validate the date and require an explicit
--                                 provenance for it.
--
-- updated_at is stamped unconditionally either way; nobody supplies that.
create or replace function public.new_client_waitlist_entries_server_timestamps()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.source = 'public_booking' or new.joined_at is null then
    new.joined_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- ===========================================================================
-- COMMANDS
-- ===========================================================================
--
-- Every one is SECURITY DEFINER, authorises through the existing
-- new_client_waitlist_resolve_owner (which re-derives membership AND role from
-- (studio_id, auth user id) and returns 'not_a_member' / 'not_owner'), and is
-- granted to service_role ALONE. The browser is `anon` on any public path and
-- `authenticated` on the operator path; neither holds EXECUTE on anything here.

-- ---------------------------------------------------------------------------
-- COMMAND 1 — create a waitlist entry for a phone call, walk-in or referral
-- ---------------------------------------------------------------------------
create or replace function public.create_practitioner_waitlist_entry(
  p_studio_id     uuid,
  p_actor_user_id uuid,
  p_name          text,
  p_email         text,
  p_phone         text default null,
  p_preference    text default null
)
returns table (result text, entry_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_code  text;
  v_id    uuid;
  v_now   timestamptz;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then
    return query select v_code, null::uuid;
    return;
  end if;

  if p_preference is not null
     and p_preference not in ('weekdays', 'weekends', 'both') then
    return query select 'invalid_input'::text, null::uuid;
    return;
  end if;

  v_now := clock_timestamp();

  begin
    insert into public.new_client_waitlist_entries
      (studio_id, name, email, phone, source,
       joined_at_provenance, created_by_practitioner_id)
    values
      (p_studio_id, btrim(p_name), btrim(p_email), nullif(btrim(coalesce(p_phone, '')), ''),
       'practitioner',
       -- The studio took this down as it happened, but it is still a human
       -- assertion rather than the form's own stamp. 'form' is not available
       -- to this path and the CHECK enforces that.
       'operator_supplied', v_actor)
    returning id into v_id;
  exception
    when unique_violation then
      -- The partial unique index on (studio_id, email_normalized) where status
      -- in (waiting, claimed, invited). Someone is already in the queue.
      return query select 'already_waiting'::text, null::uuid;
      return;
    when check_violation or not_null_violation then
      return query select 'invalid_input'::text, null::uuid;
      return;
  end;

  if p_preference is not null then
    insert into public.new_client_waitlist_entry_preferences
      (entry_id, studio_id, preference, stated_at, confirmed_at,
       source, recorded_by_practitioner_id)
    values
      (v_id, p_studio_id, p_preference, v_now, v_now, 'practitioner', v_actor);
  end if;

  return query select 'created'::text, v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 2 — import ONE historical, email-only prospect
-- ---------------------------------------------------------------------------
--
-- THERE IS NO DEFAULTING PATH FOR joined_at, and that is the whole command.
-- Both the date and its provenance must be supplied explicitly; passing
-- neither is an error rather than "today". A caller that genuinely has no date
-- passes provenance 'unknown' AND the import instant, and every reader
-- downstream must then treat joined_at as a queue anchor, not a duration.
--
-- One row per call. No bulk endpoint: a loop the caller controls is auditable,
-- interruptible, and cannot half-apply a spreadsheet.
create or replace function public.import_legacy_waitlist_entry(
  p_studio_id     uuid,
  p_actor_user_id uuid,
  p_name          text,
  p_email         text,
  p_joined_at     timestamptz,
  p_provenance    text,
  p_phone         text default null
)
returns table (result text, entry_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_code  text;
  v_id    uuid;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then
    return query select v_code, null::uuid;
    return;
  end if;

  -- 'form' is REFUSED here, not merely absent from the CHECK's reach. An import
  -- claiming the public form's own timestamp would make a recollection
  -- indistinguishable from an observation.
  if p_provenance is null or p_provenance not in ('operator_supplied', 'unknown') then
    return query select 'invalid_provenance'::text, null::uuid;
    return;
  end if;
  if p_joined_at is null then
    return query select 'joined_at_required'::text, null::uuid;
    return;
  end if;
  -- A future join date is not a plausible historical fact and is far more
  -- likely a mis-parsed day/month order than a real one.
  if p_joined_at > clock_timestamp() then
    return query select 'joined_at_in_future'::text, null::uuid;
    return;
  end if;

  begin
    insert into public.new_client_waitlist_entries
      (studio_id, name, email, phone, source, joined_at,
       joined_at_provenance, created_by_practitioner_id)
    values
      (p_studio_id, btrim(p_name), btrim(p_email), nullif(btrim(coalesce(p_phone, '')), ''),
       'legacy_import', p_joined_at, p_provenance, v_actor)
    returning id into v_id;
  exception
    when unique_violation then
      return query select 'already_waiting'::text, null::uuid;
      return;
    when check_violation or not_null_violation then
      -- Includes the name CHECK. `name` stays NOT NULL with length >= 1: an
      -- email-only row must be given a real name by the operator, and there is
      -- deliberately no placeholder path.
      return query select 'invalid_input'::text, null::uuid;
      return;
  end;

  return query select 'imported'::text, v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 3 — record a prospect's availability (practitioner relaying it)
-- ---------------------------------------------------------------------------
create or replace function public.set_waitlist_entry_availability(
  p_studio_id     uuid,
  p_entry_id      uuid,
  p_actor_user_id uuid,
  p_preference    text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor   uuid;
  v_code    text;
  v_now     timestamptz;
  v_current text;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return v_code; end if;

  if p_preference is null or p_preference not in ('weekdays', 'weekends', 'both') then
    return 'invalid_input';
  end if;

  -- Scoped by BOTH id and studio_id, so a guessed entry id from another tenant
  -- resolves to nothing rather than to someone else's prospect.
  --
  -- LOCKED, NOT MERELY CHECKED. `select ... for update` on the PREFERENCE row
  -- below locks NOTHING when that row is absent, so two callers setting an
  -- entry's FIRST preference both saw no row, both took the insert path, and
  -- the loser raised a bare unique_violation instead of returning a code --
  -- which 0185 forbids and 0188's requeue repair is the precedent against.
  -- Reproduced deterministically before it was fixed. The ENTRY row always
  -- exists, so locking it is a real mutex, and it serialises this path against
  -- redeem_waitlist_preference_grant, which writes the same preference table.
  perform 1 from public.studios s where s.id = p_studio_id for update;

  perform 1 from public.new_client_waitlist_entries e
   where e.id = p_entry_id and e.studio_id = p_studio_id
   for update;
  if not found then return 'entry_not_found'; end if;

  -- Read after the locks, for the same reason redeem_ does: this transaction
  -- can wait on the entry lock, and every timestamp it writes must describe
  -- when it actually acted.
  v_now := clock_timestamp();

  select p.preference into v_current
    from public.new_client_waitlist_entry_preferences p
   where p.entry_id = p_entry_id
   for update;

  if v_current is null then
    insert into public.new_client_waitlist_entry_preferences
      (entry_id, studio_id, preference, stated_at, confirmed_at,
       source, recorded_by_practitioner_id)
    values (p_entry_id, p_studio_id, p_preference, v_now, v_now, 'practitioner', v_actor);
    return 'stated';
  end if;

  -- THE CONFIRMATION RULE, and it is the reason there are two timestamps.
  -- An UNCHANGED answer moves only confirmed_at: trust is refreshed without
  -- rewriting the history of the value. A CHANGED answer moves both, because a
  -- different answer is a new statement.
  if v_current = p_preference then
    update public.new_client_waitlist_entry_preferences
       set confirmed_at = v_now,
           source = 'practitioner',
           recorded_by_practitioner_id = v_actor
     where entry_id = p_entry_id;
    return 'confirmed';
  end if;

  update public.new_client_waitlist_entry_preferences
     set preference = p_preference,
         stated_at = v_now,
         confirmed_at = v_now,
         source = 'practitioner',
         recorded_by_practitioner_id = v_actor
   where entry_id = p_entry_id;
  return 'changed';
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 4 — issue a preference-update link for a prospect
-- ---------------------------------------------------------------------------
--
-- The raw token is generated HERE and returned exactly once. Only its hash is
-- stored, so a database read -- by anyone, including the operator -- cannot
-- reconstruct a live credential.
create or replace function public.issue_waitlist_preference_grant(
  p_studio_id     uuid,
  p_entry_id      uuid,
  p_actor_user_id uuid,
  p_ttl_hours     integer default 168
)
returns table (result text, raw_token text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor   uuid;
  v_code    text;
  v_raw     text;
  v_hash    text;
  v_ttl     integer := coalesce(p_ttl_hours, 168);
  v_expires timestamptz;
  -- ONE authoritative instant for the whole command: retirement, the liveness
  -- verdict and the new window are all measured against the same clock, so a
  -- grant cannot be judged expired by one line and live by the next.
  v_now     timestamptz;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then
    return query select v_code, null::text, null::timestamptz;
    return;
  end if;
  if v_ttl < 1 or v_ttl > 720 then
    return query select 'invalid_input'::text, null::text, null::timestamptz;
    return;
  end if;

  -- CANONICAL LOCK ORDER: STUDIO -> ENTRY -> GRANT. Every writer, no exceptions.
  --
  -- THE STUDIO LOCK IS NOT DECORATION HERE. Inserting a grant takes an implicit
  -- FK key-share lock on `studios`, because the row carries a studio_id
  -- reference. Taking only the entry lock therefore gave this command a real
  -- order of ENTRY -> STUDIO, while admit_new_client_waitlist_entry explicitly
  -- takes STUDIO -> ENTRY. Two of those meeting is a genuine deadlock:
  --
  --     admit_:  holds studios, waits for the entry
  --     issue_:  holds the entry, waits for studios (via the FK)
  --
  -- An implicit lock is still a lock, and the one taken last by a statement is
  -- the easiest kind to forget. Taking studios explicitly and FIRST makes the
  -- later FK check free -- this transaction already holds something stronger --
  -- and puts every command on one order.
  --
  -- The ENTRY lock below is what serialises the grant lifecycle itself: the
  -- entry row always exists, so it is a real mutex where a lock on an absent
  -- grant or preference row is not.
  perform 1 from public.studios s where s.id = p_studio_id for update;
  if not found then
    return query select 'entry_not_found'::text, null::text, null::timestamptz;
    return;
  end if;

  perform 1 from public.new_client_waitlist_entries e
   where e.id = p_entry_id and e.studio_id = p_studio_id
   for update;
  if not found then
    return query select 'entry_not_found'::text, null::text, null::timestamptz;
    return;
  end if;

  v_now := clock_timestamp();

  -- RETIRE AN EXPIRED LINK BEFORE ISSUING A REPLACEMENT.
  --
  -- The one-live-grant index keys on redeemed_at/revoked_at ONLY, so an EXPIRED
  -- grant still occupies the slot while redemption already refuses it. Without
  -- this, the first expiry made the entry permanently un-issuable: every later
  -- issue returned `grant_already_live`, and the owner's only exit was a
  -- separate revoke of a link that was already dead. Reproduced before it was
  -- fixed; expiry is now self-healing and costs the operator nothing.
  --
  -- NO ENTRY LOCK IS TAKEN HERE, DELIBERATELY. Locking the entry would give
  -- this command an entry -> grant order while redeem_ holds grant -> entry,
  -- and that inversion is a deadlock. Concurrency is already handled: the
  -- partial unique index lets exactly one live row exist, and the loser of a
  -- race is told `grant_already_live`, which is then TRUE.
  update public.new_client_waitlist_preference_grants g
     set revoked_at = v_now
   where g.entry_id    = p_entry_id
     and g.studio_id   = p_studio_id
     and g.redeemed_at is null
     and g.revoked_at  is null
     and g.expires_at  <= v_now;

  -- NOW ask whether a GENUINELY live link remains. Under the entry lock this is
  -- decisive rather than advisory, so the caller is told `grant_already_live`
  -- by a deliberate verdict instead of by catching a constraint. The unique
  -- index below stays exactly as it was and remains the last word.
  if exists (
    select 1 from public.new_client_waitlist_preference_grants g
     where g.entry_id    = p_entry_id
       and g.studio_id   = p_studio_id
       and g.redeemed_at is null
       and g.revoked_at  is null
  ) then
    return query select 'grant_already_live'::text, null::text, null::timestamptz;
    return;
  end if;

  v_raw     := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash    := encode(extensions.digest(v_raw, 'sha256'), 'hex');
  v_expires := v_now + make_interval(hours => v_ttl);

  begin
    insert into public.new_client_waitlist_preference_grants
      (studio_id, entry_id, token_hash, expires_at, issued_by_practitioner_id)
    values (p_studio_id, p_entry_id, v_hash, v_expires, v_actor);
  exception
    when unique_violation then
      -- The one-live-grant-per-entry partial index. Two outstanding links mean
      -- two people can answer the same question and the later answer wins.
      return query select 'grant_already_live'::text, null::text, null::timestamptz;
      return;
  end;

  return query select 'issued'::text, v_raw, v_expires;
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 5 — revoke a live preference-update link
-- ---------------------------------------------------------------------------
create or replace function public.revoke_waitlist_preference_grant(
  p_studio_id     uuid,
  p_entry_id      uuid,
  p_actor_user_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_code  text;
  v_n     integer;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return v_code; end if;

  -- The same STUDIO -> ENTRY order every other writer takes. This command only
  -- stamps revoked_at and could not deadlock on its own, but a uniform rule is
  -- worth more than a per-command exemption someone must later re-derive --
  -- which is exactly how the entry -> studio inversion got in.
  perform 1 from public.studios s where s.id = p_studio_id for update;

  perform 1 from public.new_client_waitlist_entries e
   where e.id = p_entry_id and e.studio_id = p_studio_id
   for update;

  update public.new_client_waitlist_preference_grants g
     set revoked_at = clock_timestamp()
   where g.entry_id    = p_entry_id
     and g.studio_id   = p_studio_id
     and g.redeemed_at is null
     and g.revoked_at  is null;
  get diagnostics v_n = row_count;

  return case when v_n = 1 then 'revoked' else 'no_live_grant' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 6 — the PROSPECT'S OWN path. No session; the token is the authority.
-- ---------------------------------------------------------------------------
--
-- WHAT IT MAY WRITE: `preference` and the grant's own redeemed_at. Nothing
-- else. It cannot reach status, claimed_at, invited_at or any lifecycle
-- evidence -- structurally, because the preferences table contains none of
-- them -- so a prospect holding a valid token cannot influence their own
-- position in the queue.
--
-- ONE REFUSAL FOR EVERY FAILURE. Unknown, expired, revoked, already-redeemed
-- and belonging-to-a-removed-entry all return the identical 'refused'. A
-- distinguishable answer would turn this endpoint into a membership oracle:
-- one request per guessed token telling an anonymous caller something about a
-- named person's request for treatment.
create or replace function public.redeem_waitlist_preference_grant(
  p_raw_token  text,
  p_preference text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_grant   record;
  v_entry   uuid;
  v_studio  uuid;
  v_now     timestamptz;
  v_current text;
begin
  if p_raw_token is null or p_preference is null
     or p_preference not in ('weekdays', 'weekends', 'both') then
    return 'refused';
  end if;

  -- STEP 1: an UNLOCKED read, for one purpose only -- to learn WHICH studio and
  -- entry this token belongs to, so the canonical locks can be taken in order.
  -- NOTHING IS DECIDED HERE, and no clock is read yet: every predicate is
  -- re-checked in step 4 under the locks, against a clock read after them.
  select g.entry_id, g.studio_id into v_entry, v_studio
    from public.new_client_waitlist_preference_grants g
   where g.token_hash = encode(extensions.digest(p_raw_token, 'sha256'), 'hex');
  if v_entry is null then return 'refused'; end if;

  -- STEP 2: CANONICAL LOCK ORDER, STUDIO -> ENTRY, the same order
  -- admit_new_client_waitlist_entry and issue_ take. Taking the entry alone
  -- would leave this command free to reach for studios afterwards through an
  -- FK and invert against admission.
  perform 1 from public.studios s where s.id = v_studio for update;

  perform 1 from public.new_client_waitlist_entries e
   where e.id = v_entry
   for update;

  -- STEP 3: READ THE CLOCK ONLY NOW, AFTER THE LOCKS.
  --
  -- Capturing it before the lock was a real defect, not a tidiness point. This
  -- transaction can WAIT on the entry lock for an unbounded time -- behind an
  -- operator recording a preference, or another redemption -- and a grant that
  -- was live when the wait began can expire during it. A pre-lock timestamp
  -- makes the expiry re-check pass on evidence that is already stale, and the
  -- redemption is then stamped as though it happened before expiry. The whole
  -- point of re-resolving under the lock is to decide on CURRENT truth, and a
  -- stale clock quietly re-introduces the window the lock was taken to close.
  v_now := clock_timestamp();

  -- STEP 4: re-resolve the grant UNDER the locks, with the full validity
  -- predicate and the post-lock clock. This is the read that decides.
  select g.id, g.entry_id, g.studio_id
    into v_grant
    from public.new_client_waitlist_preference_grants g
   where g.token_hash  = encode(extensions.digest(p_raw_token, 'sha256'), 'hex')
     and g.redeemed_at is null
     and g.revoked_at  is null
     and g.expires_at  > v_now
   for update;

  if not found then return 'refused'; end if;

  select p.preference into v_current
    from public.new_client_waitlist_entry_preferences p
   where p.entry_id = v_grant.entry_id
   for update;

  if v_current is null then
    insert into public.new_client_waitlist_entry_preferences
      (entry_id, studio_id, preference, stated_at, confirmed_at, source,
       recorded_by_practitioner_id)
    values (v_grant.entry_id, v_grant.studio_id, p_preference, v_now, v_now,
            'prospect_link', null);
  elsif v_current = p_preference then
    update public.new_client_waitlist_entry_preferences
       set confirmed_at = v_now, source = 'prospect_link',
           recorded_by_practitioner_id = null
     where entry_id = v_grant.entry_id;
  else
    update public.new_client_waitlist_entry_preferences
       set preference = p_preference, stated_at = v_now, confirmed_at = v_now,
           source = 'prospect_link', recorded_by_practitioner_id = null
     where entry_id = v_grant.entry_id;
  end if;

  update public.new_client_waitlist_preference_grants
     set redeemed_at = v_now
   where id = v_grant.id;

  return 'accepted';
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 7 — set the studio's admission policy. OWNER ONLY.
-- ---------------------------------------------------------------------------
create or replace function public.set_studio_waitlist_admission_policy(
  p_studio_id            uuid,
  p_actor_user_id        uuid,
  p_ranking_policy       jsonb,
  p_invite_batch_default integer,
  p_invite_batch_max     integer
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_code  text;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  -- A member reaches exactly this line and leaves with 'not_owner'. No row is
  -- read, none is written, and the caller learns nothing about the policy.
  if v_code <> 'ok' then return v_code; end if;

  if p_ranking_policy is null
     or jsonb_typeof(p_ranking_policy) <> 'object'
     or p_invite_batch_default is null or p_invite_batch_max is null then
    return 'invalid_input';
  end if;

  begin
    insert into public.studio_waitlist_admission_policy
      (studio_id, ranking_policy, invite_batch_default, invite_batch_max,
       updated_at, updated_by_practitioner_id)
    values (p_studio_id, p_ranking_policy, p_invite_batch_default,
            p_invite_batch_max, clock_timestamp(), v_actor)
    on conflict (studio_id) do update
       set ranking_policy       = excluded.ranking_policy,
           invite_batch_default = excluded.invite_batch_default,
           invite_batch_max     = excluded.invite_batch_max,
           updated_at           = excluded.updated_at,
           updated_by_practitioner_id = excluded.updated_by_practitioner_id;
  exception
    when check_violation then
      return 'invalid_input';
  end;

  return 'set';
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 8 — claim a RANKED batch, preserving every property of the FIFO one
-- ---------------------------------------------------------------------------
--
-- The ranked counterpart to claim_new_client_waitlist_entries. Ranking happens
-- in the application (lib/waitlist), which hands this an EXPLICIT ordered id
-- list; the database keeps owning the parts that must not move to the client:
--
--   * FOR UPDATE SKIP LOCKED, so two concurrent operators never claim one row;
--   * ONE decision instant shared by every row this call wins, read INSIDE the
--     candidate-dependent statement rather than before it -- 0185's ordering
--     defect, where a requeue committing in the gap was stamped before the
--     `waiting` event that created it;
--   * the 1..100 bound;
--   * and the studio's own configured ceiling, when it has one.
--
-- ADMISSION-ROUND SUPPORT: invite_batch_max only ever TIGHTENS. A studio with
-- no policy row behaves exactly as today. When WAIT-03B/B1's per-round
-- allowance lands it becomes the tighter authority again, and this must consult
-- it rather than replace it.
create or replace function public.claim_new_client_waitlist_entries_ordered(
  p_studio_id     uuid,
  p_actor_user_id uuid,
  p_entry_ids     uuid[]
)
returns table (result text, entry_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_code  text;
  v_cap   integer;
  v_n     integer;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then
    return query select v_code, null::uuid;
    return;
  end if;

  v_n := coalesce(array_length(p_entry_ids, 1), 0);
  if v_n < 1 or v_n > 100 then
    return query select 'invalid_count'::text, null::uuid;
    return;
  end if;

  select a.invite_batch_max into v_cap
    from public.studio_waitlist_admission_policy a
   where a.studio_id = p_studio_id;
  if v_cap is not null and v_n > v_cap then
    return query select 'exceeds_batch_max'::text, null::uuid;
    return;
  end if;

  return query
  with requested as (
    select u.id, u.ord
      from unnest(p_entry_ids) with ordinality as u(id, ord)
  ),
  candidates as materialized (
    select e.id, r.ord
      from public.new_client_waitlist_entries e
      join requested r on r.id = e.id
     where e.studio_id = p_studio_id
       and e.status    = 'waiting'
     order by r.ord
     for update of e skip locked
  ),
  decision as materialized (
    select clock_timestamp() as decision_at from candidates limit 1
  ),
  claimed as (
    update public.new_client_waitlist_entries t
       set status                     = 'claimed',
           claimed_at                 = d.decision_at,
           claimed_by_practitioner_id = v_actor
      from candidates c
      cross join decision d
     where t.id        = c.id
       and t.studio_id = p_studio_id
       and t.status    = 'waiting'
    -- `c.ord` IS CARRIED OUT OF THE UPDATE ON PURPOSE. An UPDATE ... RETURNING
    -- emits rows in whatever order the executor produced them, which for this
    -- statement is NOT the caller's ranking -- measured: a two-element batch
    -- came back reversed. Selecting the rank alongside the id is what lets the
    -- final projection restore it. Ordering only the `candidates` CTE is not
    -- enough: that orders which rows are LOCKED, not which are RETURNED.
    returning t.id, c.ord
  )
  select 'claimed'::text, claimed.id from claimed order by claimed.ord;
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 9 — "INVITE TO BOOK": the practitioner-facing admission operation
-- ---------------------------------------------------------------------------
--
-- THE PRODUCT LAW THIS ENFORCES. A practitioner sees a waiting person, chooses
-- a service, a booking window and an expiry, and presses one button. CLAIM IS
-- NOT A WORKFLOW STEP. It remains an internal lifecycle state that this command
-- establishes on the practitioner's behalf, inside the same transaction, and
-- never surfaces as a second thing a human must remember to do.
--
-- WHY IT IS NOT "CALL claim_ THEN CALL issue_". Two commands is two round
-- trips, and the window between them is not theoretical: allowance can be
-- consumed by another operator, the round can close, the service can be
-- deleted, the scope can be rejected. Every one of those leaves the entry
-- CLAIMED with no invitation — a prospect frozen out of the queue by a
-- half-finished action nobody can see. That is the state this command exists to
-- make unreachable.
--
-- ---------------------------------------------------------------------------
-- HOW "NO PARTIAL CLAIM" IS ACTUALLY GUARANTEED
-- ---------------------------------------------------------------------------
--
-- A plpgsql `return` DOES NOT UNDO WORK ALREADY DONE. Claiming the entry and
-- then returning 'round_full' would COMMIT the claim — the precise stray state
-- negative control A exists to catch. So the mutating half runs inside a
-- BEGIN/EXCEPTION block, which PostgreSQL implements as a SUBTRANSACTION: any
-- exception raised inside it rolls back everything it did.
--
-- Failure therefore RAISES a sentinel carrying the code, the subtransaction
-- unwinds the claim, and the handler returns that code as an ordinary value.
-- The caller still gets a CODE and never an error — 0185's rule, and 0188's
-- requeue precedent — while the database gets a true all-or-nothing.
--
-- LOCK ORDER IS THE CANONICAL ONE, AND IT IS TAKEN HERE FIRST:
--
--     studios -> studio_waitlist_admission_rounds -> entry -> invitation
--
-- issue_scoped_new_client_waitlist_invitation takes studios then the round;
-- claim_new_client_waitlist_entry takes the entry. Calling claim_ first would
-- give studios -> entry -> round and invert the order against a bare
-- issue_scoped running concurrently, which is a deadlock. Taking the studio and
-- round locks up front makes the nested calls re-acquire locks this transaction
-- already holds, which is free.
--
-- ALLOWANCE IS NOT RE-IMPLEMENTED HERE. The round, the consumed count and the
-- round_full verdict all belong to 0192 and are enforced inside issue_scoped_
-- under the same lock this function already holds. A second copy of that
-- arithmetic is a second thing to drift.
--
-- AN ALREADY-CLAIMED ENTRY IS ADMITTED, NOT REFUSED. Rows left `claimed` by the
-- previous two-step workflow are legitimate, and making an operator perform a
-- release/requeue round trip to reach the new button would be a migration cost
-- paid by the person least able to understand it. Such an entry skips the claim
-- and goes straight to issue.
--
-- NO EMAIL IS SENT HERE. The raw token is returned exactly once, to a caller
-- that delivers AFTER commit. A provider failure then means "the invitation
-- exists and delivery must be retried", never a rollback decided by an
-- uncertain provider answer.
create or replace function public.admit_new_client_waitlist_entry(
  p_studio_id        uuid,
  p_actor_user_id    uuid,
  p_entry_id         uuid,
  p_service_id       uuid,
  p_start_date       date,
  p_end_date         date,
  p_allowed_weekdays smallint[] default null,
  p_ttl_hours        integer default 72
)
returns table (
  result         text,
  invitation_id  uuid,
  raw_token      text,
  expires_at     timestamptz,
  delivery_email text,
  delivery_name  text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor    uuid;
  v_code     text;
  v_status   text;
  v_needs_claim boolean;
  v_claim    text;
  v_issue    record;
  v_expires  timestamptz;
  v_email    text;
  v_name     text;
begin
  -- 1. AUTHORITY. Membership and owner role are re-derived in the database from
  -- (studio_id, auth user id). No browser-supplied studio or actor becomes
  -- authority: the caller passes ids, the database decides what they mean.
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then
    return query select v_code, null::uuid, null::text, null::timestamptz, null::text, null::text;
    return;
  end if;

  -- 2. LOCK ORDER STEP 1 and 2, before any entry is touched.
  perform 1 from public.studios s where s.id = p_studio_id for update;
  if not found then
    return query select 'unknown_studio'::text, null::uuid, null::text, null::timestamptz, null::text, null::text;
    return;
  end if;
  perform 1 from public.studio_waitlist_admission_rounds r
   where r.studio_id = p_studio_id for update;

  -- 3. LOCK ORDER STEP 3. Read the entry's admissibility under its own lock, so
  -- the status this decision rests on cannot move underneath it.
  select e.status, e.email, e.name into v_status, v_email, v_name
    from public.new_client_waitlist_entries e
   where e.id = p_entry_id and e.studio_id = p_studio_id
   for update;

  -- Scoped by BOTH id and studio_id, so an entry belonging to another tenant is
  -- indistinguishable from one that does not exist.
  if v_status is null then
    return query select 'not_found'::text, null::uuid, null::text, null::timestamptz, null::text, null::text;
    return;
  end if;

  if v_status = 'waiting' then
    v_needs_claim := true;
  elsif v_status = 'claimed' then
    -- Left by the previous workflow, or by an internal path. Legitimate.
    v_needs_claim := false;
  else
    -- invited / converted / expired / released / removed. Each has its own
    -- lifecycle exit; none of them is admissible by pressing this button.
    return query select 'not_admissible'::text, null::uuid, null::text, null::timestamptz, null::text, null::text;
    return;
  end if;

  -- 4-9. THE MUTATING HALF, in a subtransaction. Everything from here either
  -- commits together or leaves no trace.
  begin
    if v_needs_claim then
      v_claim := public.claim_new_client_waitlist_entry(p_studio_id, p_entry_id, p_actor_user_id);
      if v_claim <> 'claimed' then
        raise exception '%', v_claim using errcode = 'WA001';
      end if;
    end if;

    -- 0192 owns service validation, scope validation, weekday canonicalisation,
    -- the no-repeat-declined rule, the allowance verdict and the token. This
    -- command owns only the ORDER and the atomicity.
    select * into v_issue
      from public.issue_scoped_new_client_waitlist_invitation(
             p_studio_id, p_entry_id, p_actor_user_id, p_service_id,
             p_start_date, p_end_date, p_allowed_weekdays, p_ttl_hours);

    if v_issue.result <> 'issued' then
      -- Carries 0192's own vocabulary out unchanged: no_round_open, round_full,
      -- invalid_service, invalid_scope_dates, invalid_weekdays,
      -- already_declined_offer, already_invited, invalid_ttl...
      raise exception '%', v_issue.result using errcode = 'WA001';
    end if;

    select i.expires_at into v_expires
      from public.new_client_waitlist_invitations i
     where i.id = v_issue.invitation_id;

    return query select 'admitted'::text, v_issue.invitation_id, v_issue.raw_token,
                        v_expires, v_email, v_name;
    return;

  exception
    when sqlstate 'WA001' then
      -- The subtransaction has already rolled back the claim, if one was taken.
      -- SQLERRM carries the refusal code the inner command produced.
      return query select SQLERRM::text, null::uuid, null::text, null::timestamptz, null::text, null::text;
      return;
  end;
end;
$$;

-- ===========================================================================
-- PRIVILEGES — EXPLICIT FOR EVERY NEW OBJECT
-- ===========================================================================
--
-- NOTHING HERE RELIES ON A CREATE-TIME DEFAULT. ALTER DEFAULT PRIVILEGES grants
-- anon, authenticated AND service_role full DML on every new table in `public`
-- and EXECUTE on every new function, so each object is stripped by name first
-- and then given back only what it demonstrably needs.

revoke all on public.new_client_waitlist_entry_preferences from public;
revoke all on public.new_client_waitlist_entry_preferences from anon;
revoke all on public.new_client_waitlist_entry_preferences from authenticated;
revoke all on public.new_client_waitlist_entry_preferences from service_role;

revoke all on public.new_client_waitlist_preference_grants from public;
revoke all on public.new_client_waitlist_preference_grants from anon;
revoke all on public.new_client_waitlist_preference_grants from authenticated;
revoke all on public.new_client_waitlist_preference_grants from service_role;

revoke all on public.studio_waitlist_admission_policy from public;
revoke all on public.studio_waitlist_admission_policy from anon;
revoke all on public.studio_waitlist_admission_policy from authenticated;
revoke all on public.studio_waitlist_admission_policy from service_role;

-- READ, AND ONLY READ. The operator queue and settings pages read with the
-- USER-scoped client under RLS, so `authenticated` genuinely needs SELECT;
-- granting nothing would leave those pages unable to render. No role receives
-- INSERT, UPDATE or DELETE on anything here -- that is what makes the write
-- path unreachable from a session rather than merely policed by one.
--
-- service_role receives NO table privilege either: a SECURITY DEFINER function
-- executes as its owner and needs none. The server's most privileged client can
-- therefore run the commands and cannot dump these tables directly.
grant select (
  entry_id, studio_id, preference, stated_at, confirmed_at, source,
  recorded_by_practitioner_id
) on public.new_client_waitlist_entry_preferences to authenticated;

-- COLUMN PRIVILEGES, NOT WHOLE-TABLE SELECT, exactly as 0188 does for the
-- invitation verifier. `token_hash` is a live credential and RLS scopes ROWS,
-- not COLUMNS -- a plain table-level grant would let an authenticated owner
-- read the hash for every grant their studio can see. The safe set is a
-- POSITIVE LIST, so a column added later is unreadable until someone adds it
-- here deliberately.
grant select (
  id, studio_id, entry_id, issued_at, expires_at,
  issued_by_practitioner_id, redeemed_at, revoked_at
) on public.new_client_waitlist_preference_grants to authenticated;

grant select (
  studio_id, ranking_policy, invite_batch_default, invite_batch_max,
  updated_at, updated_by_practitioner_id
) on public.studio_waitlist_admission_policy to authenticated;

-- COMMANDS: service_role ONLY. Written as literal statements, never a DO-block
-- with format(), because the grant guards read them textually. All four
-- grantees are revoked BY NAME first -- ALTER DEFAULT PRIVILEGES arms anon,
-- authenticated AND service_role at function-create time, missed for anon in
-- 0129 and for service_role in 0164.
revoke execute on function public.admit_new_client_waitlist_entry(uuid, uuid, uuid, uuid, date, date, smallint[], integer) from public;
revoke execute on function public.admit_new_client_waitlist_entry(uuid, uuid, uuid, uuid, date, date, smallint[], integer) from anon;
revoke execute on function public.admit_new_client_waitlist_entry(uuid, uuid, uuid, uuid, date, date, smallint[], integer) from authenticated;
revoke execute on function public.admit_new_client_waitlist_entry(uuid, uuid, uuid, uuid, date, date, smallint[], integer) from service_role;

revoke execute on function public.create_practitioner_waitlist_entry(uuid, uuid, text, text, text, text) from public;
revoke execute on function public.create_practitioner_waitlist_entry(uuid, uuid, text, text, text, text) from anon;
revoke execute on function public.create_practitioner_waitlist_entry(uuid, uuid, text, text, text, text) from authenticated;
revoke execute on function public.create_practitioner_waitlist_entry(uuid, uuid, text, text, text, text) from service_role;

revoke execute on function public.import_legacy_waitlist_entry(uuid, uuid, text, text, timestamptz, text, text) from public;
revoke execute on function public.import_legacy_waitlist_entry(uuid, uuid, text, text, timestamptz, text, text) from anon;
revoke execute on function public.import_legacy_waitlist_entry(uuid, uuid, text, text, timestamptz, text, text) from authenticated;
revoke execute on function public.import_legacy_waitlist_entry(uuid, uuid, text, text, timestamptz, text, text) from service_role;

revoke execute on function public.set_waitlist_entry_availability(uuid, uuid, uuid, text) from public;
revoke execute on function public.set_waitlist_entry_availability(uuid, uuid, uuid, text) from anon;
revoke execute on function public.set_waitlist_entry_availability(uuid, uuid, uuid, text) from authenticated;
revoke execute on function public.set_waitlist_entry_availability(uuid, uuid, uuid, text) from service_role;

revoke execute on function public.issue_waitlist_preference_grant(uuid, uuid, uuid, integer) from public;
revoke execute on function public.issue_waitlist_preference_grant(uuid, uuid, uuid, integer) from anon;
revoke execute on function public.issue_waitlist_preference_grant(uuid, uuid, uuid, integer) from authenticated;
revoke execute on function public.issue_waitlist_preference_grant(uuid, uuid, uuid, integer) from service_role;

revoke execute on function public.revoke_waitlist_preference_grant(uuid, uuid, uuid) from public;
revoke execute on function public.revoke_waitlist_preference_grant(uuid, uuid, uuid) from anon;
revoke execute on function public.revoke_waitlist_preference_grant(uuid, uuid, uuid) from authenticated;
revoke execute on function public.revoke_waitlist_preference_grant(uuid, uuid, uuid) from service_role;

revoke execute on function public.redeem_waitlist_preference_grant(text, text) from public;
revoke execute on function public.redeem_waitlist_preference_grant(text, text) from anon;
revoke execute on function public.redeem_waitlist_preference_grant(text, text) from authenticated;
revoke execute on function public.redeem_waitlist_preference_grant(text, text) from service_role;

revoke execute on function public.set_studio_waitlist_admission_policy(uuid, uuid, jsonb, integer, integer) from public;
revoke execute on function public.set_studio_waitlist_admission_policy(uuid, uuid, jsonb, integer, integer) from anon;
revoke execute on function public.set_studio_waitlist_admission_policy(uuid, uuid, jsonb, integer, integer) from authenticated;
revoke execute on function public.set_studio_waitlist_admission_policy(uuid, uuid, jsonb, integer, integer) from service_role;

revoke execute on function public.claim_new_client_waitlist_entries_ordered(uuid, uuid, uuid[]) from public;
revoke execute on function public.claim_new_client_waitlist_entries_ordered(uuid, uuid, uuid[]) from anon;
revoke execute on function public.claim_new_client_waitlist_entries_ordered(uuid, uuid, uuid[]) from authenticated;
revoke execute on function public.claim_new_client_waitlist_entries_ordered(uuid, uuid, uuid[]) from service_role;

grant execute on function public.admit_new_client_waitlist_entry(uuid, uuid, uuid, uuid, date, date, smallint[], integer) to service_role;
grant execute on function public.create_practitioner_waitlist_entry(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.import_legacy_waitlist_entry(uuid, uuid, text, text, timestamptz, text, text) to service_role;
grant execute on function public.set_waitlist_entry_availability(uuid, uuid, uuid, text) to service_role;
grant execute on function public.issue_waitlist_preference_grant(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.revoke_waitlist_preference_grant(uuid, uuid, uuid) to service_role;
grant execute on function public.redeem_waitlist_preference_grant(text, text) to service_role;
grant execute on function public.set_studio_waitlist_admission_policy(uuid, uuid, jsonb, integer, integer) to service_role;
grant execute on function public.claim_new_client_waitlist_entries_ordered(uuid, uuid, uuid[]) to service_role;

-- The replaced trigger function is SECURITY INVOKER-shaped and `returns
-- trigger`, so an EXECUTE grant on it is inert (PostgreSQL raises 0A000 on a
-- direct call). Revoked from all four anyway, exactly as 0185 does, so the API
-- surface states the fact rather than carrying create-time defaults.
revoke all privileges on function public.new_client_waitlist_entries_server_timestamps()
  from public, anon, authenticated, service_role;

-- ===========================================================================
-- COMMENTS
-- ===========================================================================
comment on table public.new_client_waitlist_entry_preferences is
  'WAIT-ADMIT-01: a prospect''s own answer about which days they can attend. NOT STATED IS THE ABSENCE OF A ROW, which is why every column is NOT NULL — "we never asked" is structurally unforgeable rather than CHECK-enforced. stated_at is when the VALUE last changed; confirmed_at is when it was last AFFIRMED, changed or not, and staleness is measured from confirmed_at so re-confirming an unchanged preference refreshes trust without rewriting the value''s history. Prospect-owned data: it records an answer and never an admission decision. Separate from studio_waitlist_admission_policy so no single write path spans a prospect''s answer and the studio''s ranking.';

comment on table public.new_client_waitlist_preference_grants is
  'WAIT-ADMIT-01: an expiring, hashed capability letting a prospect update their own availability without an account. Deliberately NOT new_client_waitlist_invitations: that table''s cycle-evidence CHECK requires claimed_at + claimed_by + invited_at for status ''invited'', so issuing one would drag a waiting prospect through claim -> invite. Asking which days suit someone is not an offer of an appointment and must not consume an admission allowance. The raw token exists only in the return value of issue_waitlist_preference_grant; token_hash is excluded from the authenticated SELECT grant because RLS scopes rows, not columns.';

comment on table public.studio_waitlist_admission_policy is
  'WAIT-ADMIT-01: OWNER-ONLY ranking and invite-batch configuration. NO ROW = FIFO ordering and no configured batch = the behaviour before this migration, so applying it changes nothing until an owner configures a studio. Deliberately its own table: a column on studios would inherit the browser-reachable table-level UPDATE grant anon and authenticated already hold from ALTER DEFAULT PRIVILEGES, and a column-level revoke cannot remove a table-level grant — the same correction WAIT-03B/B1 made for its allowance. invite_batch_default/max are DEFAULTS AND BOUNDS for a recommendation, never permission to admit; B1''s per-round allowance remains the tighter authority when it lands.';

comment on column public.new_client_waitlist_entries.joined_at_provenance is
  'WAIT-ADMIT-01: the evidence behind joined_at. ''form'' = the public form stamped it as it happened. ''operator_supplied'' = a human asserted it from their records — an observation vs a recollection, and the distinction must survive. ''unknown'' = nobody has a date, joined_at then holds the import instant and is a QUEUE ANCHOR ONLY: no reader may render it as a duration. The DEFAULT ''form'' fabricates nothing — the single-valued source CHECK it replaced proves every pre-existing row arrived through the public form.';

commit;
