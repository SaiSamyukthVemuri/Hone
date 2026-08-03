-- ---------------------------------------------------------------------------
-- 0169 — L18 FINAL: revoke direct authenticated DML on the clinical tables
--
-- WHAT THIS CLOSES
-- ===========================================================================
-- L18 has been open since the original audit found 25 direct runtime writers
-- against the clinical tables. Migrations 0164/0165 (laser entries), 0166
-- (session blocks + electrolysis entries), 0167 (sessions) and 0168
-- (treatment images) moved every one of them behind narrow, fixed-purpose
-- SECURITY DEFINER commands, and each of those migrations was deliberately
-- ADDITIVE — nothing was revoked, so the deployed application kept working
-- throughout.
--
-- This migration is the cutover. It removes the capability itself.
--
-- Verified before writing (statement-chain accurate, reads NOT counted):
--
--   sessions              0 writers   (36 read-only chains)
--   session_blocks        0 writers   (27 read-only chains)
--   session_block_areas   0 writers   ( 5 read-only chains)
--   electrolysis_entries  0 writers   ( 5 read-only chains)
--   laser_entries         0 writers   ( 2 read-only chains)
--   treatment_images      0 writers   ( 2 read-only chains)
--
-- Every clinical write now goes through a command, and every command is
-- `authenticated`-EXECUTE only with `anon` and `service_role` denied.
--
-- WHY session_block_areas IS LISTED EVEN THOUGH IT CHANGES NOTHING
-- ===========================================================================
-- Measured in production before writing this: `session_block_areas` already has
-- NO authenticated INSERT/UPDATE/DELETE grant — only SELECT. Its revocation
-- below is therefore a NO-OP today, and it is included deliberately: it makes
-- the intended posture explicit for all six tables in one auditable place, and
-- a future grant on that table would have to actively contradict this file.
-- REVOKE of a privilege that was never granted is not an error.
--
-- The other five DO have authenticated write grants today:
--   sessions              INSERT, UPDATE, DELETE
--   session_blocks        INSERT, UPDATE, DELETE
--   electrolysis_entries  INSERT, UPDATE
--   laser_entries         INSERT, UPDATE
--   treatment_images      INSERT, UPDATE
-- Naming DELETE on all six is intentional and idempotent: it guarantees the
-- posture regardless of which subset happens to be granted at apply time.
--
-- WHAT THIS DOES NOT TOUCH
-- ===========================================================================
-- * authenticated SELECT is RETAINED on every table — reads, listings and
--   signed-URL lookups are unaffected. This migration contains no SELECT
--   revocation.
-- * service_role and anon privileges are unchanged. PUBLIC holds no grant on
--   any of these tables (measured: 0), and is not mutated here.
-- * No function EXECUTE grant or revocation. The commands are untouched.
-- * No policy, trigger, constraint, column, index, table, ownership, storage
--   permission or data change. There is not a single GRANT statement in this
--   file and nothing here writes a row.
-- * Retired finalization, the immutable legacy artifact and the editability of
--   current records through the commands are all unaffected — they are enforced
--   by triggers and by the commands, neither of which changes here.
--
-- REVOKE ALL is deliberately NOT used: it would take SELECT with it, and it
-- would silently absorb any future privilege type rather than naming exactly
-- the three this cutover is about.
--
-- ROLLBACK
-- ===========================================================================
-- If this must be reversed, the reversal is a NEW migration that re-grants
-- INSERT, UPDATE, DELETE to authenticated on the affected tables. Do not edit
-- this file after it is applied.
--
-- Own transaction + armed lock_timeout: `supabase db push` does not wrap a
-- migration file in a transaction, so a bare SET LOCAL emits 25P01 and never
-- arms (the 0159 lesson).
--
-- Migration max 0168 -> 0169.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

revoke insert, update, delete on table public.sessions from authenticated;
revoke insert, update, delete on table public.session_blocks from authenticated;
revoke insert, update, delete on table public.session_block_areas from authenticated;
revoke insert, update, delete on table public.electrolysis_entries from authenticated;
revoke insert, update, delete on table public.laser_entries from authenticated;
revoke insert, update, delete on table public.treatment_images from authenticated;

commit;
