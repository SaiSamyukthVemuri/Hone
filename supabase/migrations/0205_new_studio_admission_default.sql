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
-- ZERO DML. A read-only census of the canonical production project immediately
-- before authoring found 7 studios, 5 of them carrying mode='open' with
-- set_at NULL, and the NEWEST studio created 2026-09-19 - more than a week
-- BEFORE 0203 was applied (2026-09-27), and 0204 was applied after 0203. So
-- every NULL row demonstrably predates the 0204 apply boundary and is a genuine
-- legacy row that MUST stay NULL. No studio qualified for repair, so this
-- migration repairs nothing: there is no UPDATE here, and therefore no need for
-- the row-scoped admission permit either. The guard is honoured by never being
-- engaged.
--
-- STATEMENT INVENTORY, for the apply record: ONE `alter table ... alter column
-- ... set default`, TWO `comment on column`. No table created or dropped, no
-- column added or dropped, no index, no constraint, no function, no trigger, no
-- grant, and no insert/update/delete/truncate anywhere in the file.
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

commit;
