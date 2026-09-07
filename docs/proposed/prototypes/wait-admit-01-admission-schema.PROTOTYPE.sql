-- ===========================================================================
-- WAIT-ADMIT-01 — ADMISSION INTELLIGENCE SCHEMA (PROTOTYPE — NOT A MIGRATION)
-- ===========================================================================
--
-- NO MIGRATION NUMBER IS CLAIMED. This file deliberately lives outside
-- supabase/migrations/ and carries no NNNN_ prefix, so `npm run migration:state`
-- does not see it and no slot is reserved. Claiming a number here would collide
-- with whichever lane actually lands next; the number is assigned when the slot
-- is authorised, not when the DDL is drafted.
--
-- Same discipline WAIT-03B/B2 already uses for its own unlanded SQL
-- (docs/proposed/prototypes/wait03b-*.PROTOTYPE.sql).
--
-- WHAT THIS UNBLOCKS, and nothing else:
--   req 1  structured prospect availability (WEEKDAYS / WEEKENDS / BOTH)
--   req 2  practitioner-created entries (phone, walk-in, referral)
--   req 3  truthful legacy import of email-only prospects
--   req 4  storage for a secure preference-update flow
--   req 5  per-studio ranking policy persistence
--   req 6  executing a ranked "invite next N" rather than a FIFO one
--
-- The ranking engine, explanation model, validation and import parsing are
-- ALREADY BUILT and need none of this to be correct — see lib/waitlist/*. They
-- read absent columns as "not stated" and degrade to exactly today's FIFO
-- order, which is why the code can ship before this does.
-- ===========================================================================

begin;

-- A migration file is not wrapped in a transaction by `supabase db push`, so
-- the BEGIN above is this change's own. `SET LOCAL` outside a transaction
-- raises 25P01 and never arms, which is why it comes after.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. PROSPECT AVAILABILITY  (req 1)
-- ---------------------------------------------------------------------------
--
-- NULLABLE, AND IT MUST STAY NULLABLE FOREVER. NULL means NOT STATED, which is
-- the true description of all 17 currently-waiting prospects and of every
-- legacy import. A NOT NULL column with a default would assert an answer for
-- people nobody has asked, and the ranking engine weights this factor.
alter table public.new_client_waitlist_entries
  add column if not exists availability_preference text,
  add column if not exists availability_stated_at  timestamptz;

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_availability_preference_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_availability_preference_check
  check (
    availability_preference is null
    or availability_preference in ('weekdays', 'weekends', 'both')
  );

-- A PREFERENCE WITHOUT A STAMP IS INDISTINGUISHABLE FROM A DEFAULT. Pairing
-- them makes "when did they tell us this?" answerable for every stated value,
-- which is what lets a stale preference be re-confirmed rather than trusted
-- indefinitely.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_availability_pairing_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_availability_pairing_check
  check (
    (availability_preference is null     and availability_stated_at is null)
    or
    (availability_preference is not null and availability_stated_at is not null)
  );

-- ---------------------------------------------------------------------------
-- 2. ORIGIN AND JOIN-DATE PROVENANCE  (req 2, req 3)
-- ---------------------------------------------------------------------------
--
-- `source` is currently CHECK (source = 'public_booking') — a SINGLE-VALUED
-- constraint. It is the one line that makes both a practitioner-created entry
-- and a legacy import structurally impossible today.
--
-- THE DEFAULT 'form' DOES NOT FABRICATE ANYTHING, and the existing constraint
-- is the proof: every row in the table today satisfies source = 'public_booking',
-- so every row demonstrably arrived through the public form. 'form' is a
-- verified fact about the existing 18 rows, not an assumption about them.
alter table public.new_client_waitlist_entries
  add column if not exists joined_at_provenance       text not null default 'form',
  add column if not exists created_by_practitioner_id uuid;

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_source_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_source_check
  check (source in ('public_booking', 'practitioner', 'legacy_import'));

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_joined_at_provenance_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_joined_at_provenance_check
  check (joined_at_provenance in ('form', 'operator_supplied', 'unknown'));

-- THE FORM IS THE ONLY THING THAT CAN CLAIM 'form'. Without this, an import
-- could write joined_at_provenance = 'form' and the column would stop meaning
-- anything — a weaker, human-asserted date would be indistinguishable from the
-- form's own timestamp, which is the exact confusion the column exists to
-- prevent.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_provenance_source_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_provenance_source_check
  check (
    (source = 'public_booking' and joined_at_provenance = 'form')
    or
    (source <> 'public_booking' and joined_at_provenance in ('operator_supplied', 'unknown'))
  );

-- An operator-originated entry NAMES the operator; a public one must not.
-- Same composite same-studio FK shape the table's three existing actor columns
-- already use, so a practitioner from another studio cannot be referenced.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_created_by_same_studio_fk;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_created_by_same_studio_fk
  foreign key (created_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id) on delete restrict;

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_created_by_evidence_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_created_by_evidence_check
  check (
    (source = 'public_booking' and created_by_practitioner_id is null)
    or
    (source <> 'public_booking' and created_by_practitioner_id is not null)
  );

-- NOTE ON `name`. new_client_waitlist_entries_name_check requires
-- length(btrim(name)) >= 1, so an email-only legacy row cannot be stored
-- without a name. This prototype does NOT relax that constraint: relaxing it
-- would let a nameless row exist in the field a practitioner reads before
-- contacting a stranger. lib/waitlist/legacy-import.ts therefore returns such
-- rows as `needs_decision` and the operator supplies the name. If that proves
-- unworkable at volume, the correct change is a separate, explicit
-- `name_provenance` column — not a weaker name check.

-- ---------------------------------------------------------------------------
-- 3. PER-STUDIO RANKING POLICY  (req 5)
-- ---------------------------------------------------------------------------
--
-- NULL = no policy configured = FIFO_POLICY = today's exact queue order, so
-- adding this column changes no studio's behaviour on the day it lands.
-- Shape and every parse rule are already defined and tested in
-- lib/waitlist/policy.ts; jsonb is storage, never a type.
alter table public.studios
  add column if not exists waitlist_ranking_policy jsonb;

-- ---------------------------------------------------------------------------
-- 4. PREFERENCE-UPDATE GRANTS  (req 4)
-- ---------------------------------------------------------------------------
--
-- A SEPARATE TABLE FROM new_client_waitlist_invitations, deliberately. That
-- table's lifecycle drags an entry through claimed -> invited (its
-- cycle-evidence CHECK requires claimed_at, claimed_by_practitioner_id and
-- invited_at for status 'invited'), and asking someone which days suit them is
-- not an offer of an appointment. Reusing it would consume an admission
-- allowance to ask a question.
--
-- Hashed token, TTL and terminal-outcome shape follow the precedent that table
-- already sets, so the two behave alike where they genuinely are alike.
create table if not exists public.new_client_waitlist_preference_grants (
  id                        uuid primary key default gen_random_uuid(),
  studio_id                 uuid not null references public.studios (id) on delete cascade,
  entry_id                  uuid not null,
  -- The raw token is never stored, exactly as the invitation table does it.
  token_hash                text not null,
  issued_at                 timestamptz not null default now(),
  expires_at                timestamptz not null,
  issued_by_practitioner_id uuid not null,
  redeemed_at               timestamptz,
  revoked_at                timestamptz,

  constraint new_client_waitlist_preference_grants_entry_same_studio_fk
    foreign key (entry_id, studio_id)
    references public.new_client_waitlist_entries (id, studio_id) on delete cascade,
  constraint new_client_waitlist_preference_grants_issued_by_same_studio_fk
    foreign key (issued_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict,
  constraint new_client_waitlist_preference_grants_ttl_check
    check (expires_at > issued_at),
  -- Redeemed and revoked are both terminal and mutually exclusive.
  constraint new_client_waitlist_preference_grants_one_terminal_outcome_check
    check (redeemed_at is null or revoked_at is null)
);

create unique index if not exists new_client_waitlist_preference_grants_token_hash_uniq
  on public.new_client_waitlist_preference_grants (token_hash);

-- At most ONE live grant per entry: a second outstanding link means two people
-- can answer the same question and the later answer silently wins.
create unique index if not exists new_client_waitlist_preference_grants_one_live_per_entry
  on public.new_client_waitlist_preference_grants (entry_id)
  where redeemed_at is null and revoked_at is null;

alter table public.new_client_waitlist_preference_grants enable row level security;

-- SELECT for owners only, and NO insert/update/delete policy at all — matching
-- new_client_waitlist_entries exactly. Every write goes through a SECURITY
-- DEFINER command granted to service_role, so authority is re-derived in the
-- database and never taken from a request body.
drop policy if exists "new_client_waitlist_preference_grants_owner_select"
  on public.new_client_waitlist_preference_grants;
create policy "new_client_waitlist_preference_grants_owner_select"
  on public.new_client_waitlist_preference_grants
  for select using (is_studio_owner(studio_id));

-- ---------------------------------------------------------------------------
-- 5. NO NEW INDEX FOR RANKING, ON PURPOSE
-- ---------------------------------------------------------------------------
--
-- Ranking runs in the application over the cohort the existing
-- new_client_waitlist_entries_queue_idx (studio_id, status, joined_at, id)
-- already serves. Adding a preference index would speculate about a query
-- nobody has written and would be measured against a 17-row table.

-- ---------------------------------------------------------------------------
-- 6. COMMAND SURFACE — CONTRACTS ONLY, BODIES BELONG WITH THE MIGRATION SLICE
-- ---------------------------------------------------------------------------
--
-- All SECURITY DEFINER, all granted to service_role ONLY, and all must REVOKE
-- from anon, authenticated AND service_role by name before granting — Supabase's
-- ALTER DEFAULT PRIVILEGES grants EXECUTE to all three at create time. That was
-- missed in 0129 (anon) and again in 0164 (service_role); the grant guard test
-- exists because of it.
--
--   create_practitioner_waitlist_entry(studio, actor_user, name, email, phone,
--                                      availability_preference)
--       -> source 'practitioner', joined_at = now(), provenance
--          'operator_supplied', created_by = resolved actor.        (req 2)
--
--   import_legacy_waitlist_entry(studio, actor_user, name, email, phone,
--                                joined_at, joined_at_provenance)
--       -> source 'legacy_import'. Caller MUST pass joined_at and its
--          provenance explicitly; there is no defaulting path, which is what
--          stops now() erasing a real wait.                          (req 3)
--
--   set_waitlist_entry_availability(studio, entry, actor_user, preference)
--       -> writes preference + availability_stated_at together.      (req 1)
--
--   redeem_waitlist_preference_grant(token, preference)
--       -> the unauthenticated prospect-facing path. Matches on token_hash,
--          enforces TTL and terminal state, writes the preference, marks the
--          grant redeemed. Reveals nothing about the entry on failure.  (req 4)
--
--   claim_new_client_waitlist_entries_ordered(studio, actor_user, entry_ids[])
--       -> the ranked counterpart to today's FIFO claim_new_client_waitlist_entries.
--          Takes an EXPLICIT ordered id list so ranking stays in the application
--          and the database keeps owning the lease, the skip-locked contention
--          rule and the single decision instant. Must preserve those exactly.
--                                                                     (req 6)

commit;

-- ===========================================================================
-- POST-LANDING VERIFICATION (run against a fresh local reset, not production)
-- ===========================================================================
--   1. every existing row: source='public_booking', joined_at_provenance='form'
--   2. availability_preference is NULL on all pre-existing rows
--   3. inserting source='practitioner' without created_by_practitioner_id FAILS
--   4. inserting source='legacy_import' with joined_at_provenance='form' FAILS
--   5. a preference without availability_stated_at FAILS
--   6. two live grants for one entry FAILS on the partial unique index
--   7. anon and authenticated hold no EXECUTE on any new command
--   8. lib/waitlist/candidate.ts projects real rows unchanged (still FIFO until
--      a studio actually collects preferences)
