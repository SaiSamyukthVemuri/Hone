-- ===========================================================================
-- 0196 — WHAT HAPPENED TO THE INVITATION EMAIL, WRITTEN DOWN
-- ===========================================================================
--
-- THE DEFECT THIS CLOSES. The delivery disposition was computed correctly and
-- then existed only in React state. Three separate review findings were three
-- different ways to unmount it: `revalidatePath`, queue navigation, and ancestor
-- navigation. Each point fix closed one exit and left the class intact — and
-- none of them could survive a reload, a back button, or a closed tab.
--
-- A practitioner who looked away learned nothing. `committed + refused` is
-- exactly the case where not knowing invites a retry, and a retry burns another
-- round allowance on someone who already holds an invitation.
--
-- WHY A COLUMN AND NOT A NEW TABLE. The practitioner surface ALREADY reads this
-- row, already scoped: `select ... from new_client_waitlist_invitations where
-- studio_id = <server value> and entry_id in (...)`, under RLS policy
-- `new_client_waitlist_invitations_owner_select` -> `is_studio_owner(studio_id)`.
-- The fact belongs to exactly one invitation and has the same lifetime. A new
-- table would need its own policy, its own grants and its own join for nothing.
--
-- WHAT IS DELIBERATELY NOT STORED. No raw token, no proof code or capability, no
-- email subject or body, no recipient address, no provider credential, no
-- provider payload or message id, and no resend/reissue authority. The row
-- answers one question — what did the provider do with this one send — and
-- carries nothing that could be replayed.
-- ===========================================================================

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------
-- 1. THE FACT
--
-- NULL IS NOT "unknown", AND THAT DISTINCTION IS THE POINT. `unknown` is an
-- OBSERVED state: the provider was asked and the answer was unreadable, or the
-- attempt timed out. NULL means nothing was ever recorded — no send has reported
-- back. Collapsing them would let a surface claim "delivery could not be
-- confirmed" about an invitation nobody has tried to deliver yet.
-- ---------------------------------------------------------------------
alter table public.new_client_waitlist_invitations
  add column if not exists delivery_disposition text,
  add column if not exists delivery_recorded_at timestamptz;

-- The three words are the application's own vocabulary
-- (`InvitationDeliveryState`). A fourth would have to be taught to every reader,
-- so the database refuses one.
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_delivery_disposition_check;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_delivery_disposition_check
  check (
    delivery_disposition is null
    or delivery_disposition in ('accepted', 'refused', 'unknown')
  );

-- ALL-OR-NOTHING, the same shape 0192 uses for offer scope. A disposition with
-- no timestamp cannot be ordered against anything, and a timestamp with no
-- disposition records that something happened without saying what.
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_delivery_complete_check;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_delivery_complete_check
  check (
    (delivery_disposition is null and delivery_recorded_at is null)
    or (delivery_disposition is not null and delivery_recorded_at is not null)
  );

-- ---------------------------------------------------------------------
-- 2. THE READ
--
-- Column-level SELECT for `authenticated`, matching the nine columns this table
-- already exposes. `token_hash`, every `proof_*` field and the scope columns are
-- withheld from that role and stay withheld; this adds two operational columns
-- and nothing else. RLS still decides WHICH rows: `is_studio_owner(studio_id)`.
-- ---------------------------------------------------------------------
grant select (delivery_disposition, delivery_recorded_at)
  on public.new_client_waitlist_invitations to authenticated;

-- ---------------------------------------------------------------------
-- 3. THE WRITE
--
-- FIRST OBSERVATION WINS, AND A CONTRADICTION IS REFUSED RATHER THAN APPLIED.
--
-- One send produces one provider outcome. A later call claiming a DIFFERENT
-- disposition for the same invitation is far more likely a bug — a duplicated
-- request, a retried action, a racing worker — than a correction, and silently
-- overwriting would destroy the first observation with no trace. So:
--
--   nothing recorded yet            -> record it, return 'recorded'
--   recorded, SAME disposition      -> no-op,     return 'unchanged'  (idempotent)
--   recorded, DIFFERENT disposition -> refuse,    return 'conflict'   (nothing written)
--
-- That rule is deterministic, makes a repeated delivery attempt safe, and keeps
-- the audit honest. `conflict` is a closed code the caller can log; it is NOT an
-- error, because the invitation and the admission are unaffected either way.
--
-- THIS COMMAND CANNOT UN-INVITE ANYBODY. It touches two columns on one row. It
-- does not read or write status, does not resend, does not reissue, does not
-- expire, and has no path to the entry lifecycle at all. A failure here leaves
-- the committed invitation exactly as it was — which is why the caller may treat
-- it as fail-soft.
-- ---------------------------------------------------------------------
create or replace function public.record_waitlist_invitation_delivery(
  p_studio_id     uuid,
  p_invitation_id uuid,
  p_disposition   text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_existing text;
begin
  if p_studio_id is null or p_invitation_id is null then
    return 'invalid_input';
  end if;
  -- The three words, refused here as well as by the CHECK so the caller gets a
  -- closed code instead of a constraint violation.
  if p_disposition is null
     or p_disposition not in ('accepted', 'refused', 'unknown') then
    return 'invalid_disposition';
  end if;

  -- Scoped by BOTH id and studio, so an invitation from another studio is simply
  -- not found rather than refused with a message that confirms it exists.
  select i.delivery_disposition
    into v_existing
    from public.new_client_waitlist_invitations i
   where i.id = p_invitation_id
     and i.studio_id = p_studio_id
     for update;

  if not found then
    return 'not_found';
  end if;

  if v_existing is not null then
    -- Idempotent repeat, or a contradiction that is refused without writing.
    return case when v_existing = p_disposition then 'unchanged' else 'conflict' end;
  end if;

  update public.new_client_waitlist_invitations i
     set delivery_disposition = p_disposition,
         delivery_recorded_at = clock_timestamp()
   where i.id = p_invitation_id
     and i.studio_id = p_studio_id
     -- Belt and braces under the row lock: only ever fills an EMPTY slot, so two
     -- racing callers cannot both write.
     and i.delivery_disposition is null;

  return 'recorded';
end;
$$;

comment on function public.record_waitlist_invitation_delivery(uuid, uuid, text) is
'Record the provider outcome for ONE invitation send. First observation wins. A '
'repeat with the same disposition is a no-op, and a contradicting repeat is '
'refused without writing. Carries no secret material and cannot alter admission '
'or invitation lifecycle truth.';

-- Supabase grants EXECUTE to anon, authenticated AND service_role at
-- function-create time via ALTER DEFAULT PRIVILEGES. Revoke from all four by
-- name — 0129 missed `anon` and 0164 missed `service_role` this exact way.
revoke execute on function public.record_waitlist_invitation_delivery(uuid, uuid, text) from public;
revoke execute on function public.record_waitlist_invitation_delivery(uuid, uuid, text) from anon;
revoke execute on function public.record_waitlist_invitation_delivery(uuid, uuid, text) from authenticated;
revoke execute on function public.record_waitlist_invitation_delivery(uuid, uuid, text) from service_role;
grant  execute on function public.record_waitlist_invitation_delivery(uuid, uuid, text) to service_role;

commit;
