-- Migration 0072. Consent template "Live in client portal" control.
-- PR #167. Adds public.consent_form_templates.is_live as an explicit,
-- defaults-to-false boolean that gates client-portal visibility,
-- decoupling it from the practitioner-facing status enum
-- (draft / active / archived).
--
-- Why a separate column instead of reusing status:
--   Chloe's report: "I need a way to make consent forms live or not
--   live, just like booking/services. I don't want test forms going
--   out into clients' portal and having them sign random stuff I'm
--   doing." Today the practitioner's "Activate" button immediately
--   flips status='active', and the portal query reads status='active'
--   directly (lib/consent/queries.ts:getActiveConsentTemplatesForPortal),
--   so there is no way to mark a template "ready to use" without
--   simultaneously exposing it to clients. A new boolean named with
--   the consequence ("Live in client portal") lets the practitioner
--   move a template through draft -> active without it being
--   client-visible until they explicitly flip the live toggle.
--
-- Why is_live = (status = 'active') for the backfill predicate:
--   The portal currently surfaces exactly the rows where
--   status = 'active'. Backfilling is_live to that same set
--   preserves the status quo for every studio that has real
--   client-facing consent forms today. After this migration the
--   portal query also requires is_live = true, but every previously
--   client-facing template will satisfy both clauses.
--
-- Why DEFAULT false:
--   The whole point of the change is to make it impossible to
--   accidentally publish a freshly-created test template. A future
--   CREATE on this table that does not set is_live explicitly will
--   land at is_live = false even if status = 'active'. The
--   companion createConsentTemplateAction change (same PR) also
--   forces status='draft' on insert, so the create path produces
--   a (status='draft', is_live=false) row that requires two
--   deliberate practitioner actions (Make Active then Make Live)
--   to reach the client portal.
--
-- Why the CHECK constraint:
--   The portal query keeps defense-in-depth on status as well as
--   is_live, but the CHECK is the actual safety guarantee: a row
--   with is_live = true MUST have status = 'active'. A draft or
--   archived row cannot be live. The matching practitioner action
--   `setConsentTemplateStatusAction` is updated in the same PR to
--   force is_live = false whenever status is moved to draft or
--   archived, so the constraint is never violated by application
--   code; the CHECK is the structural backstop if a future PR
--   forgets that invariant.
--
-- Effect on historical client_consent_signatures:
--   None. Signatures snapshot title + body + version + hash at
--   sign time (migration 0057) and are surfaced on portal +
--   practitioner views via getLatestSignaturesByTemplateForPortal
--   / getLatestSignaturesForPractitionerView, both of which read
--   the signatures table directly and do not join the templates
--   table. Flipping a template's is_live to false (or its status
--   to archived) cannot delete or hide any signed record.
--
-- Effect on card_authorization (PR #135 / PR #158):
--   card_authorization is a normal consent_form_templates row with
--   form_type = 'card_authorization'. Willow's currently-active
--   card_authorization row has status = 'active', so the backfill
--   flips its is_live to true. The portal Add card flow in
--   app/portal/payment-method-actions.ts continues to find it via
--   the augmented query, and the PR #158 guidance branches keep
--   working.
--
-- Effect on photo_consent (PR #137):
--   Same as above. photo_consent rows live in the same table; the
--   backfill covers them; portal continues to surface signed ones
--   with their accepted/denied response from migration 0060.
--
-- Idempotency:
--   - ADD COLUMN IF NOT EXISTS keeps a re-run safe.
--   - The UPDATE only flips rows where is_live IS NULL OR FALSE
--     into is_live = true when status='active'; a re-run is a no-op.
--   - DROP CONSTRAINT IF EXISTS before re-adding the CHECK keeps
--     a re-run safe even if the previous attempt half-applied.
--
-- No new index in this migration. The portal query gains an
-- is_live filter on top of the existing studio_id + status filter;
-- the existing index on (studio_id, status) carries enough
-- selectivity for the current row count (single-digit templates
-- per studio in the pilot). A future PR can add a partial index
-- on (studio_id) WHERE is_live = true if the table grows or the
-- query plan regresses.

ALTER TABLE public.consent_form_templates
  ADD COLUMN IF NOT EXISTS is_live BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: preserve current portal visibility for every studio.
-- Row count for this UPDATE is visible to the operator before the
-- CHECK constraint locks (Sam's migration discipline). On the
-- Willow pilot this expects a single-digit row count; the
-- post-update SELECT in the verification block below proves the
-- backfill matched the predicate.
UPDATE public.consent_form_templates
  SET is_live = TRUE
  WHERE status = 'active' AND is_live = FALSE;

-- Structural guarantee: is_live = true implies status = 'active'.
-- A draft or archived row can never be marked live, even by a
-- future direct admin write. The matching application code never
-- writes a violating combination; this CHECK is the backstop.
ALTER TABLE public.consent_form_templates
  DROP CONSTRAINT IF EXISTS consent_form_templates_live_requires_active_check;
ALTER TABLE public.consent_form_templates
  ADD CONSTRAINT consent_form_templates_live_requires_active_check
    CHECK ( NOT is_live OR status = 'active' );

COMMENT ON COLUMN public.consent_form_templates.is_live IS
  'Whether this template is live in the client portal. Decoupled from status so a practitioner can mark a template active (ready for use) without it being client-visible. Portal queries filter is_live=true; settings reads every status value. CHECK constraint keeps is_live=true rows in status=active. PR #167.';

-- Verification (run manually after `supabase db push --linked`):
--
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema='public' and table_name='consent_form_templates'
--     and column_name='is_live';
--   -- expect: boolean | NO | false
--
--   select status, is_live, count(*)
--   from public.consent_form_templates
--   group by status, is_live
--   order by status, is_live;
--   -- expect: every (status='active') row has is_live=true;
--   --         every (status in ('draft','archived')) row has is_live=false.
--
--   select form_type, count(*) filter (where is_live=true) as live,
--                     count(*) filter (where is_live=false) as not_live
--   from public.consent_form_templates
--   group by form_type
--   order by form_type;
--   -- expect: row counts identical to the pre-migration status='active'
--   --         and status in ('draft','archived') splits per form_type.
