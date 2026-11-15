-- 0351: per-studio settings for the two manual fees (late cancellation, no-show): on/off, fixed-or-percent mode, percent value,
-- the frozen calculation basis on the attempt, and an append-only change record. NOT APPLIED. Hosted apply needs
-- the platform operator's per-change approval and its own package. Number chosen from `npm run migration:state` (next free 0342) and the open
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

-- PERCENT MODE (added in this same, still-unapplied file). Per fee type the owner picks a mode:
--   'fixed'   (default) the existing *_fee_cents amount, unchanged
--   'percent' a percentage of the appointment's session price, stored as basis points (1..10000 = 0.01%..100%)
-- Existing studios keep mode 'fixed' and their amounts. The amount of a percent fee is computed by the server at prepare,
-- frozen on the attempt (amount_cents plus calc_mode, basis_cents, percent_bp) and never recomputed at execute.
-- The three attempt columns are NULL for session payments and for any attempt prepared before this migration.
--
-- CHANGE RECORD. public.studio_manual_fee_setting_changes is append-only: one row per changed setting, written by an
-- AFTER UPDATE trigger on public.studios, so a change made directly through the Data API (which the owner's RLS policy allows)
-- is recorded as well as one made through the application. It follows the pattern of studio_payment_jurisdiction_changes (0214):
-- no role holds INSERT, UPDATE or DELETE; the trigger function (SECURITY DEFINER) is the only writer and is revoked from
-- public, anon, authenticated and service_role by name. changed_by is auth.uid() and is NULL for a service-role or SQL change.

begin;

set local lock_timeout = '5s';

alter table public.studios
  add column if not exists late_cancel_fee_enabled boolean not null default false,
  add column if not exists no_show_fee_enabled boolean not null default false,
  add column if not exists late_cancel_fee_mode text not null default 'fixed',
  add column if not exists no_show_fee_mode text not null default 'fixed',
  add column if not exists late_cancel_fee_percent_bp integer,
  add column if not exists no_show_fee_percent_bp integer;

alter table public.studios
  add constraint studios_late_cancel_fee_mode_check check (late_cancel_fee_mode in ('fixed', 'percent')),
  add constraint studios_no_show_fee_mode_check check (no_show_fee_mode in ('fixed', 'percent')),
  add constraint studios_late_cancel_fee_percent_bp_check
    check (late_cancel_fee_percent_bp is null or late_cancel_fee_percent_bp between 1 and 10000),
  add constraint studios_no_show_fee_percent_bp_check
    check (no_show_fee_percent_bp is null or no_show_fee_percent_bp between 1 and 10000);

comment on column public.studios.late_cancel_fee_enabled is
  '0351. The owner allows manual late-cancellation fee charges for this studio. Default false. Enforced server-side at prepare and at execute; turning it off blocks new charges, including prepared-not-sent attempts, and never touches an attempt already sent.';
comment on column public.studios.no_show_fee_enabled is
  '0351. The owner allows manual no-show fee charges for this studio. Default false. Enforced server-side at prepare and at execute; turning it off blocks new charges, including prepared-not-sent attempts, and never touches an attempt already sent.';
comment on column public.studios.late_cancel_fee_mode is
  '0351. fixed (the late_cancel_fee_cents amount) or percent (late_cancel_fee_percent_bp of the appointment session price). Default fixed.';
comment on column public.studios.no_show_fee_mode is
  '0351. fixed (the no_show_fee_cents amount) or percent (no_show_fee_percent_bp of the appointment session price). Default fixed.';
comment on column public.studios.late_cancel_fee_percent_bp is
  '0351. Late-cancellation percentage in basis points, 1..10000 (7500 = 75%). NULL until set. Used only when late_cancel_fee_mode = percent.';
comment on column public.studios.no_show_fee_percent_bp is
  '0351. No-show percentage in basis points, 1..10000. NULL until set. Used only when no_show_fee_mode = percent.';

-- Frozen calculation basis on the attempt.
alter table public.payment_charge_attempts
  add column if not exists calc_mode text,
  add column if not exists basis_cents integer,
  add column if not exists percent_bp integer;

alter table public.payment_charge_attempts
  add constraint payment_charge_attempts_calc_basis_check check (
    (calc_mode is null and basis_cents is null and percent_bp is null)
    or (calc_mode is not distinct from 'fixed' and basis_cents is null and percent_bp is null)
    or (calc_mode is not distinct from 'percent' and basis_cents is not null and basis_cents > 0
        and percent_bp is not null and percent_bp between 1 and 10000)
  );
-- NULL-safe on purpose: a CHECK passes when it evaluates to UNKNOWN, so a plain `calc_mode = 'percent'` or `basis_cents > 0`
-- would let a NULL slip through some malformed shapes.

comment on column public.payment_charge_attempts.calc_mode is
  '0351. How a manual fee amount was derived at prepare: fixed or percent. NULL for session payments and attempts prepared before 0351.';
comment on column public.payment_charge_attempts.basis_cents is
  '0351. Percent mode only: the session price in cents the percentage was applied to. NULL otherwise.';
comment on column public.payment_charge_attempts.percent_bp is
  '0351. Percent mode only: the percentage in basis points applied to basis_cents. NULL otherwise.';

create or replace function public.payment_charge_attempts_calc_basis_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.calc_mode is distinct from old.calc_mode
     or new.basis_cents is distinct from old.basis_cents
     or new.percent_bp is distinct from old.percent_bp then
    raise exception
      'payment_charge_attempts: calc_mode, basis_cents and percent_bp are fixed when the attempt is prepared and never change'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.payment_charge_attempts_calc_basis_immutable() from public;
revoke execute on function public.payment_charge_attempts_calc_basis_immutable() from anon;
revoke execute on function public.payment_charge_attempts_calc_basis_immutable() from authenticated;
revoke execute on function public.payment_charge_attempts_calc_basis_immutable() from service_role;

drop trigger if exists payment_charge_attempts_calc_basis_immutable on public.payment_charge_attempts;
create trigger payment_charge_attempts_calc_basis_immutable
  before update of calc_mode, basis_cents, percent_bp on public.payment_charge_attempts
  for each row execute function public.payment_charge_attempts_calc_basis_immutable();

-- Append-only change record.
create table if not exists public.studio_manual_fee_setting_changes (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  changed_by uuid,
  field text not null check (field in (
    'late_cancel_fee_enabled', 'no_show_fee_enabled',
    'late_cancel_fee_mode', 'no_show_fee_mode',
    'late_cancel_fee_percent_bp', 'no_show_fee_percent_bp',
    'late_cancel_fee_cents', 'no_show_fee_cents'
  )),
  old_value text,
  new_value text,
  changed_at timestamptz not null default now()
);

create index if not exists studio_manual_fee_setting_changes_studio_idx
  on public.studio_manual_fee_setting_changes (studio_id, changed_at desc);

alter table public.studio_manual_fee_setting_changes enable row level security;

drop policy if exists "studio_manual_fee_setting_changes: owners read" on public.studio_manual_fee_setting_changes;
create policy "studio_manual_fee_setting_changes: owners read"
  on public.studio_manual_fee_setting_changes
  for select to authenticated
  using (public.is_studio_owner(studio_id));

revoke all on public.studio_manual_fee_setting_changes from public;
revoke all on public.studio_manual_fee_setting_changes from anon;
revoke all on public.studio_manual_fee_setting_changes from authenticated;
revoke all on public.studio_manual_fee_setting_changes from service_role;
grant select on public.studio_manual_fee_setting_changes to authenticated;
grant select on public.studio_manual_fee_setting_changes to service_role;

comment on table public.studio_manual_fee_setting_changes is
  '0351. Append-only record of changes to the manual fee settings on public.studios (on/off, mode, percent, fixed amount): who (auth.uid(); NULL for service-role or SQL), which field, old and new value, when. Written only by the studios_manual_fee_setting_audit trigger. Holds no client data.';

create or replace function public.studios_manual_fee_setting_audit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  insert into public.studio_manual_fee_setting_changes (studio_id, changed_by, field, old_value, new_value)
  select new.id, v_actor, c.field, c.old_value, c.new_value
  from (values
    ('late_cancel_fee_enabled', old.late_cancel_fee_enabled::text, new.late_cancel_fee_enabled::text),
    ('no_show_fee_enabled', old.no_show_fee_enabled::text, new.no_show_fee_enabled::text),
    ('late_cancel_fee_mode', old.late_cancel_fee_mode, new.late_cancel_fee_mode),
    ('no_show_fee_mode', old.no_show_fee_mode, new.no_show_fee_mode),
    ('late_cancel_fee_percent_bp', old.late_cancel_fee_percent_bp::text, new.late_cancel_fee_percent_bp::text),
    ('no_show_fee_percent_bp', old.no_show_fee_percent_bp::text, new.no_show_fee_percent_bp::text),
    ('late_cancel_fee_cents', old.late_cancel_fee_cents::text, new.late_cancel_fee_cents::text),
    ('no_show_fee_cents', old.no_show_fee_cents::text, new.no_show_fee_cents::text)
  ) as c(field, old_value, new_value)
  where c.old_value is distinct from c.new_value;
  return new;
end;
$$;

revoke execute on function public.studios_manual_fee_setting_audit() from public;
revoke execute on function public.studios_manual_fee_setting_audit() from anon;
revoke execute on function public.studios_manual_fee_setting_audit() from authenticated;
revoke execute on function public.studios_manual_fee_setting_audit() from service_role;

drop trigger if exists studios_manual_fee_setting_audit on public.studios;
create trigger studios_manual_fee_setting_audit
  after update of late_cancel_fee_enabled, no_show_fee_enabled, late_cancel_fee_mode, no_show_fee_mode,
    late_cancel_fee_percent_bp, no_show_fee_percent_bp, late_cancel_fee_cents, no_show_fee_cents
  on public.studios
  for each row execute function public.studios_manual_fee_setting_audit();

commit;
