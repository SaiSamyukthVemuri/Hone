-- ---------------------------------------------------------------------------
-- Migration 0162: an intake can only become 'reviewed' from a genuinely
-- SUBMITTED row, reviewed by the caller's own active practitioner in that
-- studio, at a timestamp the DATABASE stamps.
--
-- Closes the database half of F-CLIN-004. PR #497 closed the application and UI
-- half (deployed at b7d85f5) — this closes the direct-PostgREST half.
--
-- DEPENDS ON: migration 0118 (intake terminal immutability). This migration
-- REPLACES its function body; it does not add a competing second trigger.
--
-- ===========================================================================
-- THE DEFECT (reproduced on a CI-parity database as the `authenticated`
-- browser role with a real studio-member JWT)
-- ===========================================================================
--
--   update public.client_intake_forms
--      set status = 'reviewed', reviewed_at = now(), reviewed_by = <me>
--    where id = <an intake still in_progress>;
--   -- => UPDATE 1, with submitted_at still NULL.
--
-- Root cause: every review check added by 0118 is nested inside
--
--   if old.status in ('submitted', 'reviewed') then ...
--
-- An OLD row that is still 'in_progress' never enters that block, so the
-- INCOMING transition to 'reviewed' was completely unguarded. The result is a
-- clinical record marked "reviewed" for an intake the client never submitted —
-- whose allergy / EpiPen answers may be blank — which also silences the
-- dashboard, daily-prep and calendar review prompts.
--
-- ===========================================================================
-- WHAT THIS MIGRATION ADDS
-- ===========================================================================
-- A new FIRST section that runs for EVERY caller (see the service-role note
-- below) on any UPDATE where
--
--   new.status = 'reviewed'  AND  old.status is distinct from 'reviewed'
--
-- and requires ALL of:
--
--   1. old.status = 'submitted'                  (no in_progress -> reviewed)
--   2. old.submitted_at is not null              (a real submission exists)
--   3. new.submitted_at is not distinct from old.submitted_at
--                                                (same statement may not forge it)
--   4. new.reviewed_by is not null               (the reviewer is named)
--   5. new.reviewed_by is an ACTIVE practitioner row whose user_id = auth.uid()
--      AND whose studio_id = old.studio_id       (right person, right studio)
--   6. new.reviewed_at is stamped BY THE DATABASE, not by the caller.
--
-- Plus THREE hardenings inside the existing end-user section, numbered here in
-- the order they appear in the body:
--
--   7. once reviewed, the status is TERMINAL for end users. 0118 blocked only
--      the regression to 'in_progress', which left `reviewed -> submitted`
--      open. That was a two-step attribution-laundering path: step one drops
--      back to 'submitted' while keeping the original reviewed_by/reviewed_at
--      (0118's attribution check only fires when those VALUES change), then
--      step two re-reviews and legitimately re-stamps the attacker as
--      reviewer. Blocking any regression out of 'reviewed' closes it.
--   9. ONLY THE CLIENT MAY SUBMIT. Without this rule the six checks above are
--      bypassable in TWO statements and this whole migration is defeated:
--      statement one forges `status='submitted', submitted_at=now()`, and
--      statement two then reviews it — step one manufactures exactly the
--      evidence step two checks. Found by the adversarial pass and reproduced
--      end-to-end as `authenticated` on a CI-parity database. Safe to enforce
--      because `status: "submitted"` is written in exactly ONE place in the
--      repository — the public tokenized route, which runs as service role and
--      is exempt via the early return.
--   8. review metadata may not be attached to a row that is not reviewed. A
--      studio member could otherwise set reviewed_by/reviewed_at on a
--      'submitted' or 'in_progress' row without ever setting status, which is
--      exactly the `in_progress with review metadata` inconsistency the
--      production audit query looks for.
--
-- (The numbering is historical: (9) was added after (8) when the adversarial
-- pass found the two-statement bypass, and the identifiers are kept stable
-- because the DB and behavioural suites name them.)
--
-- ===========================================================================
-- reviewed_at: THE DATABASE IS NOW AUTHORITATIVE
-- ===========================================================================
-- A non-null check is not enough: direct PostgREST can send ANY timestamp, so
-- `reviewed_at` could be backdated to before the client even submitted, or
-- placed in the future. Rather than police the value with a tolerance window
-- (which would make legitimate reviews fail on ordinary clock skew between the
-- Next server and Postgres), the trigger OVERWRITES it:
--
--   new.reviewed_at := transaction_timestamp();
--
-- This is safe for the DEPLOYED application. `markIntakeReviewedAction`
-- (app/(app)/clients/[id]/intake/actions.ts, shipped in PR #497) sends its own
-- `reviewed_at` but selects back only `id, client_id` — it never reads or
-- asserts the value it sent. The page re-reads the row from the server after
-- `router.refresh()`, so the practitioner always sees the DB-stamped time.
-- From this migration on, the review timestamp is a database fact, not a
-- client assertion.
--
-- ===========================================================================
-- SERVICE ROLE (auth.uid() IS NULL): REVIEW TRANSITIONS ARE REJECTED
-- ===========================================================================
-- 0118 exempts every `auth.uid() is null` write as a trusted admin path. That
-- blanket exemption is NOT preserved for the incoming review transition,
-- because a caller audit found no legitimate runtime path that needs it:
--
--   * `status: "reviewed"` is written in exactly ONE place in the whole
--     repository — app/(app)/clients/[id]/intake/actions.ts, which uses the
--     RLS-scoped client (createClient), i.e. an authenticated caller.
--   * Every service-role intake writer does something else: the public token
--     route (app/intake/[token]/actions.ts) performs in_progress -> submitted
--     guarded by `.eq("status","in_progress")`; lib/intake/queries.ts inserts
--     new rows and stamps link metadata; the reminder cron only reads.
--
-- Section 1 therefore runs before the `auth.uid() is null` early return, and
-- its reviewer predicate requires a non-null auth.uid(). A service-role caller
-- cannot satisfy it, so a service-role review transition FAILS CLOSED. Every
-- other trusted service-role write (submission, inserts, link metadata,
-- backfills) is untouched and still exempt from the 0118 end-user rules.
--
-- ===========================================================================
-- SAFETY
-- ===========================================================================
--   * NO schema change: no table, column, constraint, index, policy or grant.
--   * NO data change, NO backfill, NO deletion. BEFORE UPDATE only, so it can
--     only affect FUTURE updates; every existing row is untouched.
--   * The trigger NAME and its attachment are unchanged; only the function body
--     is replaced (CREATE OR REPLACE), so there is no window with no trigger.
--   * SECURITY INVOKER and `set search_path = ''` are preserved. The reviewer
--     lookup reads public.practitioners under the CALLER's RLS, which can see
--     the caller's own studio rows — the same model 0118 used.
--   * Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS +
--     CREATE TRIGGER replays cleanly on a fresh database.
--   * Lock footprint: CREATE OR REPLACE FUNCTION takes no table lock; the
--     trigger re-create briefly needs ACCESS EXCLUSIVE on
--     public.client_intake_forms, which is why lock_timeout is armed below.
--
-- WHY THIS FILE OPENS ITS OWN TRANSACTION (0159/0160/0161 precedent)
-- `supabase db push --linked` does NOT wrap a migration file in an explicit
-- transaction. A bare `SET LOCAL lock_timeout` therefore emits
-- `WARNING (25P01): SET LOCAL can only be used in transaction blocks` and
-- silently NEVER ARMS, and the file is not atomic. This file opens the
-- transaction itself so the timeout genuinely arms and the whole migration
-- commits or rolls back as one unit. If the lock cannot be taken within 5s the
-- statement fails with 55P03, COMMIT is never reached, and the PREVIOUS 0118
-- function and trigger remain in place unchanged.
--
-- Every statement below is legal inside a transaction block.
--
-- Migration max 0161 -> 0162.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

create or replace function public.enforce_intake_terminal_immutability()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_reviewer_ok boolean;
begin
  -- =========================================================================
  -- 1. INCOMING REVIEW TRANSITION (0162).
  --
  -- Deliberately placed BEFORE the `auth.uid() is null` early return, so it
  -- binds service-role callers too. See the header: no legitimate runtime
  -- service-role path marks an intake reviewed, so this fails closed.
  -- =========================================================================
  if new.status = 'reviewed' and old.status is distinct from 'reviewed' then

    -- (1) Only a SUBMITTED intake may be reviewed. This is the check 0118
    --     never reached for an in_progress OLD row.
    if old.status <> 'submitted' then
      raise exception
        'An intake can only be marked reviewed after the client submits it.'
        using errcode = 'check_violation';
    end if;

    -- (2) A submitted row must carry its submission timestamp. Guards the
    --     forged-status case (status flipped to 'submitted' with no
    --     submitted_at) from being laundered into a review.
    if old.submitted_at is null then
      raise exception
        'An intake cannot be marked reviewed without a recorded submission.'
        using errcode = 'check_violation';
    end if;

    -- (3) The reviewing statement may not also rewrite the submission time.
    if new.submitted_at is distinct from old.submitted_at then
      raise exception 'submitted_at is immutable after submission.'
        using errcode = 'check_violation';
    end if;

    -- (4) The reviewer must be named.
    if new.reviewed_by is null then
      raise exception
        'A reviewed intake must record the reviewing practitioner.'
        using errcode = 'check_violation';
    end if;

    -- (5) The reviewer must be an ACTIVE practitioner, linked to the CALLING
    --     user, IN THE INTAKE'S OWN STUDIO. Checking only
    --     `user_id = auth.uid() and active` (as 0118 did) is insufficient:
    --     public.practitioners is unique on (studio_id, user_id), so one user
    --     can hold practitioner rows in several studios, and a row from
    --     ANOTHER studio would otherwise pass.
    --
    --     SCOPE NOTE on `p.active`: it is defence-in-depth and is NOT
    --     independently reachable today. UNIQUE (studio_id, user_id) means a
    --     caller owns at most one practitioner row per studio, and
    --     public.is_studio_member() already requires active = true — so the
    --     caller's own row is either active (predicate trivially true) or the
    --     whole row is filtered out by RLS before this trigger runs. It is kept
    --     so the guard does not silently weaken if is_studio_member() ever
    --     stops requiring active.
    select exists (
      select 1
        from public.practitioners p
       where p.id = new.reviewed_by
         and p.active = true
         and p.studio_id = old.studio_id
         and p.user_id = auth.uid()
    ) and auth.uid() is not null
    into v_reviewer_ok;

    if not v_reviewer_ok then
      raise exception 'reviewed_by must be the reviewing practitioner.'
        using errcode = 'check_violation';
    end if;

    -- (6) The DATABASE stamps the review time. Whatever the caller sent —
    --     backdated, future, or null — is discarded. See the header for why
    --     this is preferred over a tolerance window and why it is compatible
    --     with the deployed application.
    new.reviewed_at := transaction_timestamp();
  end if;

  -- =========================================================================
  -- 2. END-USER TERMINAL IMMUTABILITY (0118, preserved verbatim, plus three
  --    0162 hardenings: (7), (9), (8) in that order).
  --
  -- Service-role / admin paths (no JWT) remain trusted and exempt HERE: they
  -- legitimately perform the client's in_progress -> submitted transition,
  -- insert new intake rows, and stamp link metadata.
  -- =========================================================================
  if auth.uid() is null then
    return new;
  end if;

  -- 0162 hardening (7): once reviewed, the status is terminal for end users.
  -- 0118 blocked only `new.status = 'in_progress'`, leaving
  -- `reviewed -> submitted` open as a two-step attribution-laundering path.
  if old.status = 'reviewed' and new.status is distinct from 'reviewed' then
    raise exception 'A reviewed intake cannot return to an earlier state.'
      using errcode = 'check_violation';
  end if;

  -- 0162 hardening (9) — THE SUBMISSION IS THE CLIENT'S, NOT THE STUDIO'S.
  --
  -- Without this, section 1 above is bypassable in TWO statements and the whole
  -- migration is defeated:
  --
  --   1. update ... set status='submitted', submitted_at=now()   -- forged
  --   2. update ... set status='reviewed',  reviewed_by=<self>   -- now "valid"
  --
  -- Step 2 satisfies every predicate in section 1 because step 1 manufactured
  -- the evidence it checks. Reproduced end-to-end as `authenticated` on a
  -- CI-parity database before this rule was added.
  --
  -- Only the CLIENT submits an intake, through the public tokenized route
  -- (app/intake/[token]/actions.ts), which runs as SERVICE ROLE and is exempt
  -- via the early return above. `status: "submitted"` is written in exactly one
  -- place in the repository, and it is that route. No authenticated studio
  -- member ever performs in_progress -> submitted, so this fails closed.
  if new.status = 'submitted' and old.status is distinct from 'submitted' then
    raise exception 'Only the client can submit their own intake.'
      using errcode = 'check_violation';
  end if;

  -- 0162 hardening (8): review metadata belongs only to a reviewed row. Stops
  -- a member attaching reviewed_by / reviewed_at to an in_progress or
  -- submitted intake without ever setting status — the exact
  -- "review metadata on a non-reviewed row" inconsistency the production audit
  -- query screens for. Scoped to CHANGES, so historical rows are untouched.
  if new.status <> 'reviewed'
     and (
       new.reviewed_by is distinct from old.reviewed_by
       or new.reviewed_at is distinct from old.reviewed_at
     ) then
    raise exception
      'Review metadata can only be recorded when an intake is marked reviewed.'
      using errcode = 'check_violation';
  end if;

  if old.status in ('submitted', 'reviewed') then
    if new.responses is distinct from old.responses then
      raise exception
        'Submitted intake answers are immutable; create a new intake to amend.'
        using errcode = 'check_violation';
    end if;

    if new.submitted_at is distinct from old.submitted_at then
      raise exception 'submitted_at is immutable after submission.'
        using errcode = 'check_violation';
    end if;

    if new.status = 'in_progress' then
      raise exception
        'A submitted or reviewed intake cannot be reverted to draft.'
        using errcode = 'check_violation';
    end if;

    -- Marking reviewed: the reviewer must be one of the caller's OWN active
    -- practitioners (server-derived actor), never a foreign practitioner.
    -- Section 1 above now enforces a strictly stronger form of this for the
    -- incoming transition; this is retained so the 0118 contract is preserved
    -- for every other shape of update.
    if new.status = 'reviewed'
       and new.reviewed_by is distinct from old.reviewed_by
       and (
         new.reviewed_by is null
         or new.reviewed_by not in (
           select id from public.practitioners
           where user_id = auth.uid() and active = true
         )
       ) then
      raise exception 'reviewed_by must be the reviewing practitioner.'
        using errcode = 'check_violation';
    end if;

    -- Once reviewed, the review attribution (who + when) is immutable.
    if old.status = 'reviewed'
       and (
         new.reviewed_by is distinct from old.reviewed_by
         or new.reviewed_at is distinct from old.reviewed_at
       ) then
      raise exception 'Review attribution is immutable once reviewed.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

-- Re-assert the trigger. The NAME and shape are identical to 0118; this keeps
-- the migration replayable on a fresh database without leaving a window in
-- which the table has no guard.
drop trigger if exists client_intake_forms_terminal_immutability
  on public.client_intake_forms;

create trigger client_intake_forms_terminal_immutability
  before update on public.client_intake_forms
  for each row
  execute function public.enforce_intake_terminal_immutability();

commit;

-- ---------------------------------------------------------------------------
-- READ-ONLY PRE-APPLY AUDIT (counts only; no ids, no answers, no notes).
-- Re-run these against production immediately BEFORE applying this migration.
-- Zero rows does not replace the guard — it only confirms the defect has not
-- been exercised yet.
--
--   select s.name as studio,
--          count(*) filter (where f.status='reviewed' and f.submitted_at is null) as reviewed_no_submission,
--          count(*) filter (where f.status='reviewed' and f.reviewed_at  is null) as reviewed_no_time,
--          count(*) filter (where f.status='reviewed' and f.reviewed_by  is null) as reviewed_no_actor,
--          count(*) filter (where f.status='in_progress'
--                             and (f.reviewed_at is not null or f.reviewed_by is not null))
--            as draft_with_review_metadata
--     from public.client_intake_forms f
--     join public.studios s on s.id = f.studio_id
--    where f.deleted_at is null
--    group by s.name
--    order by s.name;
--
-- This migration changes no existing row, so a non-zero count is NOT corrected
-- by applying it. Any inconsistent row must be reconciled with the
-- practitioner as a separate, explicitly authorized decision — never silently
-- downgraded, which would itself be an unattributed clinical-record edit.
-- ---------------------------------------------------------------------------
