-- 0334 (I2): clinical-read enforcement, intake and consent. Roles clinical-read gating, Sam decision of 12 Nov 2026
-- ("database enforcement of record permissions"; "Restricted users must not receive clinical contents or derived counts, names, dates or session history").
-- Builds on 0333 (clin_key_studios).
--
-- WHAT THIS CHANGES
--   1. SELECT policies. A row is readable by an authenticated ACTIVE PRACTITIONER of its studio who holds clin.view_intake (has_studio_permission, 0287):
--        client_intake_forms                    (the answers, the acknowledgement, the consent text inside `responses`)
--        client_consent_signatures              (the signed text snapshot, the response and the signature)
--        appointment_policy_acknowledgements    (the acknowledged policy snapshot)
--      Decided (Sam, 12 Nov 2026, ROLES-DECISIONS-LOG "2026-11-12T22:43:59Z: SAM ... clinical I2 design choices"): signed consent contents and policy
--      acknowledgements are gated under intake access (clin.view_intake). This approves the design, not an apply.
--   2. A new definer projection, public.intake_status_for_clients(studio, client ids), for the readers that only need the STATUS of a client's
--      current intake (directory pill and filter, Today, dashboard "awaiting review", missing-records). It returns (client_id, status, created_at)
--      of the newest non-deleted form per client, never `responses` and no consent contents (Sam, same entry: the form-created date stays, for authorized status
--      readers only), and only to an active practitioner holding clin.view_intake_status OR
--      clin.view_intake. Without either it returns ZERO rows (not an error), the same as an unknown studio.
--
-- WHAT IT DOES NOT CHANGE (by design)
--   * Who can read TODAY. A pending or unreleased key resolves to its snapshot (practitioner = studio), so existing practitioners are unchanged
--     until the owner narrows the key. The owner always passes.
--   * Service-role and token paths (the client intake form, the portal, consent signing, reminders, the Stripe webhook, billing eligibility) read through
--     the admin client and bypass RLS. Consent signing INSERTs through the admin client; no INSERT/UPDATE policy is touched here.
--   * The UPDATE policy of client_intake_forms (is_studio_member). An UPDATE evaluates the SELECT policy on the rows it touches, so writing an intake
--     now needs clin.view_intake too; clin.edit_intake and review already require it in the catalog.
--   * Receptionists. They read intake/consent STATUS through the 0274 projection; no access is added here.
--
-- Anon: every changed policy is `to authenticated`; the projection is revoked from anon, public and service_role by name.

begin;
set local lock_timeout = '5s';

-- ---- clin.view_intake: contents -------------------------------------------------------------------------------------------------------
alter policy client_intake_forms_member_select on public.client_intake_forms to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_intake') k));
alter policy client_consent_signatures_studio_member_select on public.client_consent_signatures to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_intake') k));
alter policy appointment_policy_acks_studio_member_select on public.appointment_policy_acknowledgements to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_intake') k));

-- ---- the status projection --------------------------------------------------------------------------------------------------------------
-- Canonical current-intake rule (lib/dashboard/today-intake.ts): the newest non-deleted form per client, ties broken by the larger id.
create or replace function public.intake_status_for_clients(p_studio_id uuid, p_client_ids uuid[] default null)
returns table (client_id uuid, status text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (f.client_id) f.client_id, f.status, f.created_at
    from public.client_intake_forms f
   where f.studio_id = p_studio_id
     and f.deleted_at is null
     and (p_client_ids is null or f.client_id = any (p_client_ids))
     and (
       p_studio_id in (select k from public.clin_key_studios('clin.view_intake_status') k)
       or p_studio_id in (select k from public.clin_key_studios('clin.view_intake') k)
     )
   order by f.client_id, f.created_at desc, f.id desc
$$;

revoke all on function public.intake_status_for_clients(uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.intake_status_for_clients(uuid, uuid[]) to authenticated;

comment on function public.intake_status_for_clients(uuid, uuid[]) is
  '0334: the current intake STATUS per client (never the answers) for an active practitioner holding clin.view_intake_status or clin.view_intake; zero rows otherwise.';

commit;
