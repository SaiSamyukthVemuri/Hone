-- ===========================================================================
-- 0227 — DELIVERY-QUARANTINE-BOUND-01: bound the receipt sweep's quarantine
-- step by the caller's limit (#824, Codex P2 4252980865 on #832)
-- ===========================================================================
--
-- 0212 is APPLIED to production and frozen, so this is a forward fix. It
-- redefines exactly one function, public.claim_email_provider_events(uuid,
-- integer), and nothing else.
--
-- THE DEFECT. In 0212, the sweep path (p_event_id IS NULL) first quarantined
-- EVERY pending receipt that had spent its five attempts, in one locking
-- UPDATE, whatever p_limit the caller asked for. Only the claim step that
-- follows honoured the limit. After a processor outage that leaves a large
-- exhausted backlog, every caller -- including /api/resend/webhook, which
-- asks for a five-row sweep after its own receipt -- would lock and update
-- the whole backlog in one statement, so the webhook could time out exactly
-- while it is meant to be recovering.
--
-- THE FIX. The quarantine step takes the same bound as the claim step:
--   - a targeted call (p_event_id) still touches at most that one receipt;
--   - a sweep quarantines at most v_limit receipts, the OLDEST first
--     (received_at, then id, served by email_provider_events_pending_idx);
--   - FOR UPDATE SKIP LOCKED is kept, so two concurrent sweeps take disjoint
--     batches and never wait on each other.
-- The claim step also gains the id tie-break, so its order is deterministic
-- when two receipts share a received_at.
--
-- UNCHANGED, deliberately: the signature, the return shape, SECURITY
-- DEFINER, the pinned search_path, the five-attempt cap, the two-minute
-- claim lease, the one-minute sweep age, the 1..50 limit clamp, the
-- quarantine outcome (quarantined / processing_exhausted) and the grants
-- (service_role only, restated by name below). A larger exhausted backlog
-- now drains over successive sweeps instead of in one statement.
-- ===========================================================================

begin;

set local lock_timeout = '5s';

create or replace function public.claim_email_provider_events(
  p_event_id uuid,
  p_limit    integer
) returns table (
  receipt_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  c_max_attempts constant integer  := 5;
  c_claim_ttl    constant interval := interval '2 minutes';
  c_sweep_age    constant interval := interval '1 minute';
  v_limit        integer;
begin
  v_limit := case
    when p_event_id is not null then 1
    else greatest(1, least(coalesce(p_limit, 10), 50))
  end;

  -- Quarantine: bounded by v_limit, oldest first, skipping rows another
  -- caller holds (0227; 0212 updated the whole exhausted backlog here).
  with spent as (
    select e.id
      from public.email_provider_events e
     where e.processing_state = 'pending'
       and e.processing_attempts >= c_max_attempts
       and (e.processing_claimed_at is null
            or e.processing_claimed_at < now() - c_claim_ttl)
       and (p_event_id is null or e.id = p_event_id)
     order by e.received_at, e.id
     limit v_limit
     for update skip locked
  )
  update public.email_provider_events e
     set processing_state      = 'quarantined',
         processing_result     = 'processing_exhausted',
         processed_at          = now(),
         processing_claimed_at = null
    from spent
   where e.id = spent.id;

  return query
  with candidates as (
    select e.id
      from public.email_provider_events e
     where e.processing_state = 'pending'
       and e.processing_attempts < c_max_attempts
       and (e.processing_claimed_at is null
            or e.processing_claimed_at < now() - c_claim_ttl)
       and (case
              when p_event_id is not null then e.id = p_event_id
              else e.received_at < now() - c_sweep_age
            end)
     order by e.received_at, e.id
     limit v_limit
     for update skip locked
  )
  update public.email_provider_events e
     set processing_attempts   = e.processing_attempts + 1,
         processing_claimed_at = now()
    from candidates
   where e.id = candidates.id
  returning e.id;
end;
$$;

-- Grants restated by name (CLAUDE.md §5): CREATE OR REPLACE keeps the
-- existing ACL, and this makes the intended ACL explicit and re-checkable.
revoke execute on function public.claim_email_provider_events(uuid, integer) from public;
revoke execute on function public.claim_email_provider_events(uuid, integer) from anon;
revoke execute on function public.claim_email_provider_events(uuid, integer) from authenticated;
revoke execute on function public.claim_email_provider_events(uuid, integer) from service_role;
grant execute on function public.claim_email_provider_events(uuid, integer) to service_role;

comment on function public.claim_email_provider_events(uuid, integer) is
  'Claim one named receipt, or sweep up to 50 pending receipts at least a minute old, counting each attempt before it is made; a receipt that has spent five attempts is quarantined as processing_exhausted. Both steps are bounded by the same limit (one for a named receipt, the clamped p_limit for a sweep), oldest first, skipping receipts another caller holds (0227). Returns the claimed receipt ids. service_role only.';

commit;
