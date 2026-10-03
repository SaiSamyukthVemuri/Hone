-- ---------------------------------------------------------------------------
-- 0205 - A NEW STUDIO IS BORN WITH ITS ADMISSION AUTHORITY ALREADY INITIALIZED.
-- ---------------------------------------------------------------------------
--
-- PRODUCT RULING. Every NEW studio begins at new-client admission = OPEN
-- ("Accept bookings"). Waitlist and Closed are optional owner choices. A newly
-- created studio must NOT be required to select Waitlist once before Open or
-- Closed become available.
--
-- THE REGRESSION. 0204 gave `new_client_admission_mode` a correct
-- `not null default 'open'`, but left `new_client_admission_mode_set_at` with
-- NO default. 0204 also reads
--
--     new_client_admission_mode_set_at IS NULL
--
-- as the authoritative marker for an UNSTAMPED PRE-0204 LEGACY row, and refuses
-- a direct move to 'open' or 'closed' for such a row with
-- `legacy_waitlist_cutover_required`. So a studio created AFTER 0204 was born
--
--     mode    = 'open'
--     set_at  = NULL
--
-- which is byte-for-byte indistinguishable from a pre-0204 legacy row. Its
-- brand-new owner was told to "choose Waitlist first" before Open or Closed
-- became available - a cutover ceremony that belongs only to studios that
-- really did predate 0204.
--
-- THE FIX IS ONE DEFAULT, AND IT TOUCHES NO LOGIC.
--
-- `set_new_client_admission_mode` reads `set_at` FROM THE ROW, under the lock it
-- already holds. Giving the column a default means a new row arrives already
-- stamped, so `v_unstamped` is false and the legacy branch simply does not fire.
-- The legacy transition guard is NOT weakened, NOT bypassed and NOT edited: it
-- still refuses exactly the rows it was written to refuse, which are the rows
-- that carry a NULL `set_at` because nothing ever stamped them.
--
-- WHY THE DATABASE LAYER AND NOT THE ADMIN WIZARD.
-- `app/admin/studios/new/actions.ts` is today the only INSERT into
-- public.studios, but it is not guaranteed to stay the only one. A column
-- default makes every future creation path - a second admin surface, a
-- self-serve signup, a restore, a fixture - inherit the same semantics without
-- re-implementing them. The wizard therefore sets NO admission field and keeps
-- inheriting this default; there is deliberately no second application-only
-- copy of this rule.
--
-- WHY set_by STAYS NULL, STRUCTURALLY RATHER THAN BY CONVENTION.
-- The owner practitioner DOES NOT EXIST when the studio row is inserted:
-- app/admin/studios/new/actions.ts inserts the studio and a pending_invitation,
-- and the owner's practitioner row is created later by handle_new_user() (0081)
-- on their first sign-in. There is no practitioner id to record at creation, so
-- `set_by` cannot be anything but NULL - which is exactly what makes it the
-- discriminator the next section describes.
--
-- THE THREE-STATE READING THIS ESTABLISHES.
--
--   set_at NULL                  the persisted admission authority was never
--                                initialized. A pre-0204 row. Legacy/unstamped
--                                transition semantics apply, unchanged.
--
--   set_at non-null, set_by NULL the authority was initialized BY THE SYSTEM at
--                                studio creation. Persisted OPEN. No ceremony.
--
--   set_at non-null, set_by set  an authenticated owner subsequently chose the
--                                mode through set_new_client_admission_mode.
--
-- So non-null `set_at` no longer means "an owner deliberately chose a mode". It
-- means "the persisted admission authority has been initialized", and `set_by`
-- is what separates system initialization from an owner's change. The column
-- comments below are rewritten to say so, because 0204's say the older thing
-- and 0204 is frozen.
--
-- THE DEFAULT ITSELF CANNOT BACKFILL, AND THAT IS A CLAIM ABOUT THE DEFAULT.
-- `ALTER TABLE ... ALTER COLUMN ... SET DEFAULT` records a default for FUTURE
-- inserts only; it never rewrites an existing row. That is why the default is
-- spelled this way rather than as `ADD COLUMN ... DEFAULT`, which in
-- PostgreSQL 11+ DOES populate existing rows and would have stamped every
-- legacy studio on contact.
--
-- WHICH EXISTING ROWS KEEP `set_at` NULL, STATED EXACTLY. Census members and
-- every other pre-0204 legacy row keep it, because nothing in this migration
-- selects them. A studio created AFTER the census but BEFORE this apply does
-- NOT: section 3 deliberately stamps it, which is the entire point of section 3.
--
-- HISTORY OF THIS PARAGRAPH, kept because it was wrong twice and the shape of
-- the error is worth a reader's time. It said "every pre-fix studio keeps
-- `set_at` NULL", and that the fix is not "an UPDATE". Both were true of the
-- DEFAULT alone and false of the MIGRATION, which performs two UPDATE
-- statements per candidate - see the STATEMENT INVENTORY below. An absolute
-- claim in operator-facing prose, about a migration that does write rows, is
-- the wrong kind of wrong, so the scope is named above instead.
--
-- NOTHING MACHINE-CHECKS THIS PROSE, deliberately. Two source-contract tests
-- used to, and both were withdrawn: a regex can tell neither a quoted retired
-- claim from an asserted one, nor a reworded universal from a scoped one. "All
-- pre-fix studios retain `set_at` NULL" defeated the last attempt while every
-- pattern still passed. Semantic accuracy of prose is a REVIEW responsibility -
-- which is where it has actually worked, four times - and the tests here assert
-- the SQL instead.
--
-- THE CENSUS-TO-APPLY GAP, AND WHY THIS MIGRATION CARRIES A REPAIR.
--
-- A read-only census of the canonical production project found 7 studios, 5 of
-- them mode='open' with set_at NULL, and the NEWEST created
-- 2026-09-19T20:13:50.840921Z. Every one of those predates the 0204 apply, so
-- all 5 are genuine legacy rows that MUST stay NULL. At census time NO studio
-- qualified for repair.
--
-- BUT A CENSUS IS A POINT IN TIME, AND THE DEFAULT ONLY HELPS FUTURE INSERTS.
-- 0204 is already applied to production while 0205 is not, so any studio created
-- in the window BETWEEN the census and this apply is born `open` / NULL - and
-- after this migration lands it would keep that NULL forever and be read as a
-- pre-0204 legacy row. Its owner would get the cutover ceremony that 0205
-- exists to remove. The column default cannot reach it: `SET DEFAULT` applies to
-- inserts that happen AFTER it, and this row already exists by then.
--
-- So section 3 repairs exactly that window, at apply time, and nothing else.
--
-- HOW "PROVABLY CREATED AFTER 0204" IS ESTABLISHED. The database cannot answer
-- it directly: `supabase_migrations.schema_migrations` carries only
-- (version, statements, name) and has NO timestamp column, so there is no
-- server-side 0204 apply instant to compare against.
--
-- THE EVIDENCE IS CENSUS MEMBERSHIP, AND IT IS IMMUTABLE. A read-only census of
-- the canonical production project on 2026-10-01 was taken while `max(version)`
-- was ALREADY `0204` -- so 0204 was applied -- and it enumerated EVERY studio:
-- seven rows, whose ids are listed in section 3. A row that is NOT one of those
-- seven did not exist at a moment when 0204 was already applied, so it was
-- created after 0204. That is the whole proof, and a row cannot change its own
-- id.
--
-- WHY NOT `created_at`, WHICH AN EARLIER REVISION USED. `studios.created_at` IS
-- MUTABLE BY THE ROW'S OWN OWNER: RLS policy "studios: owners update" permits an
-- owner to UPDATE their studio, `authenticated` holds column UPDATE privilege on
-- `created_at`, and `studios_admission_mode_guard` protects only the three
-- admission fields. So a genuine pre-0204 legacy studio could be FORWARD-DATED
-- past a timestamp boundary and would then qualify for this repair, be stamped,
-- and silently lose the legacy cutover this migration promises to preserve.
--
-- That earlier revision reasoned only about BACKDATING -- which makes a
-- timestamp predicate under-repair, the safe direction -- and then wrote a
-- conclusion about both directions. Forward-dating is the unsafe one, it is
-- reachable by an ordinary owner through PostgREST, and the fail-closed shape
-- check could not see it because such a row looks entirely normal. An id is not
-- writable by its owner; a timestamp is. So identity is the id.
--
-- `created_at` IS STILL USED, FOR EXACTLY ONE THING: it is the VALUE written
-- into `set_at` for a qualifying row, because the semantic being recorded is
-- "the system initialized this studio's admission authority when the studio was
-- created". It carries no part of the eligibility decision. A row with a
-- nonsense `created_at` therefore gets a nonsense stamp VALUE, which is visible
-- and correctable, rather than a wrong eligibility VERDICT, which is neither.
--
-- FAIL-CLOSED IN THE DIRECTION THAT MATTERS. The two errors are not
-- symmetrical. Leaving a window row NULL reproduces the bug: a spurious
-- ceremony, annoying and safe. Wrongly stamping a GENUINE legacy row skips a
-- cutover that exists because the legacy email-only join path cannot be made
-- atomic -- a correctness risk. So the repair writes ONLY what it can prove, and
-- section 3 refuses to run at all if the data does not match its model.
-- STATEMENT INVENTORY, for the apply record: ONE `alter table ... alter column
-- ... set default`, TWO `comment on column`, and ONE `do` block containing TWO
-- `update public.studios` STATEMENTS PER REPAIR CANDIDATE.
--
-- THE TWO ARE DIFFERENT IN KIND, and an operator verifying an apply needs both
-- named rather than one of them hidden behind "only write":
--
--   1. THE GUARD PROBE - the repair's own statement with the permit NOT armed,
--      executed to be REFUSED. It is executable DML: it fires triggers, takes
--      the row lock and opens a subtransaction. It is rolled back on every path
--      and CANNOT persist, but "does not persist" is not "does not run".
--   2. THE BOUNDED REPAIR - the same statement with the permit armed. This is
--      the one that writes, over the window set defined above.
--
-- With ZERO candidates the block executes NEITHER: no probe, no repair.
--
-- No table created or dropped, no column added or dropped, no index, no
-- constraint, no function, no trigger, no grant, and no insert, delete or
-- truncate anywhere in the file.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. THE DEFAULT
-- ---------------------------------------------------------------------------
--
-- `now()` matches what public.studios.created_at already uses as ITS default,
-- so a studio's creation instant and its admission-initialization instant are
-- the same transaction timestamp rather than two values that merely look alike.
-- Verified against production: created_at's default is `now()`.
--
-- `mode` already carries `default 'open'` from 0204 and `set_by` already has no
-- default; neither is restated here. Re-asserting a default that is already
-- correct would add statements to a production apply for no behavioural change.
-- The full three-column shape is asserted in
-- tests/migrations/0205-new-studio-admission-default.test.ts instead.
alter table public.studios
  alter column new_client_admission_mode_set_at set default now();

-- ---------------------------------------------------------------------------
-- 2. THE COLUMN COMMENTS 0204 CAN NO LONGER CARRY
-- ---------------------------------------------------------------------------
--
-- 0204 is applied and FROZEN, so its comments are replaced forward from here.
-- They currently define non-null `set_at` as "an owner chose a mode", which is
-- false the moment a studio is born stamped.
comment on column public.studios.new_client_admission_mode_set_at is
  'When the persisted new-client admission authority was last initialized or '
  'changed, from the DATABASE clock. NON-NULL means the authority IS '
  'initialized - either by the system at studio creation (0205 column default, '
  'new_client_admission_mode_set_by NULL) or by an owner choosing a mode '
  'through set_new_client_admission_mode (set_by non-null). NULL means it was '
  'never initialized: a pre-0204 row still carrying 0204''s backfill default, '
  'for which the legacy/unstamped transition rule applies. Read set_by to tell '
  'system initialization from an owner''s change - this column alone no longer '
  'distinguishes them.';

comment on column public.studios.new_client_admission_mode_set_by is
  'The practitioner the DATABASE resolved from auth.uid() at the moment an '
  'OWNER set the mode - never an id the browser supplied. NULL means no owner '
  'has changed the mode: either the row was system-initialized at studio '
  'creation (set_at non-null) or it predates 0204 entirely (set_at NULL), and '
  'set_at is what separates those two. Deliberately NOT a foreign key: a '
  'second studios<->practitioners relationship would make the established '
  'practitioners -> studio:studios(*) PostgREST embed ambiguous. Integrity '
  'comes from set_new_client_admission_mode plus the scoped permit guard, not '
  'from a constraint, and the value outlives the practitioner row.';

-- ---------------------------------------------------------------------------
-- 3. THE BOUNDED APPLY-TIME REPAIR
-- ---------------------------------------------------------------------------
--
-- Scope: studios PROVABLY created after 0204 -- that is, NOT members of the
-- 2026-10-01 census enumerated below -- that are still unstamped and still
-- carry the plain system default. Everything else is untouched: every census
-- member, and every row an owner has already stamped.
--
-- Census membership is by ID, not by timestamp, because `created_at` is mutable
-- by the row's own owner and a forward-dated legacy row would otherwise qualify.
-- The header records that reasoning in full.
--
-- IDEMPOTENT. A repaired row is no longer `set_at IS NULL`, so a second run
-- selects nothing. The per-row UPDATE re-checks the NULL under the row lock, so
-- a concurrent writer cannot be overwritten either.
--
-- THE PERMIT IS ARMED PER ROW, NEVER GLOBALLY. `studios_admission_mode_guard`
-- compares `hone.admission_mode_studio_id` against the row being written, so a
-- set-based UPDATE cannot pass it - one permit cannot authorise many rows, which
-- is the guard working as designed. The loop therefore arms the permit for
-- exactly the row it is about to write, and clears it afterwards so no later
-- statement inherits an authorisation it did not ask for. There is deliberately
-- no value of the permit that means "allow anything".
-- >>> 0205 APPLY-TIME REPAIR BEGIN
do $repair$
declare
  -- THE 2026-10-01 CENSUS, BY ID. Immutable evidence: taken while hosted
  -- `max(version)` was already `0204`, enumerating EVERY studio then existing.
  -- A row outside this set did not exist once 0204 was applied, so it postdates
  -- 0204. Unlike `created_at`, a row cannot rewrite its own id -- see the header
  -- for why the timestamp boundary this replaced was not sound.
  --
  -- This list is CLOSED. It must never grow: adding an id would protect a studio
  -- the census never saw, which is exactly the legacy misclassification 0205
  -- exists to remove.
  k_census constant uuid[] := array[
    '38cb3a8b-f0f1-409e-9ea4-ffa4b95cb4c6'::uuid,
    '6cdef761-07ce-4c3d-b121-69cb1ec834cf'::uuid,
    '9d37c51a-6237-42ef-b9d3-28a567c2bfa8'::uuid,
    'f5c6f49f-265f-4bb4-b7ae-70f42d78e807'::uuid,
    '97f621f5-8044-41c7-9499-030a79b0adeb'::uuid,
    '24c7b43a-d78e-4a87-a697-34f6488dc6a0'::uuid,
    'eb5023c5-45b3-4215-9b02-afa10705a8fa'::uuid
  ];
  r               record;
  v_guard_policed boolean;
  v_guard_diag    text;
  v_studios       integer;
  v_census_seen   integer;
  v_anomalous     integer;
  v_repaired      integer := 0;
  v_left          integer;
begin
  -- FAIL CLOSED #1: THE LINEAGE GATE, before any DML.
  --
  -- `k_census` can distinguish production's known rows ONLY on a database
  -- descended from the census that produced it. On any OTHER non-empty database
  -- - Hone Staging, or an older production backup being restored and migrated -
  -- none of those ids exist, so every ordinary open/unstamped row would read as
  -- post-0204 and be stamped, silently losing the legacy cutover. The shape
  -- check below cannot catch it: those rows ARE the expected shape.
  --
  -- MEASURED, NOT ASSUMED. Simulating three genuine legacy rows on a non-census
  -- database and running this block stamped all three.
  --
  -- THIS IS A LINEAGE ASSERTION, NOT A SECOND ELIGIBILITY HEURISTIC. It answers
  -- one question - "is this the database the census describes?" - and eligibility
  -- is untouched by it.
  --
  --   EMPTY studios        -> nothing to repair, no lineage to assert, and no
  --                           guard to probe. Every fresh chain, including
  --                           `db reset` and CI's db lane.
  --   NON-EMPTY studios    -> every census id MUST be present, and the guard MUST
  --                           be proved live. Any failure ABORTS.
  --
  -- ABORT, NOT SKIP, IS DELIBERATE and it has a cost worth naming: 0205 cannot
  -- be applied to a populated non-census database until that database is dealt
  -- with explicitly. A silent skip would have been friendlier and worse - an
  -- operator would see a successful apply and conclude the repair had run.
  select count(*) into v_studios from public.studios;

  if v_studios = 0 then
    raise notice
      '0205: studios is empty; nothing to repair, and neither the lineage gate '
      'nor the guard probe is applicable';
  else
    select count(*)
      into v_census_seen
      from public.studios s
     where s.id = any (k_census);

    if v_census_seen <> array_length(k_census, 1) then
      raise exception
        '0205: this database is NOT the 2026-10-01 census lineage - % of % census '
        'studios present across % studios total. Absence from the census set is '
        'therefore not evidence of post-0204 creation, so the repair is refused.',
        v_census_seen, array_length(k_census, 1), v_studios;
    end if;

  end if;

  -- FAIL CLOSED #2: every candidate must look the way the model says it looks.
  -- A non-census unstamped row that is NOT a plain system default - a mode other
  -- than open, or an actor already recorded - means the model is wrong, and
  -- writing under a wrong model is the thing being guarded against.
  select count(*)
    into v_anomalous
    from public.studios s
   where s.new_client_admission_mode_set_at is null
     and not (s.id = any (k_census))
     and (s.new_client_admission_mode <> 'open'
          or s.new_client_admission_mode_set_by is not null);
  if v_anomalous <> 0 then
    raise exception
      '0205: % unstamped non-census studio(s) do not match the system-default '
      'shape (mode=open, set_by null); refusing to repair', v_anomalous;
  end if;

  for r in
    select s.id, s.created_at
      from public.studios s
     where s.new_client_admission_mode_set_at is null
       and s.new_client_admission_mode_set_by is null
       and s.new_client_admission_mode = 'open'
       and not (s.id = any (k_census))
     order by s.id
       -- FOR NO KEY UPDATE, and DELIBERATELY NOT SOLD AS A CONCURRENCY WIN.
       --
       -- An earlier revision claimed this leaves `FOR KEY SHARE` traffic
       -- unblocked. THAT CLAIM WAS FALSE for the real apply, and a test pinned
       -- it. Section 1's `alter table ... set default` takes ACCESS EXCLUSIVE on
       -- `public.studios` and PostgreSQL holds it until THIS transaction
       -- commits - verified by reading pg_locks inside such a transaction - so
       -- for the whole of this loop every access to the table is already
       -- blocked, FOR KEY SHARE included. No row-level lock choice here can
       -- change that, and the transaction is NOT restructured to make the claim
       -- true: serializing the apply is correct.
       --
       -- WHY KEEP IT ANYWAY. It is the weakest lock that still does the job, and
       -- the job is real: it conflicts with FOR UPDATE, with another FOR NO KEY
       -- UPDATE and with a plain UPDATE of the same row, so a concurrent
       -- admission-mode writer is serialized against. That matters when this
       -- block is exercised OUTSIDE the migration - which it is, by
       -- tests/db/new-studio-admission-default, which extracts and runs it
       -- without any surrounding DDL lock. Local row-level discipline, not an
       -- operational guarantee about the apply.
       for no key update
  loop
    -- FAIL CLOSED #3: PROVE THE GUARD POLICES *THIS* WRITE, ON *THIS* ROW.
    --
    -- WHY PER-CANDIDATE, AND WHY THE SAME MUTATION. An earlier revision probed
    -- once, before the loop, by changing `set_by` on the lowest-id studio. That
    -- proved only that SOME admission write on SOME row was refused, and review
    -- produced the counterexample: a guard carrying
    -- `WHEN (new.new_client_admission_mode_set_by IS DISTINCT FROM
    -- old.new_client_admission_mode_set_by)` invokes the real function and
    -- refuses that probe, yet never fires for this repair, which changes only
    -- `set_at`. The probe passed and every candidate would have been written
    -- unguarded. That is a `tgqual` defeat shape the single probe could not see.
    --
    -- So the probe is now the REPAIR'S OWN STATEMENT, differing from it in exactly
    -- one respect: the permit is not armed. Same row, same column, same value,
    -- SAME WHERE PREDICATE, same session, immediately before the real write.
    -- Refusal therefore covers exactly the write that follows, and no narrower
    -- claim is being made about it.
    --
    -- The `set_at IS NULL` clause is carried deliberately rather than dropped as
    -- immaterial. It cannot change which row is matched here - the candidate was
    -- selected on that very predicate - but leaving it out would make the probe
    -- a DIFFERENT statement from the one being proved, and "different but surely
    -- equivalent" is the reasoning that produced every earlier gap in this
    -- prerequisite.
    --
    -- IT CANNOT PERSIST. Exception-handled block, so a subtransaction; BOTH exits
    -- are exceptions - the guard's `check_violation`, or the sentinel raise when
    -- nothing refused it - and catching either rolls the attempt back.
    --
    -- NO CANDIDATES MEANS NO PROBE, and that is correct rather than a gap: the
    -- guard needs proving for writes this migration actually makes, and when
    -- there are none it makes none.
    v_guard_policed := false;

    begin
      update public.studios s
         set new_client_admission_mode_set_at = r.created_at
       where s.id = r.id
         and s.new_client_admission_mode_set_at is null;

      -- Reached only when nothing refused the repair's own unpermitted write.
      raise exception 'HONE_0205_GUARD_NOT_POLICING';
    exception
      when check_violation then
        v_guard_policed := true;
      when others then
        if sqlerrm = 'HONE_0205_GUARD_NOT_POLICING' then
          v_guard_policed := false;
        else
          -- Any other failure is real and must not be swallowed by a probe.
          raise;
        end if;
    end;

    if not v_guard_policed then
      -- pg_trigger is read HERE, and only here: DIAGNOSTIC context for the
      -- operator, never the gate. The gate is the behaviour above.
      select format(
               'trigger %s: function=%s tgtype=%s tgenabled=%s columns=%s when_clause=%s',
               coalesce(t.tgname, '<absent>'),
               coalesce(t.tgfoid::regprocedure::text, '<none>'),
               coalesce(t.tgtype::text, '-'),
               coalesce(t.tgenabled::text, '-'),
               coalesce(t.tgattr::text, '<all>'),
               case when t.tgqual is null then 'none' else 'present' end)
        into v_guard_diag
        from pg_trigger t
       where t.tgrelid = 'public.studios'::regclass
         and t.tgname = 'studios_admission_mode_guard'
         and not t.tgisinternal;

      raise exception
        '0205: the repair''s own UNPERMITTED write to '
        'new_client_admission_mode_set_at on studio % was NOT refused, so that '
        'write is not being policed and the repair would proceed unguarded. '
        'Diagnostic: %. Session replication role: %.',
        r.id,
        coalesce(v_guard_diag, 'no studios_admission_mode_guard trigger on public.studios'),
        current_setting('session_replication_role');
    end if;

    perform set_config('hone.admission_mode_studio_id', r.id::text, true);
    -- set_at = created_at, NOT now(): the row's admission authority was
    -- initialized when the studio was created, which is what 0205's default
    -- records for every studio created after this. Backfilling `now()` would
    -- date the initialization to the apply instead.
    --
    -- This is the ONLY use of created_at, and it is a VALUE not a VERDICT - the
    -- eligibility decision above reads ids only, because created_at is mutable.
    update public.studios s
       set new_client_admission_mode_set_at = r.created_at
     where s.id = r.id
       and s.new_client_admission_mode_set_at is null;
    v_repaired := v_repaired + 1;
  end loop;

  -- Clear the permit. Transaction-local anyway, but leaving the last row's id
  -- armed would let a later statement in this transaction write that one row's
  -- admission fields without asking.
  perform set_config('hone.admission_mode_studio_id', '', true);

  -- FAIL CLOSED #4: the post-condition. If anything in scope is still NULL the
  -- repair did not do what it claims, and the whole migration must abort rather
  -- than commit a half-repair.
  select count(*)
    into v_left
    from public.studios s
   where s.new_client_admission_mode_set_at is null
     and s.new_client_admission_mode_set_by is null
     and s.new_client_admission_mode = 'open'
     and not (s.id = any (k_census));
  if v_left <> 0 then
    raise exception
      '0205: % non-census studio(s) still carry a null set_at after the repair',
      v_left;
  end if;

  raise notice '0205: apply-time repair stamped % studio(s)', v_repaired;
end
$repair$;
-- <<< 0205 APPLY-TIME REPAIR END

commit;
