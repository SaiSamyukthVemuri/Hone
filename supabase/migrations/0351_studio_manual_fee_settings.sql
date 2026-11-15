-- 0351: per-studio on/off settings for the two manual fees (late cancellation, no-show). NOT APPLIED. Hosted apply needs
-- Sam's per-change approval and its own package. Number chosen from `npm run migration:state` (next free 0342) and the open
-- PRs: 0342-0350 are claimed by open work.
--
-- WHAT. Two boolean columns on public.studios, NOT NULL DEFAULT false:
--   late_cancel_fee_enabled   the owner allows manual LATE-CANCELLATION fee charges for this studio
--   no_show_fee_enabled       the owner allows manual NO-SHOW fee charges for this studio
-- They are independent of each other and of the amounts (studios.late_cancel_fee_cents / no_show_fee_cents, 0064).
-- Every existing and future studio starts OFF. Adding a NOT NULL column with a constant default is a catalog change only
-- (no table rewrite) on the supported Postgres versions.
--
-- WHO MAY WRITE. No grant, policy or function changes here. The existing policy "studios: owners update" (0001)
-- is `using (is_studio_owner(id)) with check (is_studio_owner(id))`, so only the studio's owner can change these columns
-- through the Data API; a member's UPDATE touches zero rows. The application writes them from an owner-checked server
-- action (app/(app)/settings/payments/fee-amounts-actions.ts), like the amounts. service_role bypasses RLS as before.
-- No function is added, so no EXECUTE revoke is needed.
--
-- WHAT THIS DOES NOT DO. It changes no charge, refund, webhook or reconciliation code and no data. The application reads the
-- columns at prepare and again at execute (lib/billing/manual-fee-studio-setting.ts). A temporary env release list still
-- applies in LIVE mode on top of this setting.

begin;

set local lock_timeout = '5s';

alter table public.studios
  add column if not exists late_cancel_fee_enabled boolean not null default false,
  add column if not exists no_show_fee_enabled boolean not null default false;

comment on column public.studios.late_cancel_fee_enabled is
  '0351. The owner allows manual late-cancellation fee charges for this studio. Default false. Enforced server-side at prepare and at execute; turning it off blocks new charges, including prepared-not-sent attempts, and never touches an attempt already sent.';
comment on column public.studios.no_show_fee_enabled is
  '0351. The owner allows manual no-show fee charges for this studio. Default false. Enforced server-side at prepare and at execute; turning it off blocks new charges, including prepared-not-sent attempts, and never touches an attempt already sent.';

commit;
