-- ===========================================================================
-- NNNN — HON-47: A STUDIO MAY TURN OFF CLIENT PORTAL ACCESS
-- ===========================================================================
--
-- UNNUMBERED DRAFT. NOT IN supabase/migrations, NOT APPLIED ANYWHERE.
-- OPS allocates the number after the governed 0247-0250 range and the #1035
-- rollout decisions. Until then this file is a reviewable draft only, and the
-- application branch that reads the column (feat/hon-47-portal-controls) is not
-- releasable.
--
-- WHAT THIS ADDS, AND NOTHING ELSE:
--   1. studios.client_portal_enabled boolean NOT NULL DEFAULT TRUE.
--   2. A defence-in-depth BEFORE INSERT guard: no portal magic link and no
--      portal session can be created for a studio whose flag is FALSE.
--
-- IT REUSES 0234, IT DOES NOT DUPLICATE IT. Client self-service CANCELLATION
-- and RESCHEDULING already have their own flags in 0234
-- (client_cancellation_enabled, client_reschedule_enabled), enforced inside
-- their commands. This file adds only the third control. The three are
-- independent: none implies another, and an owner sets each.
--
-- No SQL here references 0234's columns, so this file applies with or without
-- 0234. It should still be numbered AFTER 0234 so the three controls arrive in
-- order. The application treats an absent column as TRUE (it reads studios with
-- `select *`), so every studio keeps today's behaviour whichever of the two
-- files is applied first.
--
-- WHAT client_portal_enabled = FALSE MEANS (enforced in the application, see
-- lib/booking/client-self-service-policy.ts):
--   * /portal, /portal/login?studio=<slug>, /portal/verify/<token> and every
--     portal server action refuse with "online client access isn't available";
--   * portal rebook and RETURNING-client online booking on /book refuse;
--   * the portal and "book another" CTAs are withdrawn from client emails;
--   * staff "send portal link" and staff portal messages refuse with a staff
--     message.
-- Reminders and postcare still deliver by email; only their CTAs change.
--
-- NOT DERIVED FROM, AND NEVER READ BY, new_client_admission_mode. That field is
-- NEW-client admission (0204). Folding portal access into it would let a change
-- to one owner decision silently change the other.
--
-- NO OWNER-ONLY SETTER IS NEEDED, AND NONE IS ADDED. `studios` has carried the
-- "studios: owners update" RLS policy since 0001: only is_studio_owner() may
-- UPDATE a studio row, and no other role holds a policy that allows it. That is
-- exactly how every existing client-facing studio toggle is written
-- (send_intake_reminders, show_treatment_time_to_clients, the reminder
-- toggles). 0204 needed a command because its value carries audit columns that
-- an owner must not be able to backdate; this flag has no audit columns, so a
-- command would add surface without adding authority.
--
-- NO DATA IS WRITTEN. `not null default true` with a constant default is added
-- as catalog metadata without rewriting the table. No existing row is touched,
-- no backfill is needed, and applying this file changes no studio's behaviour.

begin;

-- A lock wait must fail the migration rather than queue behind a long
-- transaction and stall writes. `supabase db push` does not wrap a file in a
-- transaction, so this is set INSIDE the explicit transaction above: a bare
-- `set local` outside one emits 25P01 and never arms.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. THE FLAG
-- ---------------------------------------------------------------------------

alter table public.studios
  add column if not exists client_portal_enabled boolean not null default true;

comment on column public.studios.client_portal_enabled is
  'HON-47. FALSE turns off client portal access for this studio: the portal, '
  'its sign-in and magic-link verify, every portal action, portal rebook and '
  'returning-client online booking refuse, and client emails withdraw the '
  'portal and book-again CTAs. Reminders and postcare still deliver by email. '
  'No portal magic link or session can be inserted while FALSE '
  '(client_portal_access_guard). Independent of 0234''s '
  'client_cancellation_enabled / client_reschedule_enabled, and never derived '
  'from new_client_admission_mode. Default TRUE, so an existing studio is '
  'unchanged. Owner-controlled through the "studios: owners update" policy.';

-- ---------------------------------------------------------------------------
-- 2. DEFENCE IN DEPTH: NO PORTAL CREDENTIAL FOR A DISABLED STUDIO
-- ---------------------------------------------------------------------------
--
-- The application refuses first, with copy a client can act on. This guard is
-- the floor beneath it: a future caller that forgets the check, or a stale build
-- during a deploy window, still cannot mint a magic link or a session for a
-- studio whose owner turned the portal off. Both tables carry studio_id NOT NULL
-- (0052), so the studio is always known.
--
-- It does NOT revoke sessions that already exist when the flag flips: the
-- session resolver re-reads the flag on every request and refuses them
-- (lib/portal/session.ts). Revoking here would be a data write this file
-- promises not to make.
--
-- SECURITY DEFINER with a pinned search_path so the studios read is not subject
-- to the inserting role's RLS or search path. The read takes no lock: a flag
-- flip racing an insert lands on either side of it, and the next request is
-- re-checked by the resolver either way.

create or replace function public.client_portal_access_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_enabled boolean;
begin
  select coalesce(s.client_portal_enabled, true)
    into v_enabled
    from public.studios s
   where s.id = new.studio_id;

  -- A missing studio is left to the existing foreign key to refuse.
  if v_enabled is false then
    raise exception
      'client portal access is turned off for this studio'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.client_portal_access_guard() is
  'HON-47. BEFORE INSERT guard on client_portal_magic_links and '
  'client_portal_sessions: refuses (check_violation) when the row''s studio has '
  'client_portal_enabled = FALSE. Defence in depth behind the application gate.';

drop trigger if exists client_portal_magic_links_access_guard
  on public.client_portal_magic_links;
create trigger client_portal_magic_links_access_guard
  before insert on public.client_portal_magic_links
  for each row
  execute function public.client_portal_access_guard();

drop trigger if exists client_portal_sessions_access_guard
  on public.client_portal_sessions;
create trigger client_portal_sessions_access_guard
  before insert on public.client_portal_sessions
  for each row
  execute function public.client_portal_access_guard();

-- ---------------------------------------------------------------------------
-- 3. GRANTS
-- ---------------------------------------------------------------------------
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated AND
-- service_role at create time, so every one is revoked BY NAME (missed once in
-- 0129 for anon and again in 0164 for service_role). A trigger function cannot
-- be called as an RPC, and Postgres checks EXECUTE on it only when the trigger
-- is created, not when it fires. Revoking from every role therefore removes
-- direct reachability without affecting the guard.

revoke all on function public.client_portal_access_guard() from public;
revoke all on function public.client_portal_access_guard() from anon;
revoke all on function public.client_portal_access_guard() from authenticated;
revoke all on function public.client_portal_access_guard() from service_role;

commit;
