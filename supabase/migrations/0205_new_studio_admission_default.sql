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
-- THIS MUST NOT BACKFILL, AND CANNOT.
-- `ALTER TABLE ... ALTER COLUMN ... SET DEFAULT` records a default for FUTURE
-- inserts only; it never rewrites an existing row. That is the whole reason the
-- fix is spelled this way rather than as `ADD COLUMN ... DEFAULT` (which in
-- PostgreSQL 11+ does populate existing rows) or as an UPDATE. Every pre-fix
-- studio keeps `set_at` NULL and keeps its legacy semantics.
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
-- HOW "PROVABLY CREATED AFTER 0204" IS ESTABLISHED, since the database cannot
-- answer it directly: `supabase_migrations.schema_migrations` carries only
-- (version, statements, name) and has NO timestamp column, so there is no
-- server-side 0204 apply instant to compare against.
--
-- The census supplies the proof instead. It was taken when
-- `max(version)` was ALREADY `0204` - so 0204 was applied - and it enumerated
-- EVERY studio, the newest created 2026-09-19T20:13:50.840921Z. A row with
-- `created_at` STRICTLY GREATER than that therefore did not exist at a moment
-- when 0204 was already applied, which means it was created after 0204. The
-- comparison is strict so the boundary row itself - the real 2026-09-19 legacy
-- studio - stays NULL.
--
-- FAIL-CLOSED IN THE DIRECTION THAT MATTERS. The two errors are not
-- symmetrical. Leaving a window row NULL reproduces the bug: a spurious
-- ceremony, annoying and safe. Wrongly stamping a GENUINE legacy row skips a
-- cutover that exists because the legacy email-only join path cannot be made
-- atomic - a correctness risk. So the repair writes ONLY what it can prove, and
-- section 3 refuses to run at all if the data does not match its model.
--
-- A BACKDATED `created_at` makes the predicate UNDER-repair, never over-repair:
-- the row looks older, falls below the boundary, and is left alone. That is the
-- safe direction, and it is why the boundary is compared against `created_at`
-- rather than anything the row could have been given later.
--
-- STATEMENT INVENTORY, for the apply record: ONE `alter table ... alter column
-- ... set default`, TWO `comment on column`, and ONE `do` block whose only
-- write is a bounded `update public.studios` over the window set defined above.
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
-- Scope: studios PROVABLY created after 0204 (see the header) that are still
-- unstamped. Everything else is untouched - every row at or below the boundary,
-- and every row an owner has already stamped.
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
  -- The census boundary, with its provenance in the header. Strictly greater:
  -- the boundary row IS a real legacy studio and must keep its NULL.
  k_boundary constant timestamptz := '2026-09-19T20:13:50.840921+00';
  r              record;
  v_anomalous    integer;
  v_repaired     integer := 0;
  v_left         integer;
begin
  -- FAIL CLOSED #1: the guard must be present. If it is absent this migration
  -- would be writing admission fields with nothing policing the write, which is
  -- precisely the state 0204 created the guard to prevent.
  if not exists (
    select 1
      from pg_trigger t
     where t.tgrelid = 'public.studios'::regclass
       and t.tgname = 'studios_admission_mode_guard'
       and not t.tgisinternal
  ) then
    raise exception
      '0205: studios_admission_mode_guard is absent; refusing to write admission fields';
  end if;

  -- FAIL CLOSED #2: the window must look the way the model says it looks. An
  -- unstamped row above the boundary that is NOT a plain system default - a mode
  -- other than open, or an actor already recorded - means the model is wrong,
  -- and writing under a wrong model is the thing being guarded against.
  select count(*)
    into v_anomalous
    from public.studios s
   where s.new_client_admission_mode_set_at is null
     and s.created_at > k_boundary
     and (s.new_client_admission_mode <> 'open'
          or s.new_client_admission_mode_set_by is not null);
  if v_anomalous <> 0 then
    raise exception
      '0205: % unstamped studio(s) above the 0204 boundary do not match the '
      'system-default shape (mode=open, set_by null); refusing to repair',
      v_anomalous;
  end if;

  for r in
    select s.id, s.created_at
      from public.studios s
     where s.new_client_admission_mode_set_at is null
       and s.new_client_admission_mode_set_by is null
       and s.new_client_admission_mode = 'open'
       and s.created_at > k_boundary
     order by s.id
       for update
  loop
    perform set_config('hone.admission_mode_studio_id', r.id::text, true);
    -- set_at = created_at, NOT now(): the row's admission authority was
    -- initialized when the studio was created, which is what 0205's default
    -- records for every studio created after this. Backfilling `now()` would
    -- date the initialization to the apply instead.
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

  -- FAIL CLOSED #3: the post-condition. If anything in scope is still NULL the
  -- repair did not do what it claims, and the whole migration must abort rather
  -- than commit a half-repair.
  select count(*)
    into v_left
    from public.studios s
   where s.new_client_admission_mode_set_at is null
     and s.new_client_admission_mode_set_by is null
     and s.new_client_admission_mode = 'open'
     and s.created_at > k_boundary;
  if v_left <> 0 then
    raise exception
      '0205: % studio(s) created after the 0204 boundary still carry a null '
      'set_at after the repair', v_left;
  end if;

  raise notice '0205: apply-time repair stamped % studio(s)', v_repaired;
end
$repair$;
-- <<< 0205 APPLY-TIME REPAIR END

commit;
