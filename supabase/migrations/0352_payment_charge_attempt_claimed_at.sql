-- 0352: an immutable claim timestamp on payment_charge_attempts. NOT APPLIED. Hosted apply needs the platform operator's
-- per-change approval and its own package. Number chosen from `npm run migration:state` (next free 0352 after 0351).
--
-- WHY. The stuck-fee sweep (lib/billing/stuck-fee-sweep.ts) must age a pending_stripe fee attempt from when it was CLAIMED.
-- payment_charge_attempts has created_at (prepare time: an attempt prepared days ago and claimed seconds ago would alert at
-- once) and updated_at (moved by every later write, so not an age). There was no claim timestamp. The status CHECK (0073)
-- has no requires_action: that is only a Stripe status the runner cancels and records as failed, so a sent attempt is
-- pending_stripe.
--
-- WHAT. One nullable column, no default, no backfill (an attempt claimed before this migration keeps NULL; the sweep falls back
-- to updated_at for those), and one BEFORE trigger:
--   * INSERT: claimed_at is forced to NULL (a caller cannot supply one).
--   * UPDATE, old.status = 'ready' and new.status = 'pending_stripe' and old.claimed_at is null: claimed_at := now().
--   * UPDATE, any other case: claimed_at := old.claimed_at, silently. A caller, including service_role, cannot set, change or
--     clear it, and no other transition stamps it. It applies to every charge_reason, session payments included.
-- The claim RPC (0075), the updated_at touch trigger (0073) and the 0214 triggers are unchanged. The RPC's result is unchanged:
-- its UPDATE simply passes through this trigger.
--
-- PRIVILEGES. The trigger function is revoked from public, anon, authenticated and service_role by name (a trigger function
-- cannot be called directly; this is the repository's rule for every function). search_path is pinned.

begin;

set local lock_timeout = '5s';

alter table public.payment_charge_attempts
  add column if not exists claimed_at timestamptz;

comment on column public.payment_charge_attempts.claimed_at is
  '0352. When the attempt moved from ready to pending_stripe (the claim). Stamped once by a trigger, immutable afterwards, NULL for attempts claimed before 0352 and for attempts never claimed.';

create or replace function public.payment_charge_attempts_claimed_at_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.claimed_at := null;
  elsif old.status = 'ready' and new.status = 'pending_stripe' and old.claimed_at is null then
    new.claimed_at := now();
  else
    new.claimed_at := old.claimed_at;
  end if;
  return new;
end;
$$;

revoke execute on function public.payment_charge_attempts_claimed_at_guard() from public;
revoke execute on function public.payment_charge_attempts_claimed_at_guard() from anon;
revoke execute on function public.payment_charge_attempts_claimed_at_guard() from authenticated;
revoke execute on function public.payment_charge_attempts_claimed_at_guard() from service_role;

drop trigger if exists payment_charge_attempts_claimed_at_guard on public.payment_charge_attempts;
create trigger payment_charge_attempts_claimed_at_guard
  before insert or update on public.payment_charge_attempts
  for each row execute function public.payment_charge_attempts_claimed_at_guard();

commit;
