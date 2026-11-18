-- Down for 0351. Drops the per-studio manual-fee settings (switches, mode, percent), the attempt calculation-basis columns,
-- the change-record trigger/function and the change-record table (the record is lost). Touches no other column. After this,
-- the application code that reads these columns must not be deployed (it fails closed: a missing setting reads as OFF, so no
-- manual fee can be charged). Run it only if 0351 must be undone.
begin;

set local lock_timeout = '5s';

drop trigger if exists studios_manual_fee_setting_audit on public.studios;
drop function if exists public.studios_manual_fee_setting_audit();
drop table if exists public.studio_manual_fee_setting_changes;

drop trigger if exists payment_charge_attempts_calc_basis_immutable on public.payment_charge_attempts;
drop function if exists public.payment_charge_attempts_calc_basis_immutable();
alter table public.payment_charge_attempts
  drop constraint if exists payment_charge_attempts_calc_basis_check,
  drop column if exists calc_mode,
  drop column if exists basis_cents,
  drop column if exists percent_bp;

alter table public.studios
  drop constraint if exists studios_late_cancel_fee_mode_check,
  drop constraint if exists studios_no_show_fee_mode_check,
  drop constraint if exists studios_late_cancel_fee_percent_bp_check,
  drop constraint if exists studios_no_show_fee_percent_bp_check,
  drop column if exists late_cancel_fee_enabled,
  drop column if exists no_show_fee_enabled,
  drop column if exists late_cancel_fee_mode,
  drop column if exists no_show_fee_mode,
  drop column if exists late_cancel_fee_percent_bp,
  drop column if exists no_show_fee_percent_bp;

commit;
