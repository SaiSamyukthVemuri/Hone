-- 0104: one active card per (studio, client, mode) — companion to 0103.
--
-- Post-live-billing cleanup. 0103 made studio_payment_settings mode-scoped
-- (a studio holds separate test/live Stripe bindings). The card-on-file
-- pre-flip in the setup_intent.succeeded webhook arm is now mode-scoped in
-- lockstep (saving a live card no longer retires the client's TEST card row,
-- and vice versa) — which means a client may legitimately hold one active
-- TEST card AND one active LIVE card at the same time.
--
-- The 0058 partial unique
--   client_payment_methods_one_active_per_pair (studio_id, client_id)
--   WHERE status = 'active'
-- forbade that: with the mode-scoped pre-flip, the live INSERT would hit a
-- 23505 that the webhook treats as idempotent success — the live card would
-- SILENTLY never land. This migration rescopes the index per mode.
--
--   * stripe_livemode is NOT NULL on client_payment_methods (0058), so
--     there is no null-mode subtlety here.
--   * Existing prod data trivially satisfies the tighter index (verified
--     read-only pre-migration: at most one active card per pair overall).
--   * The invariant "at most ONE active card per (studio, client) PER MODE"
--     is what every reader now assumes: getActiveCardForStudioClient and the
--     card-authorization/eligibility lookups are all mode-scoped.
--
-- No other table, RPC, policy, or env is touched. Re-runnable.

drop index if exists public.client_payment_methods_one_active_per_pair;
create unique index client_payment_methods_one_active_per_pair
  on public.client_payment_methods (studio_id, client_id, stripe_livemode)
  where status = 'active';

-- Verification SQL (operator runs after deploy):
--
--   select indexdef from pg_indexes
--   where indexname = 'client_payment_methods_one_active_per_pair';
--   -- expect: UNIQUE ... (studio_id, client_id, stripe_livemode)
--   --         WHERE (status = 'active'::text)
--
--   select studio_id, client_id, stripe_livemode, count(*)
--   from public.client_payment_methods
--   where status = 'active'
--   group by 1,2,3 having count(*) > 1;
--   -- expect: zero rows.
