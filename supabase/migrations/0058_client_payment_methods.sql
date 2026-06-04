-- Migration 0058: client_payment_methods (card-on-file Phase 1, no charges).
--
-- PR #135. Stores the one-card-per-(studio, client) durable mapping
-- to a Stripe PaymentMethod that lives on the studio's Connect
-- Express connected account. v1 is portal-driven card-on-file only:
-- no charges, no PaymentIntent, no refunds, no public-booking
-- card-required flow.
--
-- Design choices (anchored in the prior deep-audit):
--   * Lives parallel to migration 0032's payment tables, NOT inside
--     them. The 0032 backend is appointment-bound (charge after
--     completed) and would force CHECK violations to host generic
--     card-on-file rows. Keeping 0058 narrow preserves the three
--     dormancy guarantees of 0032.
--   * Customer mapping is reused via client_stripe_customers
--     (already created in 0032). The new client_payment_methods row
--     FKs into the 5-tuple lineage so the card can never claim a
--     Customer the studio has not actually provisioned.
--   * Studio account/mode lineage is reused via
--     studio_payment_settings_account_mode_unique (already created
--     in 0032).
--   * Signature linkage is via PR #134 client_consent_signatures
--     (form_type='card_authorization'). v1 keeps the column NULLABLE
--     so a future practitioner-recovery or test-mode insertion path
--     can still write a row; the portal-side action enforces non-
--     null on every normal insert.
--   * Partial unique (studio_id, client_id) WHERE status='active'
--     enforces one active card per (studio, client). The webhook
--     replacement path pre-flips the old row to 'removed' in the
--     same transaction as the new insert; a redelivered webhook
--     hits the partial unique and is caught by the action layer.
--   * RLS posture matches the rest of the consent / payment lineage:
--     studio-member SELECT only; service-role admin INSERT/UPDATE.
--     No DELETE policy (removal is soft via status='removed' +
--     removed_at).
--   * stripe_payment_method_id is NOT marked UNIQUE because Stripe
--     PaymentMethod IDs are per-connected-account; cross-studio
--     uniqueness would not be globally true. The
--     (stripe_payment_method_id) index supports webhook
--     reconciliation lookups; the webhook handler does its own
--     pre-INSERT idempotency check on (stripe_account_id,
--     stripe_livemode, stripe_setup_intent_id), and migration
--     0059 adds the partial unique that backs that check.
--   * stripe_setup_intent_id is per-connected-account unique on the
--     Stripe side. The corresponding partial unique on
--     (stripe_account_id, stripe_livemode, stripe_setup_intent_id)
--     is added in migration 0059 (NOT in this migration) so the
--     constraint can be installed independently if a downstream
--     consumer needs to reproduce the schema in stages.
--
-- Strictly additive + idempotent.

-- --------------------------------------------------------------------
-- 1) Table
-- --------------------------------------------------------------------

create table if not exists public.client_payment_methods (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  stripe_account_id text not null,
  stripe_livemode boolean not null default false,
  stripe_customer_id text not null,
  stripe_payment_method_id text not null,
  stripe_setup_intent_id text not null,
  brand text not null,
  last4 text not null,
  exp_month smallint not null,
  exp_year smallint not null,
  status text not null default 'active',
  card_authorization_signature_id uuid
    references public.client_consent_signatures(id) on delete restrict,
  added_via text not null default 'portal',
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Lineage FKs. These bind the row to objects already established
  -- in the broader Connect schema so a card can never claim a
  -- Customer the studio has not actually provisioned, or live under
  -- a Stripe account the studio has not actually onboarded.
  constraint client_payment_methods_studio_account_mode_fk
    foreign key (studio_id, stripe_account_id, stripe_livemode)
    references public.studio_payment_settings
      (studio_id, stripe_account_id, stripe_livemode)
    on delete restrict,
  constraint client_payment_methods_customer_lineage_fk
    foreign key (client_id, studio_id, stripe_account_id, stripe_livemode,
                 stripe_customer_id)
    references public.client_stripe_customers
      (client_id, studio_id, stripe_account_id, stripe_livemode,
       stripe_customer_id)
    on delete restrict
);

-- --------------------------------------------------------------------
-- 2) CHECK constraints
-- --------------------------------------------------------------------

alter table public.client_payment_methods
  drop constraint if exists client_payment_methods_status_check;
alter table public.client_payment_methods
  add constraint client_payment_methods_status_check
  check (status in ('active', 'removed'));

alter table public.client_payment_methods
  drop constraint if exists client_payment_methods_added_via_check;
alter table public.client_payment_methods
  add constraint client_payment_methods_added_via_check
  check (added_via in ('portal', 'practitioner_recovery'));

alter table public.client_payment_methods
  drop constraint if exists client_payment_methods_last4_length_check;
alter table public.client_payment_methods
  add constraint client_payment_methods_last4_length_check
  check (char_length(last4) = 4);

alter table public.client_payment_methods
  drop constraint if exists client_payment_methods_exp_month_check;
alter table public.client_payment_methods
  add constraint client_payment_methods_exp_month_check
  check (exp_month between 1 and 12);

alter table public.client_payment_methods
  drop constraint if exists client_payment_methods_exp_year_check;
alter table public.client_payment_methods
  add constraint client_payment_methods_exp_year_check
  check (exp_year >= 2025);

alter table public.client_payment_methods
  drop constraint if exists client_payment_methods_removed_columns_check;
alter table public.client_payment_methods
  add constraint client_payment_methods_removed_columns_check
  check (
    (status = 'active'   and removed_at is null)
    or (status = 'removed' and removed_at is not null)
  );

-- --------------------------------------------------------------------
-- 3) Indexes
-- --------------------------------------------------------------------

create index if not exists client_payment_methods_client_idx
  on public.client_payment_methods
  (studio_id, client_id, status, added_at desc);

create index if not exists client_payment_methods_studio_idx
  on public.client_payment_methods (studio_id, status, added_at desc);

create index if not exists client_payment_methods_payment_method_idx
  on public.client_payment_methods (stripe_payment_method_id);

create index if not exists client_payment_methods_setup_intent_idx
  on public.client_payment_methods (stripe_setup_intent_id);

-- One active card per (studio, client). Partial unique because
-- multiple 'removed' rows per pair are expected over time (each
-- replacement keeps the prior row as the audit trail of the
-- previously-active card).
create unique index if not exists client_payment_methods_one_active_per_pair
  on public.client_payment_methods (studio_id, client_id)
  where status = 'active';

-- --------------------------------------------------------------------
-- 4) updated_at trigger
-- --------------------------------------------------------------------

create or replace function public.tg_client_payment_methods_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tg_client_payment_methods_set_updated_at
  on public.client_payment_methods;
create trigger tg_client_payment_methods_set_updated_at
  before update on public.client_payment_methods
  for each row execute function public.tg_client_payment_methods_set_updated_at();

-- --------------------------------------------------------------------
-- 5) RLS
-- --------------------------------------------------------------------

alter table public.client_payment_methods enable row level security;

-- Studio members can SELECT card metadata for their studio. There
-- is no authenticated INSERT / UPDATE / DELETE policy: the portal-
-- side write path goes through the service-role admin client
-- (signCardSetupIntent action + setup_intent.* webhook handler),
-- both of which scope every write by (studio_id, client_id)
-- explicitly. RLS default-deny on UPDATE / DELETE keeps the row
-- effectively immutable against any future authenticated user-
-- scoped client. No anon policy.
drop policy if exists "client_payment_methods_studio_member_select"
  on public.client_payment_methods;
create policy "client_payment_methods_studio_member_select"
  on public.client_payment_methods for select
  to authenticated
  using (public.is_studio_member(studio_id));

comment on table public.client_payment_methods is
  'Durable card-on-file mapping for (studio, client). One active card per pair enforced by partial unique on (studio_id, client_id) WHERE status=active. PR #135 / migration 0058. Inserted by the portal-side setup_intent.succeeded webhook arm after server-side validation of the metadata + Stripe customer lineage. RLS-enabled with studio-member SELECT only; no INSERT / UPDATE / DELETE policy. Phase 1 stores brand / last4 / exp; no charges, no PaymentIntent, no PaymentMethod number. card_authorization_signature_id links to the PR #134 client_consent_signatures row that authorised the card setup; NULLABLE in v1 to admit future practitioner-recovery rows.';
