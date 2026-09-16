-- ===========================================================================
-- 0197 — A CONSUMED-COUNT THE SERVER CAN ACTUALLY CALL
-- ===========================================================================
--
-- THE DEFECT THIS CLOSES, reproduced before it was written.
--
-- 0192's `waitlist_admission_round_consumed(uuid)` is SECURITY INVOKER and reads
-- `new_client_waitlist_invitations`. `service_role` holds EXECUTE on it and,
-- deliberately, NO SELECT on that table -- so the server's own call fails:
--
--     set role service_role;
--     select public.waitlist_admission_round_consumed('<round>');
--     ERROR:  42501 permission denied for table new_client_waitlist_invitations
--
--     -- the same call as postgres:
--     SUCCEEDED, consumed = 0
--
-- EXECUTE without SELECT is nothing for an invoker function. Every DB test used
-- the admin/postgres connection, which is exactly why 182 passing DB tests never
-- saw it. In the application the failure became `null`, `null` became "capacity
-- unknown", and unknown WITHHELD the send -- so an owner who had correctly opened
-- a capacity still could not invite. It is also the proven cause of two
-- e2e/waitlist-invitation-delivery-status failures.
--
-- WHY NOT JUST GRANT SELECT. Hone deliberately removed direct service_role table
-- authority; handing the server's most privileged client a whole invitation table
-- to render a counter reverses that for a display concern. BYPASSRLS would not
-- help either -- it is irrelevant to ordinary SQL privilege checks.
--
-- WHY NOT MAKE THE CANONICAL FUNCTION DEFINER. That works and is one line, but it
-- lets any service_role caller count seats for ANY round id. This gateway costs
-- one object and validates the studio/round pair the caller must already know.
--
-- WHAT THIS IS NOT. It does NOT re-implement the count. The counting SQL stays in
-- 0192 as the single definition of "used"; this delegates to it. A second copy
-- would be the competing capacity engine the feature must not become.
--
-- 0192 IS NOT EDITED. It is applied and frozen.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- THE GATEWAY
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER, owned by the same role that owns the canonical function and
-- both tables. Inside a definer context the current effective user IS the
-- definer, so the SECURITY INVOKER function it calls inherits that authority --
-- verified behaviourally before this file was written, not assumed:
--
--     service_role -> gateway(valid pair)   -> SUCCEEDED, consumed=0
--     service_role -> gateway(other studio) -> NULL
--     service_role -> gateway(unknown round)-> NULL
--     service_role -> direct table SELECT   -> still DENIED
--
-- TENANCY IS VALIDATED HERE, not assumed of the caller. The application reads
-- the round with the OWNER'S OWN RLS-scoped client and passes the studio it is
-- already scoped to, so a mismatched pair means something upstream is wrong --
-- and the answer is NULL rather than another studio's number.
--
-- NULL IS "NO ANSWER", NEVER "ZERO". Zero is a real count meaning an untouched
-- capacity; returning it for an unknown pair would present a full round as
-- completely free. Callers must treat NULL as unknown and withhold.
--
-- INTEGER OUT, NOTHING ELSE. No row, no column, no identifier is returned, so
-- the gateway cannot become a read path for the table behind it.
create or replace function public.read_waitlist_admission_round_consumed(
  p_studio_id uuid,
  p_round_id  uuid
)
returns integer
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_consumed integer;
begin
  -- A null either side is a caller that did not say, which is not a round.
  if p_studio_id is null or p_round_id is null then
    return null;
  end if;

  if not exists (
    select 1
      from public.studio_waitlist_admission_rounds r
     where r.id = p_round_id
       and r.studio_id = p_studio_id
  ) then
    return null;
  end if;

  -- DELEGATION, NOT DUPLICATION. 0192 owns what "used" means.
  v_consumed := public.waitlist_admission_round_consumed(p_round_id);
  return v_consumed;
end;
$$;

comment on function public.read_waitlist_admission_round_consumed(uuid, uuid) is
  'WAIT-CAPACITY-01 (0197): the server-callable consumed-seat count. 0192''s '
  'canonical waitlist_admission_round_consumed is SECURITY INVOKER and reads '
  'new_client_waitlist_invitations, which service_role deliberately cannot '
  'SELECT -- so the application call failed with 42501 and the capacity read as '
  'unknown, withholding the send. This gateway is SECURITY DEFINER, validates '
  'that the round belongs to the studio, and DELEGATES the counting to 0192 so '
  '"used" keeps one definition. Returns NULL for an unmatched pair: NULL is "no '
  'answer", never "zero". service_role EXECUTE only; no table privilege is '
  'granted to anyone by this file.';

-- ---------------------------------------------------------------------------
-- PRIVILEGES — service_role alone, by name, nothing inherited
-- ---------------------------------------------------------------------------
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated AND
-- service_role at function-create time, so all four are stripped BY NAME before
-- anything is granted back. Missed for anon in 0129 and for service_role in
-- 0164; pinned by the repository's grant guards ever since.
--
-- THE BROWSER NEVER REACHES THIS. A definer function that anon or authenticated
-- could execute would be a table read with extra steps.
revoke all privileges on function public.read_waitlist_admission_round_consumed(uuid, uuid) from public;
revoke all privileges on function public.read_waitlist_admission_round_consumed(uuid, uuid) from anon;
revoke all privileges on function public.read_waitlist_admission_round_consumed(uuid, uuid) from authenticated;
revoke all privileges on function public.read_waitlist_admission_round_consumed(uuid, uuid) from service_role;
grant  execute on function public.read_waitlist_admission_round_consumed(uuid, uuid) to service_role;

-- NO TABLE GRANT IS MADE HERE, DELIBERATELY. service_role's direct SELECT on
-- new_client_waitlist_invitations and studio_waitlist_admission_rounds stays
-- FALSE; the gateway is the only way through, and that is the point.

commit;
