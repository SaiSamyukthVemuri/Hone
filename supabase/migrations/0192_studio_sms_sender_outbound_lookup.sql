-- ---------------------------------------------------------------------------
-- 0192 — OUTBOUND SENDER LOOKUP (COMMS-01B2)
-- ---------------------------------------------------------------------------
--
-- 0191 gave every studio a sender row and then deliberately made its provider
-- identifiers unreachable by role:
--
--     revoke all on public.studio_sms_senders
--       from public, anon, authenticated, service_role;
--
-- and re-granted a COLUMN-LEVEL select to `authenticated` that omits
-- `messaging_service_sid`, `phone_number_sid` and `provisioning_claim_key`, so
-- a Twilio SID can never become something a browser knows and therefore never
-- something it can echo back as authority.
--
-- That boundary is correct and this migration does not weaken it. `service_role`
-- still holds NO table privilege on public.studio_sms_senders, and none is
-- granted here.
--
-- WHAT IS MISSING IS ONE CAPABILITY, NOT ONE GRANT. Outbound delivery has to
-- know which messaging service a studio's message leaves from. Under 0191 the
-- server dispatcher cannot ask: a direct select fails at the privilege layer for
-- exactly the role that sends. So the sender was still resolved from a
-- deployment-global environment variable, which is the defect COMMS-01B2 exists
-- to remove -- a studio could own a provisioned, provider-tested number while
-- every one of its client messages left from Hone's shared one, silently.
--
-- This adds the narrowest thing that closes it: one SECURITY DEFINER lookup that
-- answers a single question -- which messaging service does THIS studio send
-- from, right now -- and returns nothing else. It is the outbound twin of
-- 0191's `resolve_studio_by_sms_messaging_service`, which answers the inbound
-- direction, and it follows that function's shape exactly.
--
-- WHAT IT DELIBERATELY DOES NOT RETURN: the claim key, the provisioning lease,
-- `phone_number_sid`, any reconciliation internal, any other studio's row, or
-- any historical sender. `phone_number` is omitted too -- transport routes by
-- messaging service, so returning the number would be authority the caller has
-- no use for.
--
-- NO PICK-FIRST. It returns a SET rather than a scalar. 0191's
-- `studio_sms_senders_one_live_per_studio` -- UNIQUE (studio_id) WHERE
-- status <> 'released' -- already makes two live rows impossible, so the set is
-- expected to hold zero or one. Returning a scalar would have silently answered
-- with whichever row PostgreSQL reached first if that invariant were ever
-- violated; returning a set lets the caller see the ambiguity and fail closed.
-- The database refuses to manufacture a winner it cannot justify.
--
-- ABSENCE IS NOT FAILURE. Zero rows means this studio has no ACTIVE sender --
-- a configuration fact the caller reports as non-retryable. A read that throws
-- is a different answer and the caller treats it as retryable. This function
-- never conflates them, because it never converts "no rows" into an error.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- `active` and nothing else. 0191's status vocabulary also contains 'off',
-- 'selecting', 'provisioning', 'suspended', 'error', 'releasing' and
-- 'released'; not one of them may route a live message. `active` is the only
-- status the readiness CHECK proves complete -- it is unreachable without both
-- provider SIDs, the number, a provisioned instant and a successful provider
-- test -- so it is the only status whose messaging service is known to work.
--
-- 'suspended' is excluded on purpose even though the inbound resolver accepts
-- it: an inbound callback from a suspended sender still has to be attributed to
-- the studio it came from, but an outbound message must not leave from one.
create or replace function public.resolve_active_studio_sms_sender(
  p_studio_id uuid
)
returns table (messaging_service_sid text)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select s.messaging_service_sid
    from public.studio_sms_senders s
   where s.studio_id = p_studio_id
     and s.status = 'active';
$$;

comment on function public.resolve_active_studio_sms_sender(uuid) is
  'COMMS-01B2. Resolve the messaging service a studio''s OUTBOUND SMS must leave from. The outbound twin of resolve_studio_by_sms_messaging_service. Returns the ACTIVE sender''s messaging_service_sid and nothing else -- no claim key, no lease, no phone_number_sid, no other studio, no historical row. Returns a SET, not a scalar: one live row per studio is already guaranteed by studio_sms_senders_one_live_per_studio, and returning a set means a violated invariant surfaces as ambiguity for the caller to refuse rather than as a silently chosen first row. Zero rows means no ACTIVE sender -- a configuration fact, never an error. This does not widen 0191: service_role still holds no table privilege on public.studio_sms_senders, and provider identifiers remain unreachable by every browser role. service_role only.';

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated AND
-- service_role at function-create time. Every one is revoked BY NAME before
-- anything is granted -- the 0129 (`anon`) and 0164 (`service_role`) failure
-- class, which 0191 also guards against in the same shape.

revoke execute on function public.resolve_active_studio_sms_sender(uuid) from public;
revoke execute on function public.resolve_active_studio_sms_sender(uuid) from anon;
revoke execute on function public.resolve_active_studio_sms_sender(uuid) from authenticated;
revoke execute on function public.resolve_active_studio_sms_sender(uuid) from service_role;

-- The server dispatcher runs as service_role, and it is the only caller.
grant execute on function public.resolve_active_studio_sms_sender(uuid) to service_role;

-- NO TABLE GRANT IS ADDED HERE, DELIBERATELY. If a future change needs one,
-- that is a different decision with a different blast radius and belongs in its
-- own migration with its own review -- not smuggled in beside a lookup.

commit;
