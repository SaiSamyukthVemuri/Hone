-- ===========================================================================
-- 0199 — BOUNDED SERVER-SIDE REMINDER CANDIDATE SELECTION
-- ===========================================================================
--
-- WAIT S3 Part 2. One read-only function. No table, no column, no backfill,
-- no data rewrite, no privilege widening.
--
-- ---------------------------------------------------------------------------
-- THE DEFECT THIS CLOSES
-- ---------------------------------------------------------------------------
--
-- A routing refusal is deliberately free: nothing sent, no attempt claimed,
-- `sent_at` left null. Correct per appointment, and it means an unroutable
-- row's ELIGIBILITY IS UNCHANGED, so it sorts into the same position on every
-- later pass. A fixed page of 50 was therefore filled forever by the same
-- unroutable prefix while a routable suffix was never loaded at all.
--
-- Three application-side repairs each moved the boundary without removing the
-- property:
--
--   keyset paging          fixed ONE invocation; later runs restarted at the
--                          beginning, so the limit simply moved from 50 to the
--                          scan ceiling.
--   studio pre-filter      removed unroutable rows from selection, but the
--                          application had to ENUMERATE THE ESTATE to do it:
--                          one sequential resolver round trip per studio, per
--                          window, before a single appointment was read.
--   paging that enumeration  made the estate read correct and thereby made the
--                          previous two costs unbounded — and carried every
--                          routable studio uuid through one PostgREST `.in()`
--                          URL, which a proxy can reject outright.
--
-- Each fix was right about its own defect and wrong about where the work
-- belonged. The predicate "this appointment's studio can send" is a join, and
-- a join belongs in the database. Answered here, the application asks one
-- bounded question and receives one bounded page: no estate enumeration, no
-- per-studio round trips, no id list in a request target.
--
-- ---------------------------------------------------------------------------
-- THIS IS A CANDIDATE FILTER. IT IS NOT SEND AUTHORITY.
-- ---------------------------------------------------------------------------
--
-- Being returned by this function means an appointment is WORTH LOADING. It
-- does not mean a message may be sent.
--
-- Every selected appointment still passes the unchanged send law in
-- `sendOne`: consent / studio toggle / STOP, then
-- `resolve_active_studio_sms_sender` AGAIN, then refuse on anything except
-- exactly one usable sender, and only then claim. A studio whose sender is
-- revoked, duplicated or made unreadable between this selection and the send
-- is refused there — fail-closed, zero provider call, zero attempt consumed.
--
-- THAT IS WHY NO SENDER IDENTIFIER IS RETURNED. Returning
-- `messaging_service_sid` here would save a round trip and would quietly turn
-- a hint into the authority: a caller holding a sid has every incentive to use
-- it rather than re-resolve, and the fail-closed window above would close. The
-- canonical resolver stays the last word immediately before the claim, so this
-- function deliberately cannot answer "what do I send from" — only "is this
-- row worth looking at".
--
-- The `exists` semi-join below is deliberate rather than a join: a join
-- against `studio_sms_senders` would duplicate an appointment if the
-- one-live-per-studio invariant were ever violated, silently inflating a page
-- and double-loading a row. A semi-join cannot fan out whatever the table
-- holds.
-- ===========================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- The function.
--
-- STABLE and read-only: it performs no write of any kind. SECURITY DEFINER
-- because `studio_sms_senders` is closed to every role — 0191 revoked ALL from
-- public, anon, authenticated AND service_role, and 0194 exists precisely
-- because a direct read could never have worked. This does not weaken that:
-- the table privileges are untouched and no sender identifier leaves the
-- function.
--
-- `p_kind` is a closed vocabulary rather than a column name, so no caller can
-- steer which column is read and there is no dynamic SQL to inject into.
-- ---------------------------------------------------------------------------
create or replace function public.reminder_sms_candidates(
  p_kind             text,
  p_window_start     timestamptz,
  p_window_end       timestamptz,
  p_after_starts_at  timestamptz,
  p_after_id         uuid,
  p_limit            integer,
  p_max_attempts     integer
)
returns table (appointment_id uuid, starts_at timestamptz, studio_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select a.id, a.starts_at, a.studio_id
    from public.appointments a
    join public.studios st on st.id = a.studio_id
   where p_kind in ('24h', '2h')
     and a.status = 'confirmed'
     and a.starts_at >= p_window_start
     and a.starts_at <= p_window_end

     -- UNSENT, and under the attempt cap, for THIS window only.
     and case p_kind
           when '24h' then a.sms_reminder_24h_sent_at is null
           else            a.sms_reminder_2h_sent_at  is null
         end
     and case p_kind
           when '24h' then coalesce(a.sms_reminder_24h_send_attempts, 0)
           else            coalesce(a.sms_reminder_2h_send_attempts, 0)
         end < coalesce(p_max_attempts, 3)

     -- The studio's own toggle for THIS window. Same gate the per-row check
     -- applies; applying it here means a toggled-off studio never occupies a
     -- page slot.
     and case p_kind
           when '24h' then st.send_24h_sms_reminders
           else            st.send_2h_sms_reminders
         end is true

     -- THE ROUTING PREREQUISITE, as a semi-join. Exactly the condition the
     -- application previously spent an estate enumeration and one RPC per
     -- studio to discover.
     and exists (
       select 1
         from public.studio_sms_senders s
        where s.studio_id = a.studio_id
          and s.status = 'active'
     )

     -- KEYSET, not OFFSET. Eligibility shifts under a paging run — a row sends
     -- and stamps its column, another is cancelled — so an offset names a
     -- COUNT of rows that preceded the page and steps over rows when the
     -- prefix shrinks. A keyset names a POSITION. `id` is the tiebreak, so
     -- (starts_at, id) is a TOTAL order and no row can be re-emitted on one
     -- page while another is skipped.
     and (
       p_after_starts_at is null
       or a.starts_at > p_after_starts_at
       or (a.starts_at = p_after_starts_at and a.id > coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
     )

   order by a.starts_at asc, a.id asc

   -- BOUNDED BY CONSTRUCTION. A caller cannot ask for an unbounded page, and a
   -- missing or absurd limit collapses to something safe rather than to "all
   -- rows". The ceiling is well above the caller's page size so the `limit+1`
   -- lookahead that proves truncation still fits.
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

comment on function public.reminder_sms_candidates(text, timestamptz, timestamptz, timestamptz, uuid, integer, integer) is
  'WAIT S3. One bounded page of reminder appointments whose studio presently satisfies the SMS routing prerequisite, newest-first by (starts_at, id) from an optional keyset cursor. CANDIDATE FILTER ONLY -- being returned does NOT authorise a send: the caller must still pass the consent/toggle/STOP gate and re-resolve the studio sender via resolve_active_studio_sms_sender immediately before claiming, and refuse on anything except exactly one usable sender. Deliberately returns NO messaging_service_sid or other provider identifier, so it cannot become send authority and the fail-closed re-resolution window cannot be skipped. Read-only, STABLE, no write of any kind. SECURITY DEFINER because studio_sms_senders is closed to every role (0191); this adds NO table privilege and leaks no sender identity. p_kind is a closed vocabulary, not a column name, so there is no dynamic SQL. Output bounded to 200 rows regardless of p_limit. service_role only.';

-- ---------------------------------------------------------------------------
-- EXECUTE PRIVILEGE, REVOKED BY NAME FIRST.
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated
-- AND service_role at function-create time, and PostgreSQL grants to PUBLIC.
-- Every one is revoked explicitly before the single intended grant is made
-- back. Missing one of these is how 0129 leaked to anon and 0164 to
-- service_role; `tests/security/clinical-rpc-grant-guard.test.ts` pins the
-- shape.
--
-- Cron-internal: the reminder dispatcher runs as service_role and is the only
-- caller. No browser role has any business selecting reminder candidates.
-- ---------------------------------------------------------------------------
revoke execute on function public.reminder_sms_candidates(text, timestamptz, timestamptz, timestamptz, uuid, integer, integer) from public;
revoke execute on function public.reminder_sms_candidates(text, timestamptz, timestamptz, timestamptz, uuid, integer, integer) from anon;
revoke execute on function public.reminder_sms_candidates(text, timestamptz, timestamptz, timestamptz, uuid, integer, integer) from authenticated;
revoke execute on function public.reminder_sms_candidates(text, timestamptz, timestamptz, timestamptz, uuid, integer, integer) from service_role;

grant execute on function public.reminder_sms_candidates(text, timestamptz, timestamptz, timestamptz, uuid, integer, integer) to service_role;

-- NO TABLE GRANT IS ADDED HERE, DELIBERATELY. `studio_sms_senders` remains
-- closed to every role exactly as 0191 left it. If a future change needs a
-- table privilege that is a different decision with a different blast radius
-- and belongs in its own migration with its own review.

-- ---------------------------------------------------------------------------
-- THE OPERATOR SIGNAL THAT THE FILTER WOULD OTHERWISE SWALLOW.
--
-- Filtering unroutable studios out of candidate selection is what makes the
-- pass fair and bounded — and, on its own, it makes them INVISIBLE. A studio
-- with a missing, ambiguous or unreadable sender would lose every reminder
-- while producing no alert at all, because the only path that reports a
-- routing refusal is the per-row send the filter now prevents.
--
-- That is strictly worse than the starvation it replaced: a starving studio at
-- least alerted on the rows it did reach. So the filter's complement is
-- available as its own bounded read — the studios that HAVE eligible
-- candidates this window and CANNOT send — for alerting only.
--
-- Bounded like its twin, and it returns studio ids and a count, never an
-- appointment, a client or a sender identifier.
-- ---------------------------------------------------------------------------
create or replace function public.reminder_sms_unroutable_studios(
  p_kind         text,
  p_window_start timestamptz,
  p_window_end   timestamptz,
  p_limit        integer,
  p_max_attempts integer
)
returns table (studio_id uuid, candidate_count bigint)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select a.studio_id, count(*) as candidate_count
    from public.appointments a
    join public.studios st on st.id = a.studio_id
   where p_kind in ('24h', '2h')
     and a.status = 'confirmed'
     and a.starts_at >= p_window_start
     and a.starts_at <= p_window_end
     and case p_kind
           when '24h' then a.sms_reminder_24h_sent_at is null
           else            a.sms_reminder_2h_sent_at  is null
         end
     and case p_kind
           when '24h' then coalesce(a.sms_reminder_24h_send_attempts, 0)
           else            coalesce(a.sms_reminder_2h_send_attempts, 0)
         end < coalesce(p_max_attempts, 3)
     and case p_kind
           when '24h' then st.send_24h_sms_reminders
           else            st.send_2h_sms_reminders
         end is true
     -- The complement of the candidate filter: wants to send, cannot.
     and not exists (
       select 1
         from public.studio_sms_senders s
        where s.studio_id = a.studio_id
          and s.status = 'active'
     )
   group by a.studio_id
   order by a.studio_id
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

comment on function public.reminder_sms_unroutable_studios(text, timestamptz, timestamptz, integer, integer) is
  'WAIT S3. The complement of reminder_sms_candidates: studios that HAVE eligible reminder candidates in this window and CANNOT send, because no ACTIVE studio_sms_senders row exists. For OPERATOR ALERTING ONLY -- filtering these studios out of candidate selection is what makes the pass bounded, and without this read it would also make them invisible, losing every reminder with no signal. Returns studio ids and a candidate count; never an appointment, a client, or any sender/provider identifier. Read-only, STABLE. Output bounded to 200 rows regardless of p_limit. service_role only.';

revoke execute on function public.reminder_sms_unroutable_studios(text, timestamptz, timestamptz, integer, integer) from public;
revoke execute on function public.reminder_sms_unroutable_studios(text, timestamptz, timestamptz, integer, integer) from anon;
revoke execute on function public.reminder_sms_unroutable_studios(text, timestamptz, timestamptz, integer, integer) from authenticated;
revoke execute on function public.reminder_sms_unroutable_studios(text, timestamptz, timestamptz, integer, integer) from service_role;

grant execute on function public.reminder_sms_unroutable_studios(text, timestamptz, timestamptz, integer, integer) to service_role;

commit;
