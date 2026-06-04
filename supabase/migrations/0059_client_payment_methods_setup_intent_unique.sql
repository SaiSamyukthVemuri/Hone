-- Migration 0059: client_payment_methods unique by SetupIntent.
--
-- PR #135 hardening. The setup_intent.succeeded webhook arm pre-
-- flips any existing active card to 'removed' before inserting the
-- new row. A duplicate Stripe re-delivery would race through that
-- pre-flip and risk wiping the first-delivery's active row before
-- the catchphrase ON CONFLICT (23505) kicked in. The SELECT-first
-- idempotency check in the application code is the primary fix;
-- this migration adds the corresponding DB-level guarantee so the
-- unique-violation catch in the application is a real constraint
-- and not a comment-claimed-but-missing one.
--
-- Stripe SetupIntent IDs are per-connected-account, so the
-- uniqueness key is the full (stripe_account_id, stripe_livemode,
-- stripe_setup_intent_id) tuple. Two distinct connected accounts
-- can in principle return the same opaque id; livemode pairs with
-- account by design in the rest of this schema (every Stripe-
-- aware table treats them as a pair).
--
-- Strictly additive + idempotent. No data movement; pre-existing
-- rows (none in prod at apply time) are checked for uniqueness as
-- the index builds.

create unique index if not exists
  client_payment_methods_setup_intent_account_mode_uniq
  on public.client_payment_methods
  (stripe_account_id, stripe_livemode, stripe_setup_intent_id);
