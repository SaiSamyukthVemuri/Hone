-- ===========================================================================
-- 0227 — DELIVERY-QUARANTINE-BOUND-01: forward fixes to the applied 0212
-- (#824): bound the receipt sweep's quarantine step by the caller's limit
-- (Codex P2 4252980865), and keep Resend's transient bounces non-terminal
-- (Codex P2 4265450918)
-- ===========================================================================
--
-- 0212 is APPLIED to production and frozen, so these are forward fixes. It
-- redefines exactly two functions, public.claim_email_provider_events(uuid,
-- integer) and public.process_email_provider_event(uuid), and nothing else.
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
--
-- THE SECOND DEFECT (Codex P2 4265450918). 0212's processor ranked every
-- email.bounced as terminal (rank 5). Resend's Transient bounce is a soft
-- bounce: the message may still be delivered. A later email.delivered then
-- ranked 4 <= 5 and was classified stale, so the ledger and the owner's view
-- reported a bounce for a delivered email, permanently.
--
-- THE FIX. A bounce whose normalised bounce_type is 'transient' (the
-- normaliser's slug of Resend's "Transient") is recorded as delivery_delayed
-- (rank 3): not delivered and not failed, and a later delivered or permanent
-- bounce still advances it. bounce_type stays null on that row, as the
-- ledger's check requires for any non-bounced status; the receipt keeps the
-- provider's bounce type. Permanent, undetermined and any other bounce type
-- remain terminal. The function is otherwise byte-for-byte 0212's.
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

-- ---------------------------------------------------------------------------
-- process_email_provider_event: transient bounces stay non-terminal
-- ---------------------------------------------------------------------------

create or replace function public.process_email_provider_event(
  p_event_id uuid
) returns table (
  result            text,
  reason            text,
  message_id        uuid,
  message_studio_id uuid,
  message_status    text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_evt         record;
  v_msg         record;
  v_matched     boolean := false;
  v_msg_id      uuid;
  v_msg_studio  uuid;
  v_target      text;
  v_old_rank    integer;
  v_new_rank    integer;
  v_state       text;
  v_reason      text;
  v_status      text;
  v_event_at    timestamptz;
begin
  if p_event_id is null then
    return query select 'invalid_input'::text, null::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  select e.id, e.event_type, e.provider_email_id, e.hone_message_id,
         e.provider_created_at, e.bounce_type, e.bounce_subtype,
         e.failure_reason, e.suppression_type, e.processing_state,
         e.processing_result, e.email_message_id
    into v_evt
    from public.email_provider_events e
   where e.id = p_event_id
     for update;

  if not found then
    return query select 'not_found'::text, null::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  if v_evt.processing_state <> 'pending' then
    return query select 'already_processed'::text, v_evt.processing_result,
      v_evt.email_message_id, null::uuid, null::text;
    return;
  end if;

  v_event_at := coalesce(v_evt.provider_created_at, now());

  v_target := case v_evt.event_type
    when 'email.sent'             then 'sent'
    when 'email.delivery_delayed' then 'delivery_delayed'
    when 'email.delivered'        then 'delivered'
    when 'email.bounced'          then 'bounced'
    when 'email.failed'           then 'failed'
    when 'email.suppressed'       then 'suppressed'
    when 'email.complained'       then 'complained'
    else null
  end;

  -- 0227 (Codex P2 4265450918): Resend's Transient bounce is a soft bounce;
  -- the message may still be delivered. It is recorded as delivery_delayed
  -- (rank 3, not terminal), so a later email.delivered or a permanent bounce
  -- still advances the row. Permanent and any other bounce type stay terminal.
  if v_target = 'bounced' and v_evt.bounce_type = 'transient' then
    v_target := 'delivery_delayed';
  end if;

  if v_target is null then
    if v_evt.event_type in ('email.opened', 'email.clicked') then
      v_state := 'ignored';
      v_reason := 'engagement_not_delivery';
    else
      v_state := 'quarantined';
      v_reason := 'unknown_event_type';
    end if;
  elsif v_evt.provider_email_id is null then
    v_state := 'quarantined';
    v_reason := 'missing_email_id';
  else
    -- The tag names the row Hone created for this attempt. Without one, the
    -- provider email id is the only key.
    if v_evt.hone_message_id is not null then
      select m.id, m.studio_id, m.status, m.provider_email_id, m.complained_at
        into v_msg
        from public.email_outbound_messages m
       where m.id = v_evt.hone_message_id
         for update;
      v_matched := found;
      if not v_matched then
        v_state := 'unmatched';
        v_reason := 'unmatched_tag';
      end if;
    else
      select m.id, m.studio_id, m.status, m.provider_email_id, m.complained_at
        into v_msg
        from public.email_outbound_messages m
       where m.provider_email_id = v_evt.provider_email_id
         for update;
      v_matched := found;
      if not v_matched then
        v_state := 'unmatched';
        v_reason := 'unmatched_email_id';
      end if;
    end if;

    if v_matched then
      v_msg_id := v_msg.id;
      v_msg_studio := v_msg.studio_id;
      if v_msg.provider_email_id is not null
         and v_msg.provider_email_id <> v_evt.provider_email_id then
        -- The tag and the provider disagree about which message this is.
        v_state := 'quarantined';
        v_reason := 'email_id_mismatch';
      elsif v_msg.status in ('skipped', 'refused') then
        -- Hone recorded that this attempt never reached the provider.
        v_state := 'quarantined';
        v_reason := 'not_sent';
      elsif v_msg.provider_email_id is null and exists (
        select 1 from public.email_outbound_messages o
         where o.provider_email_id = v_evt.provider_email_id
           and o.id <> v_msg.id
      ) then
        v_state := 'quarantined';
        v_reason := 'email_id_conflict';
      else
        v_old_rank := case v_msg.status
          when 'claimed'          then 0
          when 'unknown'          then 0
          when 'accepted'         then 1
          when 'sent'             then 2
          when 'delivery_delayed' then 3
          when 'delivered'        then 4
          else 5  -- bounced | failed | suppressed: terminal
        end;

        if v_target = 'complained' then
          -- A complaint is about a delivered message: it records the
          -- complaint once and lifts an earlier status to delivered.
          if v_msg.complained_at is null or v_old_rank < 4 then
            update public.email_outbound_messages m
               set complained_at      = coalesce(m.complained_at, v_event_at),
                   status             = case when v_old_rank < 4 then 'delivered' else m.status end,
                   provider_email_id  = coalesce(m.provider_email_id, v_evt.provider_email_id),
                   provider_status_at = case when v_old_rank < 4 then v_event_at else m.provider_status_at end,
                   settled_at         = coalesce(m.settled_at, now())
             where m.id = v_msg.id
            returning m.status into v_status;
            v_state := 'applied';
            v_reason := 'complaint_recorded';
          else
            v_status := v_msg.status;
            v_state := 'stale';
            v_reason := 'duplicate_complaint';
          end if;
        else
          v_new_rank := case v_target
            when 'sent'             then 2
            when 'delivery_delayed' then 3
            when 'delivered'        then 4
            else 5
          end;

          if v_new_rank <= v_old_rank then
            -- Late, repeated or out of order: the row already says more.
            v_status := v_msg.status;
            v_state := 'stale';
            v_reason := 'not_forward';
          else
            -- A claimed or unknown row also adopts the provider's email id
            -- here: the provider is reporting that it has the message, which
            -- is exactly what an ambiguous answer could not say.
            update public.email_outbound_messages m
               set status             = v_target,
                   provider_email_id  = coalesce(m.provider_email_id, v_evt.provider_email_id),
                   provider_status_at = v_event_at,
                   settled_at         = coalesce(m.settled_at, now()),
                   bounce_type        = case when v_target = 'bounced' then v_evt.bounce_type else null end,
                   provider_reason    = case v_target
                                          when 'bounced'    then v_evt.bounce_subtype
                                          when 'failed'     then v_evt.failure_reason
                                          when 'suppressed' then v_evt.suppression_type
                                          else null
                                        end
             where m.id = v_msg.id
            returning m.status into v_status;
            v_state := 'applied';
            v_reason := 'status_advanced';
          end if;
        end if;
      end if;
    end if;
  end if;

  update public.email_provider_events e
     set processing_state      = v_state,
         processing_result     = v_reason,
         processed_at          = now(),
         processing_claimed_at = null,
         email_message_id      = case when v_state in ('applied', 'stale') then v_msg_id else null end
   where e.id = p_event_id;

  if v_state in ('applied', 'stale') then
    return query select v_state, v_reason, v_msg_id, v_msg_studio, v_status;
  else
    return query select v_state, v_reason, null::uuid, null::uuid, null::text;
  end if;
end;
$$;

revoke execute on function public.process_email_provider_event(uuid) from public;
revoke execute on function public.process_email_provider_event(uuid) from anon;
revoke execute on function public.process_email_provider_event(uuid) from authenticated;
revoke execute on function public.process_email_provider_event(uuid) from service_role;
grant execute on function public.process_email_provider_event(uuid) to service_role;

comment on function public.process_email_provider_event(uuid) is
  'Apply one receipt exactly once, in one transaction: forward-only status on the matched ledger row, or an unmatched / ignored / quarantined outcome attributable to no studio. A transient (soft) bounce is recorded as delivery_delayed, not as a terminal bounce (0227). Returns (result, reason, message_id, message_studio_id, message_status). service_role only.';

commit;
