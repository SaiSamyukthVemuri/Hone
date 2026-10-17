-- ===========================================================================
-- 0198 — THE PRACTITIONER CAN SEE WHICH INVITATION CYCLE IS CURRENT
-- ===========================================================================
--
-- WAIT-LIVE-READ-01 (S6). One grant. Nothing else.
--
-- THE DEFECT. Liveness for an invitation is defined by 0192's own index:
--
--   new_client_waitlist_invitations_one_live_per_entry
--     on (entry_id)
--     where redeemed_at is null and expired_at is null
--       and released_at  is null and declined_at is null
--
-- An authenticated studio owner can read three of those four terms.
-- `declined_at` was added by 0192 and granted to nobody, so touching it raises
-- 42501 and the practitioner surface cannot evaluate the predicate the database
-- uses. The consequence is not cosmetic: a DECLINED invitation is
-- indistinguishable from a LIVE one, so an entry carrying declined-A plus live-B
-- cannot be resolved to its current cycle, and the row's controls are decided
-- from an incomplete answer.
--
-- IT IS A MISSING TERM, NOT A MISSING ROW. No query over the eleven currently
-- readable columns can reconstruct it, which is why this needs a privilege
-- change rather than better SQL.
--
-- WHY THIS DOES NOT CROSS THE PROTECTED-COLUMN BOUNDARY. 0188 introduced the
-- column-level model for a specific reason it states plainly: a table-wide grant
-- had returned `token_hash` — the 64-character credential verifier — to an
-- authenticated session. The withheld set is credential and authority material:
-- `token_hash`, the `proof_*` challenge and capability fields, and the `scope_*`
-- offer terms.
--
-- `declined_at` is none of those. It is a lifecycle timestamp of exactly the
-- same class as `redeemed_at`, `expired_at` and `released_at`, all three of
-- which 0188 already grants. Its absence reads as an oversight when 0192 added
-- the column without revisiting the grant, not as a deliberate secret — and the
-- three timestamps beside it are the proof of that class.
--
-- WHAT THIS IS NOT. No new column, table, function, policy, index or trigger.
-- No SELECT *, no table-wide SELECT, no widening for `anon` or `service_role`,
-- no service-role direct table read, no browser-executable mutation, and no
-- change to any historical migration. `admission_round_id` and every `scope_*`
-- column stay withheld: they were not required to evaluate liveness and nothing
-- here proves they should be.
--
-- OWNER RLS IS UNCHANGED AND STILL DECIDES WHICH ROWS.
-- `new_client_waitlist_invitations_owner_select` -> `is_studio_owner(studio_id)`
-- is untouched, so this widens WHAT an owner may read about their own studio's
-- rows and nothing whatever about WHOSE rows they are.
-- ===========================================================================

begin;

set local lock_timeout = '5s';

grant select (declined_at)
  on public.new_client_waitlist_invitations to authenticated;

commit;
