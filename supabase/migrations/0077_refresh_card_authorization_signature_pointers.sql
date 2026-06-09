-- ---------------------------------------------------------------------------
-- PR #177. Card authorization pointer refresh + one-shot backfill.
-- ---------------------------------------------------------------------------
--
-- Context: docs/16 §5.11 (the PR #176 finding). Until PR #177, a fresh
-- card_authorization signature did NOT refresh
-- client_payment_methods.card_authorization_signature_id on the active
-- card. Cards added before a template version bump kept their original
-- (now stale) pointer even when the client later signed the current
-- live template body. The base getCardAuthorizationStatus helper read
-- the latest signature against the live template and returned
-- 'signed_current', so the charge path accepted the card. But the audit
-- artefact stamped on the card row was the OLDER signature -- so a
-- dispute or chargeback that asks "show the signed authorization for
-- the card that was charged" returned a body the client may never have
-- agreed to in its current wording.
--
-- This migration is the structural piece of PR #177. It backfills
-- existing prod data so the new charge-time invariant
-- (active_card.card_authorization_signature_id ==
--  current_signed_current_signature_id) does not block known-valid
-- current signatures the day the code merges. The application code
-- in PR #177 is what KEEPS the pointer in sync going forward; this
-- migration is what makes the gate safe to turn on for existing rows.
--
-- Strictness:
--   * Only active, non-removed cards are updated.
--   * Only cards whose studio has a current live card_authorization
--     template are touched.
--   * Only cards whose latest signature against that live template is
--     CURRENT (signature.template_version == template.version) are
--     touched. A stale-or-no signature leaves the row alone -- the new
--     code-side charge gate will refuse the charge until the client
--     re-signs through the portal, which is the correct UX.
--   * No row is updated where the existing pointer already equals the
--     current signature id (`IS DISTINCT FROM` handles NULL correctly,
--     so a NULL pointer with a current signature IS updated; an equal
--     pointer is not).
--   * No cross-studio, cross-client, or cross-livemode joins.
--   * No CHECK constraint relaxed. No live-mode invariant relaxed. No
--     manual_fee_charge_attempts touched. No Stripe call. No PaymentIntent
--     create. No refund. No webhook. No client portal payment UI.
--
-- Idempotency: re-running this migration produces zero updates because
-- the WHERE clause's `IS DISTINCT FROM` already screens out rows whose
-- pointer matches. Safe to apply once or many times.
--
-- Migration ledger: latest in tree was 0076 (PR #175 receipt columns).
-- This is 0077.
-- ---------------------------------------------------------------------------

do $migration$
declare
  v_rows_updated integer;
begin

  with eligible as (
    select
      cpm.id as card_id,
      latest_sig.id as new_signature_id
    from public.client_payment_methods cpm
    join lateral (
      -- The live card_authorization template for the card's studio.
      -- Same .order(created_at desc).limit(1) tiebreaker as
      -- lib/consent/current-card-authorization.ts so the SQL and the
      -- helper agree on which template is "the" live one when (an
      -- unlikely) multiple is_live=true rows exist.
      select t.id, t.version
      from public.consent_form_templates t
      where t.studio_id = cpm.studio_id
        and t.is_live = true
        and t.status = 'active'
        and t.form_type = 'card_authorization'
      order by t.created_at desc
      limit 1
    ) live_template on true
    join lateral (
      -- The latest signature this client has against THAT live template.
      -- We additionally require the signature's stored
      -- template_version to equal the live template's current version
      -- so a signature against an older snapshot of the same template
      -- row does NOT count as a refresh target.
      select s.id
      from public.client_consent_signatures s
      where s.studio_id = cpm.studio_id
        and s.client_id = cpm.client_id
        and s.template_id = live_template.id
        and s.template_version = live_template.version
      order by s.signed_at desc
      limit 1
    ) latest_sig on true
    where cpm.status = 'active'
      and cpm.removed_at is null
      -- IS DISTINCT FROM treats NULL safely: a NULL pointer with a
      -- current signature DOES qualify for update; an equal pointer
      -- does not. Re-running the migration is a no-op.
      and cpm.card_authorization_signature_id is distinct from latest_sig.id
  )
  update public.client_payment_methods cpm
  set card_authorization_signature_id = e.new_signature_id
  from eligible e
  where cpm.id = e.card_id;

  get diagnostics v_rows_updated = row_count;

  raise notice
    'PR #177 backfill: refreshed % active client_payment_methods card_authorization_signature_id pointer(s)',
    v_rows_updated;

end
$migration$;
