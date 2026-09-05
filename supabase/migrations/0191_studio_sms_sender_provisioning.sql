-- ===========================================================================
-- PER-STUDIO SMS SENDER — PROVISIONING RECORD AND CLAIM (COMMS-01B) — 0191
-- ===========================================================================
--
-- WHAT EXISTS TODAY. Hone sends SMS through ONE deployment-global Twilio
-- identity: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN authenticate, and
-- TWILIO_MESSAGING_SERVICE_SID (or TWILIO_FROM_NUMBER) is the sender. Every
-- studio therefore texts from the SAME number. The three per-studio
-- `send_*_sms` booleans on `public.studios` (0049) decide WHETHER a studio
-- sends; nothing decides WHAT IT SENDS FROM. There is no per-studio sender
-- identity anywhere in the schema before this file.
--
-- WHAT THIS FILE ADDS. One row per studio recording the provider resources
-- Hone owns ON THAT STUDIO'S BEHALF, and the durable claim that makes buying
-- them safe. It adds NO sending capability, changes NO existing send path,
-- and flips NO studio's SMS on. `public.studios.send_*_sms` remains the SMS
-- enablement authority and is untouched here.
--
-- NO CREDENTIALS ARE STORED PER STUDIO, EVER. A studio has no Twilio account
-- and no Twilio login. Hone owns one master account; this table records only
-- RESOURCE IDENTIFIERS (a phone number and two SIDs) that are meaningless
-- without the deployment-global Auth Token. There is deliberately no column
-- that could hold a token, key or secret, and the column-level grants below
-- keep even the resource identifiers off the browser.
--
-- ---------------------------------------------------------------------------
-- THE LOAD-BEARING PROBLEM: ONE OWNER ACTION MUST NOT BUY TWO NUMBERS
-- ---------------------------------------------------------------------------
--
-- A phone number is BILLABLE and RECURRING. The worst ordinary failure is not
-- an error message — it is a double click, a retried POST, or a serverless
-- retry turning one owner action into two rented numbers, silently, forever.
--
-- The hard case is not concurrency. It is this:
--
--     Hone asks Twilio to buy a number.  Twilio buys it.  Hone crashes
--     before it can write the resulting SID down.
--
-- Hone now owns a number it has no record of. A naive retry buys a second one.
-- No amount of database locking prevents that, because the lost write IS the
-- database. The record of the attempt cannot be the only handle on the effect.
--
-- THE ANSWER, AND IT IS THE WHOLE DESIGN: the claim key is minted HERE, is
-- committed BEFORE the billable call, and is then WRITTEN INTO THE PROVIDER
-- RESOURCE ITSELF (as the Twilio FriendlyName). The key therefore exists on
-- BOTH sides of the crash. Reconciliation is a provider lookup by that key:
-- "do I already own a resource carrying claim X?" A purchase happens only when
-- the answer is no. See lib/sms/provisioning.ts for the orchestration.
--
-- Three invariants in this file make that safe, and all three are enforced by
-- the DATABASE rather than by the caller that could be mid-crash:
--
--   1. ONE LIVE SENDER PER STUDIO — a partial unique index over every status
--      except `released`. A second concurrent attempt cannot create a second
--      row to buy against; it collides.
--
--   2. THE CLAIM KEY IS WRITE-ONCE — the transition guard refuses to change or
--      clear a claim key that is already set. This is the invariant that stops
--      the double purchase: a retry CANNOT mint a fresh key, so it can never
--      lose the provider-side handle to what the previous attempt bought. A
--      new key becomes possible only after `released`, which means the old
--      number was genuinely given back.
--
--   3. `error` NEVER RETURNS TO `off` — a failed attempt retries as
--      `provisioning` (same row, same key, reconciled) or is deliberately
--      released. It may not be "reset", because reset is exactly the gesture
--      that abandons a possibly-purchased number and buys another.
--
-- ---------------------------------------------------------------------------
-- ACTIVE IS A PROOF, NOT A SETTING
-- ---------------------------------------------------------------------------
--
-- `status = 'active'` asserts that a specific number was bought, attached to a
-- messaging service, and PROVEN to send. A CHECK constraint holds that: active
-- is unreachable unless the number, both SIDs, the provisioned timestamp and a
-- successful provider test are all present. Incomplete provisioning cannot
-- become active by any writer, including a future definer command, because the
-- constraint does not consult who is writing.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS FILE DOES NOT DO
-- ---------------------------------------------------------------------------
--
--   * No provider call. SQL cannot reach Twilio and nothing here tries.
--   * No `active` row is fabricated. Every studio starts with NO row at all.
--   * No change to any send path, template, cron, webhook or studio toggle.
--   * No suppression / consent column is added, moved or re-scoped. STOP
--     remains phone-wide across studios (see 0049 and the inbound route);
--     per-studio senders must not narrow it, which is proved in
--     tests/lib/sms/suppression.test.ts.
--   * No two-way messaging. Inbound remains opt-out only.
--
-- This migration is ADDITIVE: one new table, its indexes, triggers, policies
-- and four new commands. It alters no existing table, column, function, policy
-- or grant.
-- ===========================================================================

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table if not exists public.studio_sms_senders (
  id uuid primary key default gen_random_uuid(),

  studio_id uuid not null
    references public.studios(id) on delete cascade,

  provider text not null default 'twilio',
  status   text not null default 'off',

  -- What the owner asked for. Recorded so a retry re-searches the same way,
  -- and so a support question ("why did it pick that area code?") is answerable
  -- from the row rather than from a log.
  country             text,
  requested_area_code text,

  -- What the provider actually gave us. Written ONLY from a provider response,
  -- never from request input. See the source guard in
  -- tests/source-guards/sms-provider-guards.test.ts.
  phone_number         text,
  phone_number_sid     text,
  messaging_service_sid text,

  -- The durable claim. Minted by claim_studio_sms_provisioning, committed
  -- before any billable call, and echoed into the provider resource so a lost
  -- finalize can be reconciled instead of re-purchased.
  provisioning_claim_key text,
  provisioning_claim_at  timestamptz,
  provisioning_claim_by_practitioner_id uuid,

  -- THE FENCING TOKEN. Incremented every time an expired lease is taken over.
  -- Reusing the claim key makes a SEQUENTIAL retry safe, but it does not fence
  -- a CONCURRENT one: a worker that merely stalled past its lease resumes
  -- believing it still holds the attempt, and two workers sharing one key both
  -- reconcile to nothing and both purchase. The generation is what a displaced
  -- worker fails to revalidate, so it aborts before spending.
  provisioning_lease_generation integer not null default 1,

  provisioned_at  timestamptz,
  last_test_ok_at timestamptz,

  -- A stable taxonomy tag, never a provider payload and never a message that
  -- could carry a number or a token.
  last_error_code text,
  last_error_at   timestamptz,

  released_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 0179 actor doctrine: attribution is studio-scoped by composite FK, so a
  -- claim can never be attributed to a practitioner from another studio.
  constraint studio_sms_senders_claim_actor_same_studio_fk
    foreign key (provisioning_claim_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict
);

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------

alter table public.studio_sms_senders
  drop constraint if exists studio_sms_senders_provider_check;
alter table public.studio_sms_senders
  add constraint studio_sms_senders_provider_check
  check (provider in ('twilio'));

alter table public.studio_sms_senders
  drop constraint if exists studio_sms_senders_status_check;
alter table public.studio_sms_senders
  add constraint studio_sms_senders_status_check
  check (status in (
    'off', 'selecting', 'provisioning', 'active',
    'suspended', 'error', 'releasing', 'released'
  ));

alter table public.studio_sms_senders
  drop constraint if exists studio_sms_senders_country_check;
alter table public.studio_sms_senders
  add constraint studio_sms_senders_country_check
  check (country is null or country ~ '^[A-Z]{2}$');

alter table public.studio_sms_senders
  drop constraint if exists studio_sms_senders_area_code_check;
alter table public.studio_sms_senders
  add constraint studio_sms_senders_area_code_check
  check (requested_area_code is null or requested_area_code ~ '^[0-9]{2,5}$');

-- E.164, matching the range lib/sms/twilio.ts accepts.
alter table public.studio_sms_senders
  drop constraint if exists studio_sms_senders_phone_number_check;
alter table public.studio_sms_senders
  add constraint studio_sms_senders_phone_number_check
  check (phone_number is null or phone_number ~ '^\+[1-9][0-9]{7,14}$');

-- Provider SID shapes are checked at the DATABASE because fail-closed parsing
-- in one adapter is not a schema guarantee. A browser-supplied or garbled
-- value cannot be stored even if some future writer forgets to validate.
alter table public.studio_sms_senders
  drop constraint if exists studio_sms_senders_phone_number_sid_check;
alter table public.studio_sms_senders
  add constraint studio_sms_senders_phone_number_sid_check
  check (phone_number_sid is null or phone_number_sid ~ '^PN[0-9a-fA-F]{32}$');

alter table public.studio_sms_senders
  drop constraint if exists studio_sms_senders_messaging_service_sid_check;
alter table public.studio_sms_senders
  add constraint studio_sms_senders_messaging_service_sid_check
  check (messaging_service_sid is null or messaging_service_sid ~ '^MG[0-9a-fA-F]{32}$');

alter table public.studio_sms_senders
  drop constraint if exists studio_sms_senders_claim_key_check;
alter table public.studio_sms_senders
  add constraint studio_sms_senders_claim_key_check
  check (provisioning_claim_key is null
         or provisioning_claim_key ~ '^hone-sms-[0-9a-f]{32}$');

-- A claim is evidence or it is nothing: the key, its instant and its actor
-- arrive together or not at all.
alter table public.studio_sms_senders
  drop constraint if exists studio_sms_senders_lease_generation_check;
alter table public.studio_sms_senders
  add constraint studio_sms_senders_lease_generation_check
  check (provisioning_lease_generation >= 1);

alter table public.studio_sms_senders
  drop constraint if exists studio_sms_senders_claim_evidence_check;
alter table public.studio_sms_senders
  add constraint studio_sms_senders_claim_evidence_check
  check (
    (provisioning_claim_key is null
      and provisioning_claim_at is null
      and provisioning_claim_by_practitioner_id is null)
    or
    (provisioning_claim_key is not null
      and provisioning_claim_at is not null
      and provisioning_claim_by_practitioner_id is not null)
  );

-- Any status past `off` is an assertion that a claim was taken.
alter table public.studio_sms_senders
  drop constraint if exists studio_sms_senders_claim_required_check;
alter table public.studio_sms_senders
  add constraint studio_sms_senders_claim_required_check
  check (
    status = 'off'
    or provisioning_claim_key is not null
  );

-- THE READINESS CONSTRAINT. `active` is a proof that a specific number was
-- bought, attached, and observed to send. Incomplete provisioning cannot reach
-- it — not by the orchestration, not by a future definer command, not by the
-- table owner. This is the constraint the mutation control targets.
alter table public.studio_sms_senders
  drop constraint if exists studio_sms_senders_active_readiness_check;
alter table public.studio_sms_senders
  add constraint studio_sms_senders_active_readiness_check
  check (
    status <> 'active'
    or (
      phone_number          is not null
      and phone_number_sid  is not null
      and messaging_service_sid is not null
      and provisioned_at    is not null
      and last_test_ok_at   is not null
    )
  );

alter table public.studio_sms_senders
  drop constraint if exists studio_sms_senders_released_evidence_check;
alter table public.studio_sms_senders
  add constraint studio_sms_senders_released_evidence_check
  check (
    (status = 'released' and released_at is not null)
    or (status <> 'released' and released_at is null)
  );

alter table public.studio_sms_senders
  drop constraint if exists studio_sms_senders_error_evidence_check;
alter table public.studio_sms_senders
  add constraint studio_sms_senders_error_evidence_check
  check (
    (last_error_code is null and last_error_at is null)
    or (last_error_code is not null and last_error_at is not null)
  );

-- The error tag is a taxonomy slug, never a provider message. The shape alone
-- makes it impossible to park a phone number or a token here.
alter table public.studio_sms_senders
  drop constraint if exists studio_sms_senders_error_code_shape_check;
alter table public.studio_sms_senders
  add constraint studio_sms_senders_error_code_shape_check
  check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{2,63}$');

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- INVARIANT 1: at most one live sender per studio. A concurrent second attempt
-- cannot open a second row to buy against; it collides on this index. Only a
-- `released` row (number genuinely given back) leaves the set.
create unique index if not exists studio_sms_senders_one_live_per_studio
  on public.studio_sms_senders (studio_id)
  where status <> 'released';

-- The claim key is globally unique: it is the reconciliation handle echoed
-- into the provider resource, so two rows sharing one would make the provider
-- lookup ambiguous.
create unique index if not exists studio_sms_senders_claim_key_unique
  on public.studio_sms_senders (provisioning_claim_key)
  where provisioning_claim_key is not null;

-- One provider resource belongs to exactly one studio. Two studios cannot end
-- up recorded against the same number or the same messaging service, whatever
-- a caller supplies.
create unique index if not exists studio_sms_senders_phone_number_sid_unique
  on public.studio_sms_senders (phone_number_sid)
  where phone_number_sid is not null;

create unique index if not exists studio_sms_senders_messaging_service_sid_unique
  on public.studio_sms_senders (messaging_service_sid)
  where messaging_service_sid is not null;

create unique index if not exists studio_sms_senders_phone_number_unique
  on public.studio_sms_senders (phone_number)
  where phone_number is not null;

-- ---------------------------------------------------------------------------
-- Server-assigned timestamps
-- ---------------------------------------------------------------------------

create or replace function public.studio_sms_senders_server_timestamps()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  -- Provisioning evidence is dated by the server that observed it. A caller
  -- able to supply created_at could backdate a claim and reorder the record of
  -- who bought what, when.
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists studio_sms_senders_server_timestamps
  on public.studio_sms_senders;
create trigger studio_sms_senders_server_timestamps
  before insert on public.studio_sms_senders
  for each row execute function public.studio_sms_senders_server_timestamps();

drop trigger if exists studio_sms_senders_set_updated_at
  on public.studio_sms_senders;
create trigger studio_sms_senders_set_updated_at
  before update on public.studio_sms_senders
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Transition guard
-- ---------------------------------------------------------------------------

create or replace function public.studio_sms_senders_transition_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.id is distinct from old.id
     or new.studio_id is distinct from old.studio_id
     or new.provider is distinct from old.provider
     or new.created_at is distinct from old.created_at then
    raise exception
      'studio_sms_senders: id, studio_id, provider and created_at are immutable'
      using errcode = 'check_violation';
  end if;

  -- INVARIANT 2, AND THE REASON THIS FILE EXISTS. Once a claim key is set it
  -- can never change or be cleared. A retry after a lost finalize therefore
  -- CANNOT mint a fresh key, so it can never lose the handle on a resource the
  -- previous attempt may already have purchased. Minting a second key is
  -- precisely the gesture that buys a second billable number.
  if old.provisioning_claim_key is not null
     and new.provisioning_claim_key is distinct from old.provisioning_claim_key then
    raise exception
      'studio_sms_senders: the provisioning claim key is write-once; a retry must reuse it so an already-purchased number is reconciled rather than re-bought'
      using errcode = 'check_violation';
  end if;

  -- The claim INSTANT is a liveness LEASE, not evidence, and is the one part of
  -- the claim that may move -- forward only, when a stale attempt is taken
  -- over. Splitting it from the key is deliberate: the KEY is the identity of
  -- the attempt and must never change, or reconciliation loses the handle on a
  -- purchased number; the LEASE is "someone is working on this right now" and
  -- has to be refreshable or a crashed attempt would wedge the studio forever.
  if old.provisioning_claim_at is not null
     and new.provisioning_claim_at < old.provisioning_claim_at then
    raise exception
      'studio_sms_senders: the provisioning lease moves forward only; backdating it would let a stale attempt masquerade as live'
      using errcode = 'check_violation';
  end if;

  -- A generation that could go backwards would hand a displaced worker its
  -- fence back, which is the entire failure this token exists to close.
  if new.provisioning_lease_generation < old.provisioning_lease_generation then
    raise exception
      'studio_sms_senders: the lease generation is monotonic; rewinding it would re-arm a worker that was already displaced'
      using errcode = 'check_violation';
  end if;

  if old.provisioning_claim_by_practitioner_id is not null
     and new.provisioning_claim_by_practitioner_id
         is distinct from old.provisioning_claim_by_practitioner_id then
    raise exception
      'studio_sms_senders: the owner who opened an attempt is recorded once and is not rewritten by a later retry'
      using errcode = 'check_violation';
  end if;

  -- Provider resource identifiers are write-once too. Overwriting a SID would
  -- orphan the resource it named -- Hone would keep paying for a number it no
  -- longer has any record of.
  if old.phone_number_sid is not null
     and new.phone_number_sid is distinct from old.phone_number_sid then
    raise exception
      'studio_sms_senders: phone_number_sid is write-once; overwriting it orphans a rented number'
      using errcode = 'check_violation';
  end if;

  if old.messaging_service_sid is not null
     and new.messaging_service_sid is distinct from old.messaging_service_sid then
    raise exception
      'studio_sms_senders: messaging_service_sid is write-once; overwriting it orphans a provider resource'
      using errcode = 'check_violation';
  end if;

  if old.phone_number is not null
     and new.phone_number is distinct from old.phone_number then
    raise exception
      'studio_sms_senders: phone_number is write-once for the life of a sender row; a replacement number is a new row after release'
      using errcode = 'check_violation';
  end if;

  if old.provisioned_at is not null
     and new.provisioned_at is distinct from old.provisioned_at then
    raise exception
      'studio_sms_senders: provisioned_at is recorded once'
      using errcode = 'check_violation';
  end if;

  -- Legal transitions. INVARIANT 3 lives here: `error` may retry or release,
  -- but it may NEVER return to `off`. "Reset and start over" is the gesture
  -- that abandons a possibly-purchased number and buys another one.
  if new.status is distinct from old.status then
    if not (
      (old.status = 'off'          and new.status in ('selecting', 'provisioning', 'error'))
      or (old.status = 'selecting'   and new.status in ('provisioning', 'off', 'error'))
      or (old.status = 'provisioning' and new.status in ('active', 'error', 'releasing'))
      or (old.status = 'active'      and new.status in ('suspended', 'releasing'))
      or (old.status = 'suspended'   and new.status in ('active', 'releasing'))
      or (old.status = 'error'       and new.status in ('provisioning', 'releasing'))
      or (old.status = 'releasing'   and new.status in ('released', 'error'))
    ) then
      raise exception
        'studio_sms_senders: illegal sender transition % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;
  end if;

  if old.status = 'released' then
    raise exception
      'studio_sms_senders: a released sender is history and is never rewritten'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists studio_sms_senders_transition_guard
  on public.studio_sms_senders;
create trigger studio_sms_senders_transition_guard
  before update on public.studio_sms_senders
  for each row execute function public.studio_sms_senders_transition_guard();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.studio_sms_senders enable row level security;

drop policy if exists "studio_sms_senders_owner_select"
  on public.studio_sms_senders;
create policy "studio_sms_senders_owner_select"
  on public.studio_sms_senders for select to authenticated
  using (public.is_studio_owner(studio_sms_senders.studio_id));

-- ---------------------------------------------------------------------------
-- Command: acquire the provisioning claim
-- ---------------------------------------------------------------------------
--
-- THE COMMIT POINT FOR AN ATTEMPT. Everything billable happens after this
-- returns and only under the key it returns.
--
-- Authorization is RE-DERIVED here from (studio_id, authenticated user id).
-- The caller never supplies a role, a practitioner id, or a studio it merely
-- claims to belong to. This is the 0185 command posture.
--
-- Concurrency: the studio's live row is taken FOR UPDATE, so two requests
-- serialize. The second one does NOT get a second claim -- it gets the SAME
-- claim key back with result `claim_held`, which is what makes a double click,
-- a second browser tab, and a network retry all converge on one purchase.
create or replace function public.claim_studio_sms_provisioning(
  p_studio_id          uuid,
  p_actor_user_id      uuid,
  p_country            text,
  p_requested_area_code text
)
returns table (
  result      text,
  sender_id   uuid,
  claim_key   text,
  sender_status text,
  lease_generation integer
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  -- How long one attempt may hold the studio before another may take it over.
  -- Long enough to cover a full provisioning round trip (search re-check,
  -- purchase, service creation, three configuration calls and a test send, each
  -- bounded at 15s by the adapter); short enough that a crash does not wedge
  -- the studio for an operator-visible age. Mirrors the 0049 stale-claim
  -- pattern, with a window sized for a slower, billable sequence.
  c_claim_lease constant interval := interval '5 minutes';
  v_practitioner_id uuid;
  v_role            text;
  v_country         text := upper(nullif(btrim(coalesce(p_country, '')), ''));
  v_area            text := nullif(btrim(coalesce(p_requested_area_code, '')), '');
  v_row             public.studio_sms_senders%rowtype;
  v_key             text;
begin
  if p_studio_id is null or p_actor_user_id is null then
    return query select 'invalid_input'::text, null::uuid, null::text, null::text, null::integer;
    return;
  end if;

  if v_country is null or v_country !~ '^[A-Z]{2}$'
     or (v_area is not null and v_area !~ '^[0-9]{2,5}$') then
    return query select 'invalid_input'::text, null::uuid, null::text, null::text, null::integer;
    return;
  end if;

  if not exists (select 1 from public.studios s where s.id = p_studio_id) then
    return query select 'studio_not_found'::text, null::uuid, null::text, null::text, null::integer;
    return;
  end if;

  select p.id, p.role
    into v_practitioner_id, v_role
    from public.practitioners p
   where p.studio_id = p_studio_id
     and p.user_id   = p_actor_user_id
     and p.active    = true
   limit 1;

  if v_practitioner_id is null then
    return query select 'not_a_member'::text, null::uuid, null::text, null::text, null::integer;
    return;
  end if;
  if v_role <> 'owner' then
    return query select 'not_owner'::text, null::uuid, null::text, null::text, null::integer;
    return;
  end if;

  -- The studio mutex. One live row per studio is enforced by index; this lock
  -- makes concurrent claimants queue rather than race into it.
  select *
    into v_row
    from public.studio_sms_senders s
   where s.studio_id = p_studio_id
     and s.status <> 'released'
   for update;

  if v_row.id is null then
    -- FIRST-EVER CLAIM FOR THIS STUDIO, AND THE ONE CASE `for update` CANNOT
    -- SERIALIZE. There is no row yet, so there is nothing to lock: two
    -- simultaneous first submits both read nothing and both reach this INSERT.
    -- Measured, not theorised -- before `on conflict` was added here, the
    -- loser received a raw `duplicate key value violates unique constraint
    -- "studio_sms_senders_one_live_per_studio"` instead of a result word. That
    -- is exactly the double-click-a-brand-new-studio case this whole design
    -- exists for. No number was ever bought twice (the loser aborts long before
    -- any provider effect), but a caller must get an answer, not an exception.
    --
    -- Same idiom as 0185's join_new_client_waitlist: insert, and on conflict
    -- re-read the winner and answer from it. `on conflict do nothing` also
    -- BLOCKS on a concurrent uncommitted insert until it commits, so the
    -- re-read below always sees the winning row rather than a phantom.
    v_key := 'hone-sms-' || replace(gen_random_uuid()::text, '-', '');
    insert into public.studio_sms_senders (
      studio_id, provider, status, country, requested_area_code,
      provisioning_claim_key, provisioning_claim_at,
      provisioning_claim_by_practitioner_id
    ) values (
      p_studio_id, 'twilio', 'provisioning', v_country, v_area,
      v_key, clock_timestamp(), v_practitioner_id
    )
    on conflict do nothing
    returning * into v_row;

    if v_row.id is not null then
      return query select 'claimed'::text, v_row.id, v_row.provisioning_claim_key,
                          v_row.status, v_row.provisioning_lease_generation;
      return;
    end if;

    -- Lost the race. Re-read the winner and fall through to the ordinary
    -- existing-row logic below, which turns this caller away as `claim_held`.
    select *
      into v_row
      from public.studio_sms_senders s
     where s.studio_id = p_studio_id
       and s.status <> 'released'
     for update;

    if v_row.id is null then
      return query select 'not_claimable'::text, null::uuid, null::text, null::text, null::integer;
      return;
    end if;
  end if;

  if v_row.status = 'active' then
    return query select 'already_active'::text, v_row.id, v_row.provisioning_claim_key,
                        v_row.status, v_row.provisioning_lease_generation;
    return;
  end if;

  if v_row.status = 'provisioning' then
    -- THE DOUBLE-SUBMIT ANSWER, AND IT IS AN EXCLUSION, NOT A SHARED KEY.
    --
    -- Handing a second concurrent request the same key is not enough: both
    -- would then reconcile (finding nothing yet, because neither has bought)
    -- and both would purchase. The claim has to EXCLUDE, so a live attempt
    -- turns the second request away and it performs no provider effect at all.
    -- clock_timestamp(), NOT now(). `now()` is fixed at TRANSACTION start, so a
    -- claim that waited on the FOR UPDATE lock above evaluates expiry against a
    -- reading from before the wait -- and, worse, would REFRESH the lease to
    -- that same stale instant, handing back a lease that is already expired the
    -- moment the RPC returns.
    if v_row.provisioning_claim_at > clock_timestamp() - c_claim_lease then
      return query select 'claim_held'::text, v_row.id, null::text, v_row.status, null::integer;
      return;
    end if;

    -- The lease has expired: the previous attempt crashed between its claim and
    -- its finalize. Take it over ON THE SAME KEY -- which the transition guard
    -- would enforce anyway -- so this attempt's first act is to discover
    -- whatever the crashed one may already have purchased.
    update public.studio_sms_senders
       set provisioning_claim_at         = clock_timestamp(),
           provisioning_lease_generation = v_row.provisioning_lease_generation + 1
     where id = v_row.id
    returning * into v_row;

    return query select 'claimed'::text, v_row.id, v_row.provisioning_claim_key,
                        v_row.status, v_row.provisioning_lease_generation;
    return;
  end if;

  if v_row.status in ('off', 'selecting', 'error') then
    -- A retry. The key is REUSED, never reminted (the transition guard would
    -- refuse anyway). Country and area code may be re-stated but the identity
    -- of the attempt does not move.
    update public.studio_sms_senders
       set status                        = 'provisioning',
           country                       = v_country,
           requested_area_code           = v_area,
           provisioning_claim_at         = clock_timestamp(),
           provisioning_lease_generation = v_row.provisioning_lease_generation + 1
     where id = v_row.id
    returning * into v_row;

    return query select 'claimed'::text, v_row.id, v_row.provisioning_claim_key,
                        v_row.status, v_row.provisioning_lease_generation;
    return;
  end if;

  -- suspended / releasing: a deliberate operator state. Provisioning does not
  -- silently reopen it.
  return query select 'not_claimable'::text, v_row.id, null::text, v_row.status, null::integer;
end;
$$;

-- ---------------------------------------------------------------------------
-- Command: finalize an attempt with the provider resources it produced
-- ---------------------------------------------------------------------------
--
-- Addressed by (studio_id, claim_key) TOGETHER. The claim key alone would let
-- a caller holding one studio's key write against a row it does not own; the
-- studio alone would let a stale attempt finalize over a newer one.
--
-- `active` is reached ONLY with p_test_ok = true. Without proof the row stays
-- in `provisioning` with its identifiers recorded, which is exactly the state
-- reconciliation needs: the resources are known, the sender is not live.
create or replace function public.finalize_studio_sms_provisioning(
  p_studio_id            uuid,
  p_claim_key            text,
  p_lease_generation     integer,
  p_phone_number         text,
  p_phone_number_sid     text,
  p_messaging_service_sid text,
  p_test_ok              boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.studio_sms_senders%rowtype;
begin
  if p_studio_id is null
     or p_claim_key is null
     or p_phone_number is null
     or p_phone_number_sid is null
     or p_messaging_service_sid is null then
    return 'invalid_input';
  end if;

  select *
    into v_row
    from public.studio_sms_senders s
   where s.studio_id              = p_studio_id
     and s.provisioning_claim_key = p_claim_key
     and s.status <> 'released'
   for update;

  if v_row.id is null then
    return 'claim_not_found';
  end if;

  -- FENCING. A worker whose lease was taken over must not write. Its purchase
  -- (if any) stays discoverable under the shared claim key and the CURRENT
  -- holder adopts it; what must not happen is the displaced worker recording
  -- ITS resources over the live attempt's.
  if p_lease_generation is not null
     and v_row.provisioning_lease_generation <> p_lease_generation then
    return 'lease_lost';
  end if;

  if v_row.status = 'active' then
    -- Idempotent replay. Identical resources are a benign retry; DIFFERENT
    -- resources mean two purchases reached one row, which must be surfaced,
    -- never silently overwritten (the guard would refuse the write anyway).
    if v_row.phone_number_sid = p_phone_number_sid
       and v_row.messaging_service_sid = p_messaging_service_sid
       and v_row.phone_number = p_phone_number then
      return 'already_active';
    end if;
    return 'conflict';
  end if;

  if v_row.status <> 'provisioning' then
    return 'not_provisioning';
  end if;

  -- Replay against a row already carrying identifiers: accept only the SAME
  -- ones. This is the reconciliation landing point after a lost finalize.
  if v_row.phone_number_sid is not null
     and (v_row.phone_number_sid <> p_phone_number_sid
          or v_row.messaging_service_sid is distinct from p_messaging_service_sid
          or v_row.phone_number is distinct from p_phone_number) then
    return 'conflict';
  end if;

  -- A provider resource belongs to exactly one studio, enforced by three unique
  -- indexes. Reaching one here means this attempt is trying to record a number
  -- or a service ANOTHER studio already owns -- a genuine conflict an operator
  -- must look at, and never something to overwrite. Caught and named rather
  -- than raised: a caller receiving a bare 23505 would have to parse a Postgres
  -- message to tell this apart from any other failure.
  begin
    update public.studio_sms_senders
       set phone_number          = coalesce(v_row.phone_number, p_phone_number),
           phone_number_sid      = coalesce(v_row.phone_number_sid, p_phone_number_sid),
           messaging_service_sid = coalesce(v_row.messaging_service_sid, p_messaging_service_sid),
           provisioned_at        = coalesce(v_row.provisioned_at, now()),
           last_test_ok_at       = case when p_test_ok is true then now() else v_row.last_test_ok_at end,
           status                = case
                                     when p_test_ok is true then 'active'
                                     else 'provisioning'
                                   end,
           last_error_code       = case when p_test_ok is true then null else v_row.last_error_code end,
           last_error_at         = case when p_test_ok is true then null else v_row.last_error_at end
     where id = v_row.id;
  exception when unique_violation then
    return 'conflict';
  end;

  if p_test_ok is true then
    return 'activated';
  end if;
  return 'provisioned_untested';
end;
$$;

-- ---------------------------------------------------------------------------
-- Command: record a failed attempt WITHOUT surrendering the claim
-- ---------------------------------------------------------------------------
--
-- The claim key survives deliberately. `error` is a resting place a retry can
-- reconcile from, not a reset. Anything already purchased under this key stays
-- discoverable.
create or replace function public.fail_studio_sms_provisioning(
  p_studio_id      uuid,
  p_claim_key      text,
  p_lease_generation integer,
  p_error_code     text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row  public.studio_sms_senders%rowtype;
  v_code text := lower(btrim(coalesce(p_error_code, '')));
begin
  if p_studio_id is null or p_claim_key is null then
    return 'invalid_input';
  end if;
  -- Shape-gated so a provider message, a phone number or a token can never be
  -- parked in this column by a careless caller.
  if v_code !~ '^[a-z][a-z0-9_]{2,63}$' then
    v_code := 'provider_error_unspecified';
  end if;

  select *
    into v_row
    from public.studio_sms_senders s
   where s.studio_id              = p_studio_id
     and s.provisioning_claim_key = p_claim_key
     and s.status <> 'released'
   for update;

  if v_row.id is null then
    return 'claim_not_found';
  end if;
  -- A displaced worker does not get to park the live attempt in `error`.
  if p_lease_generation is not null
     and v_row.provisioning_lease_generation <> p_lease_generation then
    return 'lease_lost';
  end if;
  if v_row.status = 'active' then
    return 'already_active';
  end if;
  if v_row.status <> 'provisioning' then
    return 'not_provisioning';
  end if;

  update public.studio_sms_senders
     set status          = 'error',
         last_error_code = v_code,
         last_error_at   = now()
   where id = v_row.id;

  return 'failed';
end;
$$;

-- ---------------------------------------------------------------------------
-- Command: revalidate the fence, immediately before spending money
-- ---------------------------------------------------------------------------
--
-- THE LAST THING A WORKER DOES BEFORE A BILLABLE CALL.
--
-- Reusing the claim key across a takeover makes a SEQUENTIAL retry safe: the
-- new worker reconciles against what the old one bought. It does NOT fence a
-- CONCURRENT one. A worker that merely STALLED past its five-minute lease --
-- not crashed, just slow, paused, or wedged on a socket -- resumes believing it
-- still owns the attempt. Both workers then hold the same key, both reconcile
-- while neither purchase is visible yet, and both buy. That is the original
-- catastrophe, reintroduced by the very mechanism that recovers from crashes.
--
-- The lease generation is the fence. It advances on every takeover, so the
-- displaced worker's copy is stale and this returns false, and it aborts
-- WITHOUT spending.
--
-- HONEST LIMIT, STATED RATHER THAN IMPLIED: this narrows the window, it does
-- not close it. A takeover landing between this check and the provider call
-- still races, because Twilio's number-purchase API accepts no idempotency key
-- for Hone to bind the effect to. What remains is a few milliseconds rather
-- than the whole provisioning sequence, and the claim-key FriendlyName still
-- makes the aftermath DISCOVERABLE -- lookupResourcesByClaim refuses to choose
-- when it finds two, so the condition surfaces to an operator instead of being
-- silently absorbed.
create or replace function public.assert_studio_sms_lease(
  p_studio_id        uuid,
  p_claim_key        text,
  p_lease_generation integer
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
      from public.studio_sms_senders s
     where s.studio_id                     = p_studio_id
       and s.provisioning_claim_key        = p_claim_key
       and s.provisioning_lease_generation = p_lease_generation
       and s.status                        = 'provisioning'
  );
$$;

-- ---------------------------------------------------------------------------
-- Command: resolve an inbound provider callback to exactly one studio
-- ---------------------------------------------------------------------------
--
-- Twilio tells us WHICH of our resources received a message. That is a
-- stronger key than anything in the payload a sender controls, so callback
-- attribution is a unique-index lookup here rather than a scan over tenant
-- state. Returns null when the SID is not one of ours, which the caller must
-- treat as "not attributable", never as "any studio".
create or replace function public.resolve_studio_by_sms_messaging_service(
  p_messaging_service_sid text
)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select s.studio_id
    from public.studio_sms_senders s
   where s.messaging_service_sid = p_messaging_service_sid
     and s.status in ('active', 'suspended')
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated
-- AND service_role at function-create time. Every one is revoked BY NAME
-- before anything is granted -- the 0129 (`anon`) and 0164 (`service_role`)
-- failure class.

revoke all on public.studio_sms_senders
  from public, anon, authenticated, service_role;

-- COLUMN-LEVEL grant, deliberately. An owner may see the STATE of their own
-- sender; nobody reaches provider resource identifiers or the claim key
-- through a browser session. Those columns are readable only by the definer
-- commands above, so a Twilio SID can never become something the browser
-- knows -- and therefore never something it can echo back as authority.
grant select (
  id, studio_id, provider, status, country, requested_area_code,
  phone_number, provisioned_at, last_test_ok_at,
  last_error_code, last_error_at, released_at, created_at, updated_at
) on public.studio_sms_senders to authenticated;

revoke execute on function public.claim_studio_sms_provisioning(uuid, uuid, text, text) from public;
revoke execute on function public.claim_studio_sms_provisioning(uuid, uuid, text, text) from anon;
revoke execute on function public.claim_studio_sms_provisioning(uuid, uuid, text, text) from authenticated;
revoke execute on function public.claim_studio_sms_provisioning(uuid, uuid, text, text) from service_role;

revoke execute on function public.finalize_studio_sms_provisioning(uuid, text, integer, text, text, text, boolean) from public;
revoke execute on function public.finalize_studio_sms_provisioning(uuid, text, integer, text, text, text, boolean) from anon;
revoke execute on function public.finalize_studio_sms_provisioning(uuid, text, integer, text, text, text, boolean) from authenticated;
revoke execute on function public.finalize_studio_sms_provisioning(uuid, text, integer, text, text, text, boolean) from service_role;

revoke execute on function public.fail_studio_sms_provisioning(uuid, text, integer, text) from public;
revoke execute on function public.fail_studio_sms_provisioning(uuid, text, integer, text) from anon;
revoke execute on function public.fail_studio_sms_provisioning(uuid, text, integer, text) from authenticated;
revoke execute on function public.fail_studio_sms_provisioning(uuid, text, integer, text) from service_role;

revoke execute on function public.resolve_studio_by_sms_messaging_service(text) from public;
revoke execute on function public.resolve_studio_by_sms_messaging_service(text) from anon;
revoke execute on function public.resolve_studio_by_sms_messaging_service(text) from authenticated;
revoke execute on function public.resolve_studio_by_sms_messaging_service(text) from service_role;

grant execute on function public.claim_studio_sms_provisioning(uuid, uuid, text, text) to service_role;
grant execute on function public.finalize_studio_sms_provisioning(uuid, text, integer, text, text, text, boolean) to service_role;
grant execute on function public.fail_studio_sms_provisioning(uuid, text, integer, text) to service_role;
grant execute on function public.resolve_studio_by_sms_messaging_service(text) to service_role;

revoke execute on function public.assert_studio_sms_lease(uuid, text, integer) from public;
revoke execute on function public.assert_studio_sms_lease(uuid, text, integer) from anon;
revoke execute on function public.assert_studio_sms_lease(uuid, text, integer) from authenticated;
revoke execute on function public.assert_studio_sms_lease(uuid, text, integer) from service_role;
grant execute on function public.assert_studio_sms_lease(uuid, text, integer) to service_role;

revoke all privileges on function public.studio_sms_senders_server_timestamps()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.studio_sms_senders_transition_guard()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Documentation
-- ---------------------------------------------------------------------------

comment on table public.studio_sms_senders is
  'PER-STUDIO SMS SENDER IDENTITY and the durable claim that makes buying one safe (COMMS-01B). One row per studio records the provider resources Hone owns ON THAT STUDIO''S BEHALF inside Hone''s single master Twilio account. NO CREDENTIALS ARE STORED PER STUDIO and no column here could hold one: a studio has no Twilio account, and these identifiers are inert without the deployment-global Auth Token. This table grants no sending capability -- public.studios.send_*_sms remains the SMS enablement authority and is untouched. `active` is a PROOF, not a setting: the readiness CHECK makes it unreachable without both SIDs, the number, a provisioned instant and a successful provider test.';

comment on column public.studio_sms_senders.status is
  'off | selecting | provisioning | active | suspended | error | releasing | released. Enforced by the transition guard. `error` may retry (-> provisioning, same claim) or release (-> releasing); it may NEVER return to `off`, because "reset and start over" is exactly the gesture that abandons a possibly-purchased number and buys a second billable one. `released` is terminal history and is never rewritten.';

comment on column public.studio_sms_senders.provisioning_claim_key is
  'THE IDEMPOTENCY IDENTITY OF ONE PROVISIONING ATTEMPT. Minted server-side, committed BEFORE any billable provider call, and echoed into the provider resource itself (Twilio FriendlyName) so it exists on BOTH sides of a crash. Reconciliation is a provider lookup by this key: a purchase happens only when the provider reports nothing carrying it. WRITE-ONCE by trigger -- a retry cannot mint a fresh key, so it can never lose the handle on what a previous attempt already bought. That single property is what makes "one owner action, at most one billable number" structural rather than best-effort.';

comment on column public.studio_sms_senders.provisioning_claim_by_practitioner_id is
  'The OWNER whose action opened this attempt, verified inside claim_studio_sms_provisioning from (studio_id, authenticated user id) -- never supplied by the caller. Studio-scoped by composite FK per the 0179 actor doctrine, so a claim cannot be attributed to a practitioner from another studio. Recorded once, with the claim.';

comment on column public.studio_sms_senders.phone_number_sid is
  'Twilio IncomingPhoneNumber SID, written ONLY from a provider response and never from request input. Write-once: overwriting it orphans a rented number Hone keeps paying for. Not readable through the browser -- the authenticated grant is column-level and excludes it, so a Twilio SID never becomes something a client session knows and could echo back as authority.';

comment on column public.studio_sms_senders.messaging_service_sid is
  'Twilio Messaging Service SID. Also the CALLBACK ATTRIBUTION KEY: resolve_studio_by_sms_messaging_service turns an inbound provider callback into exactly one studio through this column''s unique index, rather than scanning tenant state. Write-once, provider-sourced, and excluded from the browser grant.';

comment on column public.studio_sms_senders.last_error_code is
  'A stable taxonomy slug from the adapter''s error vocabulary -- never a provider message, payload or phone number. The shape CHECK (lowercase slug, 3-64 chars) makes it structurally impossible to park a number or a token here.';

comment on function public.claim_studio_sms_provisioning(uuid, uuid, text, text) is
  'Acquire the durable provisioning claim. THE COMMIT POINT of an attempt: everything billable happens after this returns, under the key it returns. Re-derives studio membership AND owner role from (studio_id, actor user id); the caller never supplies a role. Takes the studio''s live row FOR UPDATE, so concurrent requests serialize. A live attempt EXCLUDES the second request: it is turned away as `claim_held` with no key and performs no provider effect, which is what makes a double click, a second tab and a network retry produce ONE purchase. Sharing the key instead would let both reconcile (finding nothing, since neither has bought yet) and both purchase. A claim whose 5-minute lease has expired is taken over ON THE SAME KEY, so the taking-over attempt discovers whatever the crashed one bought, and the lease GENERATION advances so the displaced worker is fenced out by assert_studio_sms_lease before it can spend. Expiry is evaluated against clock_timestamp(), not now(): a claim that waited on the row lock would otherwise judge -- and refresh -- the lease against a reading from before the wait. The FIRST-EVER claim for a studio is the one case the row lock cannot serialize -- there is no row to lock -- so the insert carries `on conflict do nothing` and the loser re-reads the winner and is answered `claim_held`; without it the loser received a raw duplicate-key exception instead of a result word. Returns claimed | claim_held | already_active | not_claimable | not_a_member | not_owner | studio_not_found | invalid_input. service_role only.';

comment on function public.finalize_studio_sms_provisioning(uuid, text, integer, text, text, text, boolean) is
  'Record the provider resources an attempt produced, addressed by (studio_id, claim_key) together. Reaches `active` ONLY with p_test_ok = true; without proof the row keeps its identifiers and stays in `provisioning`, which is precisely the state reconciliation needs. Replaying identical resources is benign (`already_active`); DIFFERENT resources against the same claim return `conflict` and are never silently overwritten. A provider resource already recorded against ANOTHER studio raises a unique violation, which is caught and returned as `conflict` rather than propagating a bare 23505. A worker whose lease was taken over is refused with `lease_lost` rather than allowed to record its resources over the live attempt''s. Returns activated | provisioned_untested | already_active | conflict | lease_lost | claim_not_found | not_provisioning | invalid_input. service_role only.';

comment on function public.fail_studio_sms_provisioning(uuid, text, integer, text) is
  'Park a failed attempt in `error` WITHOUT surrendering the claim key, so anything already purchased under it stays discoverable by reconciliation. Coerces any non-conforming error tag to `provider_error_unspecified` rather than storing it. A displaced worker is refused with `lease_lost` and does not get to park the live attempt in `error`. Returns failed | lease_lost | already_active | not_provisioning | claim_not_found | invalid_input. service_role only.';

comment on column public.studio_sms_senders.provisioning_lease_generation is
  'THE FENCING TOKEN, and the answer to a defect the claim key alone does not close. Reusing the key across a stale-lease takeover makes a SEQUENTIAL retry safe -- the new worker reconciles against what the old one bought -- but it does not fence a CONCURRENT one: a worker that merely STALLED past its lease (not crashed; slow, paused, or wedged on a socket) resumes believing it still owns the attempt, and two workers holding one key both reconcile while neither purchase is visible and both buy. This integer advances on every takeover, so the displaced worker fails assert_studio_sms_lease and aborts BEFORE spending. Monotonic by trigger: rewinding it would re-arm a worker that was already displaced.';

comment on function public.assert_studio_sms_lease(uuid, text, integer) is
  'Revalidate the fence immediately before a billable provider call; false means this worker was displaced and must not spend. Narrows the double-purchase window from the whole provisioning sequence to the gap between this check and the provider call -- it does NOT close it, because Twilio''s number-purchase API accepts no idempotency key to bind the effect to. The claim-key FriendlyName still makes the residue discoverable: lookupResourcesByClaim refuses to choose when it finds two, so the condition reaches an operator rather than being absorbed. service_role only.';

comment on function public.resolve_studio_by_sms_messaging_service(text) is
  'Resolve an inbound provider callback to exactly one studio via the messaging-service unique index -- a stronger key than any sender-controlled payload field, and no scan over tenant state. Returns null when the SID is not one of ours; the caller must treat that as "not attributable", never as "any studio". service_role only.';

commit;
