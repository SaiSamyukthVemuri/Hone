-- ROLLBACK for 0302 (HELD; NOT a migration; never placed in supabase/migrations).
-- Restores 0058's member-wide select on client_payment_methods, 0173's member-wide insert and
-- update on services, and 0058's table comment byte-for-byte (pinned by
-- tests/migrations/0302-finance-m1-owner-only.test.ts). Applying it re-opens the direct-API
-- exposures 0302 closed; it is its own decision of Sam's and a NEW forward migration.
begin;
set local lock_timeout = '5s';

drop policy if exists "client_payment_methods_owner_select" on public.client_payment_methods;
drop policy if exists "client_payment_methods_studio_member_select" on public.client_payment_methods;
create policy "client_payment_methods_studio_member_select"
  on public.client_payment_methods for select
  to authenticated
  using (public.is_studio_member(studio_id));

drop policy if exists "services_owner_insert" on public.services;
drop policy if exists "services_member_insert" on public.services;
create policy "services_member_insert"
  on public.services for insert to authenticated
  with check (public.is_studio_member(studio_id));

drop policy if exists "services_owner_update" on public.services;
drop policy if exists "services_member_update" on public.services;
create policy "services_member_update"
  on public.services for update to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

comment on table public.client_payment_methods is
  'Durable card-on-file mapping for (studio, client). One active card per pair enforced by partial unique on (studio_id, client_id) WHERE status=active. PR #135 / migration 0058. Inserted by the portal-side setup_intent.succeeded webhook arm after server-side validation of the metadata + Stripe customer lineage. RLS-enabled with studio-member SELECT only; no INSERT / UPDATE / DELETE policy. Phase 1 stores brand / last4 / exp; no charges, no PaymentIntent, no PaymentMethod number. card_authorization_signature_id links to the PR #134 client_consent_signatures row that authorised the card setup; NULLABLE in v1 to admit future practitioner-recovery rows.';

commit;
