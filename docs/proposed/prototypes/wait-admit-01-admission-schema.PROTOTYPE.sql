-- ===========================================================================
-- WAIT-ADMIT-01 — CONSOLIDATED ADMISSION SCHEMA (PROTOTYPE — NOT A MIGRATION)
-- ===========================================================================
--
-- NO MIGRATION NUMBER IS CLAIMED and this file is deliberately outside
-- supabase/migrations/ with no NNNN_ prefix, so `npm run migration:state` does
-- not see it and no slot is reserved. Verified after writing: repo max 0191,
-- next free 0192, pending (none, repo == hosted).
--
-- ONE DOCUMENT, NOT SPLIT INTO MIGRATIONS. Splitting is a slot-ownership
-- decision and has not been made. The internal ordering below is written so it
-- CAN be split later along the numbered section boundaries without reordering.
--
-- Same discipline WAIT-03B/B2 already uses for its own unlanded SQL
-- (docs/proposed/prototypes/wait03b-*.PROTOTYPE.sql). B2 touches
-- new_client_waitlist_invitations, studio_waitlist_admission_rounds and a
-- services unique constraint; this document touches
-- new_client_waitlist_entries, studios and one new table. No shared object, no
-- shared column: the two can take slots in either order.
--
-- ---------------------------------------------------------------------------
-- WHAT IT COVERS
-- ---------------------------------------------------------------------------
--   §1  weekday / weekend / both preference                          (req 1)
--   §2  preference confirmation + update timestamps                  (req 4)
--   §3  practitioner / manual-added provenance                       (req 2)
--   §4  legacy import provenance                                     (req 3)
--   §5  name provenance — RECORDED AS PROPOSED, NOT IMPLEMENTED
--   §6  per-studio ranking policy                                    (req 5)
--   §7  preference-update grants                                     (req 4)
--   §8  index posture
--   §9  command surface (contracts only)
--
-- NONE OF IT IS NEEDED FOR THE CODE TO BE CORRECT. lib/waitlist/* reads every
-- column below as optional, treats absent as "not stated", and degrades to
-- exactly today's FIFO order — asserted by test. 143 unit tests pass against
-- the CURRENT schema.
-- ===========================================================================

begin;

-- `supabase db push` does not wrap a file in a transaction, so the BEGIN above
-- is this change's own. A bare SET LOCAL outside a transaction raises 25P01 and
-- never arms, which is why it comes after.
set local lock_timeout = '5s';

-- ===========================================================================
-- §1  AVAILABILITY PREFERENCE                                        (req 1)
-- ===========================================================================
--
-- NULLABLE, AND IT MUST STAY NULLABLE FOREVER. NULL means NOT STATED — the true
-- description of all 17 currently-waiting prospects and of every legacy import.
-- A NOT NULL column with a default would assert an answer on behalf of people
-- nobody has asked, and the ranking engine weights this factor.
--
-- Vocabulary matches lib/waitlist/preferences.ts exactly. Weekday numbering,
-- where it appears elsewhere, is extract(dow) 0 = Sunday — the same convention
-- WAIT-03B/B2 pins in scope_allowed_weekdays. Two waitlist features disagreeing
-- about which integer means Sunday would produce a mismatch neither lane's
-- tests would catch, because each would be internally consistent.
alter table public.new_client_waitlist_entries
  add column if not exists availability_preference text;

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_availability_preference_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_availability_preference_check
  check (
    availability_preference is null
    or availability_preference in ('weekdays', 'weekends', 'both')
  );

-- ===========================================================================
-- §2  PREFERENCE CONFIRMATION AND UPDATE TIMESTAMPS                  (req 4)
-- ===========================================================================
--
-- TWO TIMESTAMPS, NOT ONE, AND THIS IS THE PART MOST LIKELY TO BE "SIMPLIFIED"
-- BY A LATER READER. They answer different questions:
--
--   availability_stated_at     when this VALUE was last set or CHANGED.
--   availability_confirmed_at  when it was last AFFIRMED, changed or not.
--
-- Collapse them and you must choose which truth to lose:
--
--   * Move a single column on re-confirmation and the history of the value is
--     destroyed — a preference held unchanged for eight months looks like one
--     set last week, and "has anything changed for you?" becomes unanswerable.
--
--   * Do NOT move it on re-confirmation and the preference ages out while the
--     person is actively telling you it still holds, so the studio re-asks
--     someone who answered last week. That is the more visible failure and it
--     is the one that teaches operators to ignore the staleness signal.
--
-- That is what makes the confirmation column REQUIRED rather than decorative:
-- without it, freshness cannot be refreshed except by pretending the answer
-- changed. The rule is implemented and tested in lib/waitlist/confirmation.ts
-- (applyConfirmation); this constraint is its database-side floor.
--
-- availability_source keeps the three routes distinct. 'prospect_link' is NOT
-- merged into 'public_form': it is the prospect's own answer, but authenticated
-- by a token rather than by arriving with a booking, and an operator judging
-- whether to trust a preference should be able to see which.
alter table public.new_client_waitlist_entries
  add column if not exists availability_stated_at    timestamptz,
  add column if not exists availability_confirmed_at timestamptz,
  add column if not exists availability_source       text,
  add column if not exists availability_recorded_by_practitioner_id uuid;

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_availability_source_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_availability_source_check
  check (
    availability_source is null
    or availability_source in ('public_form', 'practitioner', 'prospect_link')
  );

-- ALL FOUR TRAVEL TOGETHER OR NONE DO. A preference with no stamp cannot be
-- aged, so it cannot be trusted as a current answer; a stamp with no preference
-- describes nothing. The adapter already refuses such a row at read time
-- (reading it as unstated); this makes it unwritable in the first place.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_availability_completeness_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_availability_completeness_check
  check (
    (availability_preference is null
     and availability_stated_at is null
     and availability_confirmed_at is null
     and availability_source is null)
    or
    (availability_preference is not null
     and availability_stated_at is not null
     and availability_confirmed_at is not null
     and availability_source is not null)
  );

-- A confirmation cannot predate the value it confirms. Setting a value IS
-- confirming it, so a fresh statement seeds both to the same instant.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_availability_order_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_availability_order_check
  check (
    availability_confirmed_at is null
    or availability_stated_at is null
    or availability_confirmed_at >= availability_stated_at
  );

-- Only a practitioner-recorded preference names a practitioner — both
-- directions, so a token-authenticated answer cannot be attributed to a human
-- who was not involved.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_availability_recorder_same_studio_fk;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_availability_recorder_same_studio_fk
  foreign key (availability_recorded_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id) on delete restrict;

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_availability_recorder_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_availability_recorder_check
  check (
    (availability_source = 'practitioner'
       and availability_recorded_by_practitioner_id is not null)
    or
    (availability_source is distinct from 'practitioner'
       and availability_recorded_by_practitioner_id is null)
  );

-- ===========================================================================
-- §3  PRACTITIONER / MANUAL-ADDED PROVENANCE                         (req 2)
-- ===========================================================================
--
-- `source` is currently CHECK (source = 'public_booking') — a SINGLE-VALUED
-- constraint, and it is the one line that makes both a practitioner-created
-- entry and a legacy import structurally impossible today.
--
-- Compounding it, and worth stating because widening the CHECK alone is not
-- sufficient: the table has ONLY a SELECT policy (owner). There is no INSERT
-- policy at all, so every write must go through a SECURITY DEFINER command —
-- see §9.
alter table public.new_client_waitlist_entries
  add column if not exists created_by_practitioner_id uuid;

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_source_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_source_check
  check (source in ('public_booking', 'practitioner', 'legacy_import'));

-- Same composite same-studio FK shape the table's three existing actor columns
-- already use, so a practitioner from another studio cannot be referenced.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_created_by_same_studio_fk;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_created_by_same_studio_fk
  foreign key (created_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id) on delete restrict;

-- An operator-originated entry NAMES the operator; a public one must not,
-- because nobody at the studio created it.
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
-- §4  LEGACY IMPORT PROVENANCE                                       (req 3)
-- ===========================================================================
--
-- THE DEFAULT 'form' FABRICATES NOTHING, and the constraint being replaced in
-- §3 is the proof: every row in the table today satisfies
-- source = 'public_booking', so every row demonstrably arrived through the
-- public form. 'form' is a VERIFIED FACT about the existing 18 rows, not an
-- assumption about them. Backfilling any other column this confidently would
-- not be legitimate.
alter table public.new_client_waitlist_entries
  add column if not exists joined_at_provenance text not null default 'form';

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

-- ---------------------------------------------------------------------------
-- WHAT 'unknown' MEANS FOR joined_at, AND THE RISK IT CARRIES
-- ---------------------------------------------------------------------------
--
-- joined_at stays NOT NULL. For an entry whose real join date nobody has, it
-- holds the IMPORT INSTANT and is a QUEUE ANCHOR ONLY — it says where the row
-- sorts, not how long the person has waited.
--
-- THE HONEST RISK: that value looks exactly like a real date. Any reader that
-- ignores joined_at_provenance will report a person who has waited eight months
-- as having waited a day, and rank them accordingly. The mitigation is that
-- nothing in lib/waitlist reads joined_at without it — projectCandidates sets
-- waitIsMeasurable=false, the waiting-time factor returns UNKNOWN rather than a
-- near-zero score, and daysWaiting is null rather than 0. Any NEW reader must
-- do the same.
--
-- CONSIDERED AND NOT TAKEN: a second nullable column (joined_at_observed) with
-- joined_at redefined as "entered our queue". It removes the look-alike risk,
-- but it splits a concept every existing reader treats as one, and ranking would
-- still need a rule for the null case — the same rule, in a second place. One
-- column plus a provenance flag keeps the rule in one place.

-- ===========================================================================
-- §5  NAME PROVENANCE — PROPOSED, DELIBERATELY NOT IMPLEMENTED
-- ===========================================================================
--
-- `name` REMAINS NOT NULL with its existing CHECK (length(btrim(name)) >= 1).
-- Nothing below is executed. This section exists so the decision is recorded
-- where the schema lives rather than in a conversation.
--
-- PROPOSED:
--     alter table public.new_client_waitlist_entries
--       add column if not exists name_provenance text not null default 'self_reported';
--     -- check (name_provenance in ('self_reported','practitioner_recorded',
--     --                            'operator_transcribed','operator_inferred'))
--
-- IS IT GENUINELY NEEDED? The honest answer, because "add a column for
-- symmetry" is how a schema grows fields nobody reads:
--
--   * For the SOURCE-LEVEL distinction it is REDUNDANT. `source` already says
--     who produced the name — 'public_booking' means the person typed it,
--     'practitioner' means a practitioner took it down, 'legacy_import' means an
--     operator transcribed it. A column restating that earns nothing.
--
--   * There is exactly ONE distinction `source` cannot make, and it is real:
--     within a legacy import, a name the operator KNOWS from correspondence and
--     a name the operator GUESSED from an email local part are both
--     'legacy_import'. Addressing someone by a guessed name is a small but
--     genuine harm, and no existing column separates the two.
--
--   * That case is TODAY CLOSED BY REFUSAL, not by schema.
--     planLegacyWaitlistImport returns a nameless row as `needs_decision`, and
--     there is deliberately no allowUnknownName counterpart to
--     allowUnknownJoinedAt. So an inferred name can only enter if an operator
--     types it deliberately, having decided it is good enough.
--
-- CONCLUSION: not required for requirements 1-6. It becomes required if, and
-- only if, the refusal above is relaxed at volume. The vocabulary is already
-- defined and tested (lib/waitlist/provenance.ts, ProposedNameProvenance) so
-- adopting it later is a column plus a CHECK, not a redesign.

-- ===========================================================================
-- §6  PER-STUDIO RANKING POLICY                                      (req 5)
-- ===========================================================================
--
-- NULL = no policy configured = FIFO = today's exact queue order, so adding
-- this column changes no studio's behaviour on the day it lands. Shape and
-- every parse rule are already defined and tested in lib/waitlist/policy.ts;
-- jsonb is storage, never a type. ABSENT means FIFO and MALFORMED means refuse
-- — the parser keeps those distinct so a corrupt document cannot silently
-- reorder a studio's queue while the operator believes their policy is running.
alter table public.studios
  add column if not exists waitlist_ranking_policy jsonb;

-- ===========================================================================
-- §7  PREFERENCE-UPDATE GRANTS                                       (req 4)
-- ===========================================================================
--
-- A SEPARATE TABLE FROM new_client_waitlist_invitations, deliberately. That
-- table's cycle-evidence CHECK requires claimed_at, claimed_by_practitioner_id
-- and invited_at for status 'invited', so issuing one drags a waiting prospect
-- through claim -> invite. Asking someone which days suit them is not an offer
-- of an appointment, and reusing the invitation would consume an admission
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

-- ===========================================================================
-- §8  NO NEW INDEX FOR RANKING, ON PURPOSE
-- ===========================================================================
--
-- Ranking runs in the application over the cohort the existing
-- new_client_waitlist_entries_queue_idx (studio_id, status, joined_at, id)
-- already serves. An index on availability_preference would speculate about a
-- query nobody has written, measured against a 17-row table.

commit;

-- ===========================================================================
-- §9  COMMAND SURFACE — CONTRACTS ONLY, BODIES BELONG WITH THE SLOT
-- ===========================================================================
--
-- All SECURITY DEFINER, all granted to service_role ONLY, and all must REVOKE
-- from anon, authenticated AND service_role BY NAME before granting — Supabase's
-- ALTER DEFAULT PRIVILEGES grants EXECUTE to all three at function-create time.
-- That was missed in 0129 (anon) and again in 0164 (service_role);
-- tests/security/clinical-rpc-grant-guard.test.ts exists because of it.
--
--   create_practitioner_waitlist_entry(studio, actor_user, name, email, phone,
--                                      availability_preference)
--       source 'practitioner', joined_at = now(), provenance
--       'operator_supplied', created_by = resolved actor. A supplied
--       preference sets all four §2 columns with source 'practitioner'.  (req 2)
--
--   import_legacy_waitlist_entry(studio, actor_user, name, email, phone,
--                                joined_at, joined_at_provenance)
--       source 'legacy_import'. The caller MUST pass joined_at and its
--       provenance explicitly; there is NO defaulting path, which is what stops
--       now() erasing a real wait. 'unknown' is accepted only as a deliberate
--       operator decision.                                              (req 3)
--
--   set_waitlist_entry_availability(studio, entry, actor_user, preference)
--       Operator path. Applies the applyConfirmation rule: unchanged answer
--       moves confirmed_at only; changed answer moves both.              (req 1)
--
--   redeem_waitlist_preference_grant(token, preference)
--       The unauthenticated prospect-facing path. Matches on token_hash,
--       enforces TTL and terminal state, applies the same confirmation rule
--       with source 'prospect_link', marks the grant redeemed. Reveals nothing
--       about the entry on failure — a wrong or expired token and a valid one
--       for a removed entry must be indistinguishable to the caller.     (req 4)
--
--   claim_new_client_waitlist_entries_ordered(studio, actor_user, entry_ids[])
--       The ranked counterpart to today's FIFO claim_new_client_waitlist_entries.
--       Takes an EXPLICIT ordered id list so ranking stays in the application
--       and the database keeps owning the lease, the FOR UPDATE SKIP LOCKED
--       contention rule and the single decision instant — all three of which
--       the existing function establishes and none of which may regress. (req 6)
--
-- ===========================================================================
-- POST-LANDING VERIFICATION (fresh local reset, never production)
-- ===========================================================================
--   1.  every pre-existing row: source='public_booking', provenance='form'
--   2.  availability_preference NULL on every pre-existing row
--   3.  source='practitioner' without created_by_practitioner_id  -> FAILS
--   4.  source='public_booking' with created_by_practitioner_id   -> FAILS
--   5.  source='legacy_import' with provenance='form'             -> FAILS
--   6.  preference set without stated_at/confirmed_at/source      -> FAILS
--   7.  confirmed_at < stated_at                                  -> FAILS
--   8.  availability_source='practitioner' with no recorder       -> FAILS
--   9.  availability_source='prospect_link' WITH a recorder        -> FAILS
--   10. two live grants for one entry                             -> FAILS
--   11. anon and authenticated hold no EXECUTE on any new command
--   12. lib/waitlist/candidate.ts projects real rows unchanged — still FIFO
--       until a studio actually collects preferences
