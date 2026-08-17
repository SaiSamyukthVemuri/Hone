-- ===========================================================================
-- CLIENT BUDGET CONTEXT — LEAST PRIVILEGE REPAIR — 0184
-- ===========================================================================
--
-- THE DEFECT. 0183 stated its privilege contract as "authenticated gets
-- SELECT, INSERT and UPDATE, and nothing else", and enforced it by GRANTing
-- those three and REVOKEing the two it happened to name:
--
--   grant select, insert, update ... to authenticated;
--   revoke delete, truncate ... from authenticated;   -- <- an ALLOWLIST of
--                                                     --    things to remove
--
-- That is a denylist wearing an allowlist's clothes. Supabase's
-- ALTER DEFAULT PRIVILEGES grants the FULL set at create time, so naming two
-- privileges to remove leaves every unnamed one in place. The production
-- schema dump after the 0183 apply reads:
--
--   GRANT SELECT,INSERT,REFERENCES,TRIGGER,MAINTAIN,UPDATE
--     ON TABLE public.client_budget_context TO authenticated;
--
-- REFERENCES, TRIGGER and MAINTAIN were never intended. MAINTAIN in
-- particular could not have been anticipated by name-and-revoke: it is a
-- PostgreSQL 17 privilege that simply appeared in the default set.
--
-- This is the SAME root cause CLAUDE.md already records for 0129 (`anon`
-- missed) and 0164 (`service_role` missed) — enumerating what to take away
-- instead of declaring what to leave. 0184 stops enumerating: it revokes
-- EVERYTHING and then grants back exactly the intended three, so a future
-- PostgreSQL release that invents another privilege cannot silently land in
-- this table's ACL.
--
-- MEASURED, NOT ASSUMED. Against the real migrated database the ACL is
-- `authenticated=arwxtm/postgres` — a=INSERT r=SELECT w=UPDATE x=REFERENCES
-- t=TRIGGER m=MAINTAIN. PUBLIC holds zero entries and anon/service_role are
-- absent, so 0183's explicit by-name revokes for those two roles DID work;
-- only the authenticated allowlist was incomplete.
--
-- EXPLOITABILITY, measured as `authenticated` on the real database:
--   TRIGGER   EXERCISABLE. `create trigger ... on public.client_budget_context`
--             SUCCEEDS with TRIGGER + function EXECUTE; ownership is required
--             only to DROP one. A member could attach an existing trigger
--             function to this table and disrupt writes to it. This is the
--             finding that makes the repair worth a migration rather than a
--             note.
--   MAINTAIN  EXERCISABLE. `analyze public.client_budget_context` succeeds.
--             No data is exposed; it is unintended authority, not a leak.
--   REFERENCES  Granted but NOT reachable today: creating the referencing
--             table needs CREATE on schema public, which is denied. Revoked
--             anyway — "unreachable because of a second control" is not a
--             contract.
--
-- THE TRIGGER FUNCTIONS. 0183's three new functions were left with EXECUTE to
-- PUBLIC *and* explicitly to anon, authenticated and service_role (the
-- create-time default). They cannot be called as RPCs — PostgreSQL refuses
-- with "trigger functions can only be called as triggers", verified — so this
-- is defence in depth rather than a closed hole. It is still wrong to
-- advertise them on the API surface, and REVOKING EXECUTE DOES NOT AFFECT
-- TRIGGER FIRING: the trigger mechanism does not check EXECUTE at fire time.
-- Proven before writing this file by revoking all four grantees on the real
-- database and re-running the full 47-test behavioural suite — every studio
-- derivation, timestamp, immutability, set_updated_at and actor-RLS test
-- still passed.
--
-- public.set_updated_at() carries the same permissive default, and is
-- DELIBERATELY NOT TOUCHED HERE: it is a shared helper used by many tables
-- since 0015, so changing it belongs to its own change with its own blast
-- radius, not to a budget-context repair.
--
-- 0183 IS APPLIED TO PRODUCTION AND IS FROZEN. It is not edited, and this
-- file does not restate its schema. 0184 is GRANT/REVOKE only: no DDL, no
-- policy change, no constraint change, no trigger change, and ZERO business
-- rows touched.
--
-- Re-runnable: revoke/grant are idempotent.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- TABLE
-- ---------------------------------------------------------------------------
-- REVOKE ALL first, then grant back precisely. `all` is deliberate: it covers
-- MAINTAIN and any privilege a future PostgreSQL adds, neither of which can be
-- written into a by-name revoke list today. PUBLIC is included even though it
-- currently holds nothing, so the statement expresses the whole contract
-- rather than the delta that happens to be needed right now.
revoke all on public.client_budget_context
  from public, anon, authenticated, service_role;

-- The entire intended contract, in one place:
--   authenticated  SELECT + INSERT + UPDATE, all RLS-gated by 0183's policies
--   anon           nothing (never reachable from a client-facing surface)
--   service_role   nothing (no server path uses an admin client here)
--   PUBLIC         nothing
-- No DELETE: clearing a budget is an UPDATE to NULL/'' by design, so there is
-- no delete route to grant.
grant select, insert, update on public.client_budget_context to authenticated;

-- ---------------------------------------------------------------------------
-- TRIGGER FUNCTIONS
-- ---------------------------------------------------------------------------
-- Only the three functions 0183 introduced. Each is SECURITY INVOKER and
-- `returns trigger`, so it can only ever run as a trigger; EXECUTE on it grants
-- nothing callable. Revoked so the API surface states that fact.
revoke all privileges on function public.client_budget_context_set_studio_id()
  from public, anon, authenticated, service_role;

revoke all privileges on function public.client_budget_context_immutable_fields()
  from public, anon, authenticated, service_role;

revoke all privileges on function public.client_budget_context_server_timestamps()
  from public, anon, authenticated, service_role;

-- NOTHING ELSE. An earlier revision of this file also carried a
-- `comment on table` restating the privilege contract. It was removed: this
-- migration declares itself GRANT/REVOKE only, and COMMENT ON writes to
-- pg_description — schema metadata, however harmless. A migration whose
-- header claims "no DDL" must contain no DDL, and the contract belongs in
-- this header and in the tests, not in a statement that widens the file's
-- executable footprint past its own stated scope.
--
-- tests/migrations/0184-client-budget-context-least-privilege.test.ts enforces
-- that with a POSITIVE allowlist of executable statements rather than a list
-- of forbidden keywords. The denylist is what let the COMMENT through: it
-- enumerated CREATE/ALTER/DROP and simply did not think of COMMENT — the same
-- enumerate-what-to-exclude mistake this very migration exists to repair at
-- the privilege layer.

commit;
