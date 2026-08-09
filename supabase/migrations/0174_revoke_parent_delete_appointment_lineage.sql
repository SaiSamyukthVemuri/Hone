-- ---------------------------------------------------------------------------
-- 0174 — APPOINTMENT BOUNDARY B4 companion: close L23
--        (FK referential actions reaching appointments through parent deletes)
--
-- WHAT L23 IS
-- ===========================================================================
-- 0172 revoked direct anon/authenticated INSERT/UPDATE/DELETE on
-- `public.appointments`. It closed DIRECT DML and said so explicitly, and it
-- recorded — in its own header (0172:220-247) and in
-- docs/production/known-limitations.md — the edge it did NOT close:
--
--   A referential action runs as the CONSTRAINT's owner and consults neither
--   the table ACL nor RLS (`appointments` is not FORCE RLS). So deleting a
--   PARENT row still writes `appointments` for a caller holding no privilege
--   on `appointments` whatsoever.
--
-- Two such paths were reachable from a browser after 0172:
--
--   * any MEMBER may DELETE a `services` row  (`services_member_all` is FOR ALL)
--       -> appointments_service_same_studio_fk       ON DELETE SET NULL
--       -> appointments.service_id becomes NULL
--   * an OWNER may DELETE a `practitioners` row ("practitioners: owners delete")
--       -> appointments_practitioner_same_studio_fk  ON DELETE SET NULL
--       -> appointments.practitioner_id becomes NULL
--
-- The write is SILENT: no audit row, no `updated_at` touch, no `sync_version`
-- bump, no calendar outbox enqueue. An appointment quietly loses the lineage
-- that every downstream clinical and billing question depends on.
--
-- THE CENSUS THAT AUTHORISES THIS
-- ===========================================================================
-- Performed locally and statically for B4; NO production access of any kind.
--
--   1. FK census on `appointments` (6 FKs, post-0151 truth, read from
--      pg_constraint on a fresh 0001->0173 chain):
--
--        clients        CASCADE     <- NOT browser reachable
--        studios        CASCADE     <- NOT browser reachable
--        services       SET NULL (service_id)       <- REACHABLE, member
--        practitioners  SET NULL (practitioner_id)  <- REACHABLE, owner
--        appointments   SET NULL (self, rescheduled_from/to) — self-reference
--                       only; reaching it requires deleting an appointment,
--                       which 0172 already denies.
--
--   2. Reachability is privilege AND policy. Both were read from the live
--      local catalog rather than inferred:
--
--        services       authenticated arwdDxtm + services_member_all FOR ALL
--        practitioners  authenticated arwdDxtm + "practitioners: owners delete"
--        clients        authenticated arwdDxtm but NO delete policy (0087
--                       replaced the FOR ALL policy with per-command ones)
--        studios        authenticated arwdDxtm but NO delete policy
--
--      `clients` and `studios` are therefore already default-denied at the RLS
--      layer, which is exactly why L23 is "a column is nulled" and not "the
--      appointment disappears". They are NOT touched here: their deletion path
--      is already correctly denied, and altering them for symmetry would widen
--      this migration for no security gain.
--
--   3. Runtime hard-delete census. EVERY `.delete()` call site in `app/`,
--      `lib/` and `components/` was enumerated and resolved to its target
--      table — eight in total:
--
--        treatment_plan_stages, client_pinned_notes, client_pricing,
--        studio_blockouts, studio_timed_blocks   (authenticated client)
--        studios, calendar_connection_secrets,
--        calendar_connections                    (service role)
--
--      ZERO hard-delete `services`. ZERO hard-delete `practitioners`. No SQL
--      function in any of the 173 prior migrations deletes from either table.
--      The product DEACTIVATES instead: `services.active` (0010:150) and
--      `practitioners.active` (0001:25), both surfaced in settings.
--
--      Deleting a service or a practitioner is therefore AMBIENT DATABASE
--      CAPABILITY, not a product workflow. Nothing deployed loses a capability
--      here — the same standard 0172 was held to.
--
-- WHY BOTH LAYERS, NOT JUST THE PRIVILEGE
-- ===========================================================================
-- Revoking the DELETE privilege alone fully closes L23 today: the privilege
-- check precedes the policy check, so RLS never gets a say.
--
-- It is still not sufficient on its own. 0172 itself warns that a privilege can
-- be re-granted out of band "by platform tooling or a future
-- `auto_expose_new_tables` regression" (0172:150-152). If that happened,
-- `services_member_all` — still FOR ALL — would instantly re-open L23 with no
-- migration and no review. The policy is the durable record of intent; the
-- privilege is the enforcement. 0172 applied exactly this reasoning when it
-- dropped `appointment_audit_member_insert` outright rather than leaving
-- "residue that reads as an intentional grant".
--
-- So both layers move, and the shape follows the established precedent for this
-- exact problem: 0087 (`clinical RLS delete hardening`) replaced broad FOR ALL
-- policies with explicit per-command policies, omitting DELETE, for nine
-- tables. 0087's own header notes it left "the booking/availability tables
-- (operational, not clinical history; reported separately)" out of scope.
-- `services` is one of those deferred tables. This migration finishes that job
-- for the two parents that can reach `appointments`.
--
-- `services_member_all` CANNOT simply be dropped: it is FOR ALL, so dropping it
-- without a replacement removes member SELECT/INSERT/UPDATE too and the
-- services settings page returns zero rows. The DROP and the three CREATEs are
-- therefore adjacent and inside one transaction, and each replacement reuses
-- `public.is_studio_member(studio_id)` VERBATIM — the predicate is not
-- rewritten, re-derived or widened, and `is_studio_member` is not touched.
--
-- "practitioners: owners delete" IS dropped outright with no replacement: it is
-- a standalone DELETE policy, so after the revoke it permits an action no role
-- can reach.
--
-- THE ROLE CLAUSE NARROWS, AND THAT IS DELIBERATE
-- ===========================================================================
-- `services_member_all` carried NO `TO` clause, so it applied to PUBLIC —
-- `anon` included. The three replacements are `TO authenticated`, matching the
-- narrowing 0172 made for `appointments_member_select` and the shape every
-- 0087 policy already uses.
--
-- This is behaviourally INERT, established two ways:
--
--   * By construction: `is_studio_member()` resolves `auth.uid()` to NULL for
--     `anon` and returns false, so `anon` reads zero `services` rows under the
--     OLD policy too. `service_role` and `postgres` carry `rolbypassrls`, so
--     policies never applied to them.
--   * By source census: the public booking surface does not read `services` as
--     `anon` at all. `app/book/[slug]/page.tsx:35`, `app/book/[slug]/actions.ts`
--     and `app/reschedule/[token]/actions.ts` all use `createAdminClient()`
--     ("Service-role read since this is public"), and every `createClient()`
--     based reader — `getActiveServices`, `getAllServices`,
--     `servicesHaveCalendarColor` — is called only from authenticated
--     `app/(app)/...` routes and `lib/onboarding/*`.
--
-- Both facts are pinned by tests so a future permissive `TO public` policy on
-- this table fails CI rather than silently granting the world a studio's menu.
--
-- WHAT THIS DOES NOT TOUCH
-- ===========================================================================
-- * SELECT, INSERT and UPDATE privileges are NEVER named. Only DELETE is
--   revoked, and only for `anon` and `authenticated`. There is no `revoke all`
--   in this file (the 0169 doctrine).
-- * `service_role` is NOT revoked on either table. Maintenance and any future
--   governed hard-delete command execute as `service_role`, and the studio
--   provisioning rollback in `app/admin/studios/new/actions.ts:164` already
--   deletes a `studios` row through the admin client. That capability is
--   intentionally retained.
-- * `postgres` unchanged. PUBLIC holds no table grant and is not mutated.
-- * NO FK is altered. The ON DELETE SET NULL semantics on
--   `appointments_service_same_studio_fk` and
--   `appointments_practitioner_same_studio_fk` are left exactly as 0151 wrote
--   them. Changing referential semantics to defend against a delete that can no
--   longer happen would be a schema change with real migration risk and no
--   security gain — the authority layer is where this belongs.
-- * NO trigger function is created, replaced or dropped. In particular
--   `snapshot_appointment_buffer()` is not mentioned; see 0172:212-218 for why
--   that is a standing prohibition.
-- * `clients` and `studios` are not touched (already default-denied, above).
-- * No repair command; those are 0173.
--
-- ROLLBACK
-- ===========================================================================
-- Reversal is a NEW migration that re-grants DELETE and restores the FOR ALL
-- policy shape. Do not edit this file after it is applied. Reversal restores a
-- CAPABILITY, not data: this migration writes no rows.
--
-- Own transaction + armed lock_timeout: `supabase db push` does not wrap a
-- migration file in a transaction, so a bare SET LOCAL emits 25P01 and never
-- arms (the 0159 lesson, recorded verbatim at 0169:70-76).
--
-- Migration max 0173 -> 0174.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- GROUP 1 — the privilege. DELETE only; SELECT/INSERT/UPDATE never named.
revoke delete on table public.services      from anon, authenticated;
revoke delete on table public.practitioners from anon, authenticated;

-- GROUP 2 — policy residue on practitioners. Standalone DELETE policy, so it
-- is dropped outright with no replacement (the 0172 treatment of
-- appointment_audit_member_insert).
drop policy if exists "practitioners: owners delete" on public.practitioners;

-- GROUP 3 — policy residue on services. FOR ALL cannot be dropped without a
-- replacement or member reads break; DROP and CREATEs are adjacent and in one
-- transaction. Predicate reused verbatim. No DELETE policy is created.
drop policy if exists "services_member_all" on public.services;

drop policy if exists "services_member_select" on public.services;
create policy "services_member_select"
  on public.services for select to authenticated
  using (public.is_studio_member(studio_id));

drop policy if exists "services_member_insert" on public.services;
create policy "services_member_insert"
  on public.services for insert to authenticated
  with check (public.is_studio_member(studio_id));

drop policy if exists "services_member_update" on public.services;
create policy "services_member_update"
  on public.services for update to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

commit;
