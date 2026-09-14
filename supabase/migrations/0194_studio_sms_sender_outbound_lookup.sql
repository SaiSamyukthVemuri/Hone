-- ---------------------------------------------------------------------------
-- 0194 — OUTBOUND SENDER LOOKUP (COMMS-01B2)
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

-- ---------------------------------------------------------------------------
-- ONE OPEN ROUTING ALERT PER STUDIO PER REASON — enforced by the database
-- ---------------------------------------------------------------------------
--
-- The application dedupes routing alerts by reading `ops_alerts` for an
-- unresolved row and inserting only when it finds none. That is check-then-act:
-- two concurrent sends for the same studio -- a booking and a cron pass, or two
-- cron passes overlapping -- can both observe no open row and both insert. The
-- invariant the operator actually relies on ("tell me once that this studio
-- cannot send") is not enforceable in application code, because the two
-- statements are not one decision.
--
-- So the database owns it. This is the same shape `ops_alerts` already uses for
-- `calendar_enqueue_skipped`: a PARTIAL UNIQUE INDEX over unresolved rows,
-- scoped to specific events. Nothing about any other alert class changes.
--
-- NARROW BY CONSTRUCTION, in two directions at once:
--   * `where resolved_at is null` -- only OPEN alerts collide. Resolving one
--     therefore RE-ARMS the condition: a recurrence after an operator resolves
--     the row inserts a new alert, so nothing is suppressed forever.
--   * `and event in (...)` -- only these three SMS routing events. Every other
--     ops_alerts event keeps exactly the semantics it has today, including the
--     ability to record many open rows for one studio.
--
-- The three events stay SEPARATE keys deliberately. "No active sender", "more
-- than one active sender" and "the lookup itself is broken" need different
-- operator actions, and one being open must never hide another.
--
-- studio_id is nullable, and PostgreSQL treats NULLs as distinct in a unique
-- index. A routing alert with no studio therefore never dedupes -- which is the
-- existing application behaviour, preserved rather than changed.
--
-- CONFLICT IS A DEDUPE, NOT A FAILURE. The insert loser gets 23505; the caller
-- reads that as "already reported" and returns a deduped outcome. It must never
-- be surfaced as an alerting fault, and it never fails the send: the routing
-- refusal is decided before any of this and is unaffected.
create unique index if not exists ops_alerts_sms_routing_open_uniq
  on public.ops_alerts (studio_id, event)
  where resolved_at is null
    and event in (
      'sms_sender_not_active_for_studio',
      'sms_sender_ambiguous',
      'sms_sender_read_failed'
    );

comment on index public.ops_alerts_sms_routing_open_uniq is
  'COMMS-01B2. At most ONE unresolved ops_alert per (studio, SMS routing event). The application dedupe is check-then-act and cannot hold this under concurrency, so the invariant lives here. Partial on resolved_at is null, so resolving an alert re-arms it; scoped to the three sms_sender_* routing events, so no other alert class is affected. A 23505 from this index means ALREADY REPORTED, not a failure.';

commit;
