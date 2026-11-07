-- 0302: finance DB closure M1 (HON-44, Machines). HELD: authored, NOT applied. A hosted apply
-- needs Sam's per-change approval in his own words; nothing here authorizes one.
--
-- WHAT IT CLOSES. Two direct-API gaps that the application never relies on, found by the
-- read-only finance audit and confirmed from the migration chain:
--
--   (i)  client_payment_methods was readable by EVERY studio member (0058:
--        client_payment_methods_studio_member_select, is_studio_member). A practitioner with
--        their own login could read brand, last4, expiry and the Stripe customer, payment
--        method, setup intent and account ids of every client of the studio through the Data
--        API. Every application reader of this table already runs on the service role
--        (verified file by file; pinned by tests/security/finance-m1-card-readers.test.ts),
--        so the read narrows to the studio OWNER with no application change.
--
--   (ii) services INSERT and UPDATE were open to every member (0173 services_member_insert /
--        services_member_update, is_studio_member). A practitioner could change the price
--        list through the Data API. Every application writer already sits behind assertOwner
--        (settings/services/actions.ts); no practitioner flow writes the table. Both policies
--        become owner-only. services_member_select is NOT touched (prices stay readable by
--        members until M3's checked read path); there is still no DELETE policy.
--
-- WHAT IT DOES NOT TOUCH. No column grant or revoke. No function. No data: ZERO migration-level
-- DML. SECURITY DEFINER functions and the service role are unaffected by a policy, so every
-- definer path (card save, settlement, jurisdiction) is unchanged. M2 (client_pricing), M3
-- (column revokes, the checked read path) and M4a / M4b (consent and acknowledgement rows) are
-- separate migrations.
--
-- OWNER MEANS is_studio_owner(studio_id): an active practitioners row with role 'owner'
-- (practitioners.role is CHECKed to owner|practitioner at 0001:24; receptionists are
-- studio_receptionists rows and have no practitioners row, so they match neither branch).
-- When R3 lands the owner predicate is replaced by the finance keys.
--
-- CATALOG METADATA: one COMMENT ON TABLE (client_payment_methods), because the 0058 comment
-- says "studio-member SELECT only" and is false after this. It mutates pg_description only.
--
-- ROLLBACK: supabase/rollbacks/0302_finance_m1_owner_only_cards_and_service_writes.down.sql
-- (NOT a migration; restores the three old policies and the old comment; applying it is its
-- own decision).
begin;
set local lock_timeout = '5s';

-- (i) client_payment_methods: owner-only select.
drop policy if exists "client_payment_methods_studio_member_select" on public.client_payment_methods;
drop policy if exists "client_payment_methods_owner_select" on public.client_payment_methods;
create policy "client_payment_methods_owner_select"
  on public.client_payment_methods for select to authenticated
  using (public.is_studio_owner(studio_id));

-- (ii) services: owner-only insert and update. Select stays member-wide until M3.
drop policy if exists "services_member_insert" on public.services;
drop policy if exists "services_owner_insert" on public.services;
create policy "services_owner_insert"
  on public.services for insert to authenticated
  with check (public.is_studio_owner(studio_id));

drop policy if exists "services_member_update" on public.services;
drop policy if exists "services_owner_update" on public.services;
create policy "services_owner_update"
  on public.services for update to authenticated
  using (public.is_studio_owner(studio_id))
  with check (public.is_studio_owner(studio_id));

comment on table public.client_payment_methods is
  'Durable card-on-file mapping for (studio, client). One active card per pair enforced by partial unique on (studio_id, client_id) WHERE status=active. PR #135 / migration 0058. Inserted by the portal-side setup_intent.succeeded webhook arm after server-side validation of the metadata + Stripe customer lineage. RLS-enabled; SELECT is owner-only (is_studio_owner) since 0302; no INSERT / UPDATE / DELETE policy, so every write goes through the service role or a SECURITY DEFINER command. Stores brand / last4 / exp; no charges, no PaymentIntent, no PaymentMethod number. card_authorization_signature_id links to the PR #134 client_consent_signatures row that authorised the card setup; NULLABLE in v1 to admit future practitioner-recovery rows.';

commit;
