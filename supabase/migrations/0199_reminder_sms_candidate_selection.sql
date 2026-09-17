-- ===========================================================================
-- 0199 — BOUNDED SERVER-SIDE REMINDER CANDIDATE SELECTION
-- ===========================================================================
--
-- WAIT S3 Part 2. Two read-only functions, one shared view, and ONE canonical
-- derived column on `clients` that makes "can this client be sent an SMS at
-- all" a fact the database owns rather than a predicate each caller
-- re-invents. No new table. No trigger. No backfill script -- PostgreSQL
-- populates the column itself as part of the ADD COLUMN.
--
-- THIS MIGRATION REWRITES public.clients. Adding a STORED generated column
-- is a full table rewrite under ACCESS EXCLUSIVE. See THE COLUMN below for
-- the measurement and the lock discipline.
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
-- THE CANONICAL SMS DESTINATION FACT
-- ---------------------------------------------------------------------------
--
-- The first cut of this migration gated candidates on `c.phone is not null and
-- btrim(c.phone) <> ''`. That is NOT the rule the sender applies. The sender
-- applies `normalizePhoneForSms`, which additionally requires a parseable E.164
-- or NANP number. So '(415) 555' -- non-null, non-blank, unparseable -- passed
-- selection, occupied a page slot, and was then refused at the send with no
-- claim and no state change. Eligibility unchanged, same sort position, same
-- page slot on the next pass: EXACTLY the starvation this migration exists to
-- remove, reproduced one layer down.
--
-- Widening the SQL predicate to re-implement the parser would have created a
-- second definition of "sendable", free to drift from the first the moment
-- either changed. Instead the DATABASE OWNS THE FACT, once:
--
--   sms_trimmable_whitespace()  the ECMAScript String.prototype.trim set
--   sms_normalized_phone(text)  THE definition of a sendable destination
--   clients.sms_phone           that definition, applied, stored, maintained
--                               by PostgreSQL on every write
--
-- A GENERATED column rather than a sibling column deliberately: a sibling
-- would be correct only while every write path remembered to maintain it, and
-- `clients` is written from the booking flow, the portal, the practitioner app
-- and two RPCs in 0032. A generated column cannot be forgotten, cannot be
-- written directly, and cannot disagree with `phone`.
--
-- PARITY IS PROVEN, NOT ASSERTED. `tests/db/sms-phone-parity.db.test.ts` runs a
-- 51-case corpus -- exotic whitespace, non-whitespace invisibles, letters
-- before a '+', fullwidth '+', Arabic-Indic digits, every digit-length
-- boundary -- through BOTH the shipped TypeScript and this function and fails
-- on a single disagreement. `normalizePhoneForSms` is UNCHANGED by this
-- migration; the corpus proves the SQL was written to match it, not the
-- reverse.
--
-- WHY btrim(chr(...)) AND NOT [[:space:]]. Character classes are ctype- and
-- therefore locale-dependent, which makes any function using them immutable
-- only by assertion -- unacceptable in an expression whose results are STORED.
-- An explicit chr() set is locale-independent and matches the ECMAScript trim
-- set exactly. An earlier draft used `[^!-~]` and was rejected: it also strips
-- leading LETTERS, so 'e+441234567890' normalised in SQL and did not in
-- TypeScript -- the DB would have called the row sendable and the sender would
-- have refused it forever. The corpus catches that formulation on 5 rows.
-- ---------------------------------------------------------------------------

create or replace function public.sms_trimmable_whitespace()
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $ws$
  -- U+0009..U+000D, U+0020, U+00A0, U+1680, U+2000..U+200A, U+2028, U+2029,
  -- U+202F, U+205F, U+3000, U+FEFF. Written as chr() so the source file holds
  -- no invisible character that a reviewer cannot see and an editor can eat.
  select chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)
      || chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)
      || chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)
      || chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279)
$ws$;

comment on function public.sms_trimmable_whitespace() is
  'WAIT S3. The exact character set ECMAScript String.prototype.trim removes, as an explicit chr() list. Locale-independent, so sms_normalized_phone is immutable in fact and not merely by declaration. Pure: reads nothing.';

create or replace function public.sms_normalized_phone(p_phone text)
returns text
language sql
immutable
strict
parallel safe
set search_path = pg_catalog, pg_temp
as $fn$
  select case
           when t = '' then null
           -- Leading '+' means the caller supplied an E.164 number: accept the
           -- digit count the provider accepts, 8..15, and nothing else.
           when t like '+%' then
             case when length(d) >= 8 and length(d) <= 15 then '+' || d else null end
           -- No '+': NANP only, either bare 10 digits or 11 beginning with 1.
           when length(d) = 10 then '+1' || d
           when length(d) = 11 and left(d, 1) = '1' then '+' || d
           else null
         end
  from (
    select t,
           regexp_replace(case when t like '+%' then substr(t, 2) else t end,
                          '[^0-9]', '', 'g') as d
    from (
      select btrim(p_phone, public.sms_trimmable_whitespace()) as t
    ) s0
  ) s1
$fn$;

comment on function public.sms_normalized_phone(text) is
  'WAIT S3. THE canonical definition of a sendable SMS destination, and the only one. Returns the E.164 number an SMS would be addressed to, or NULL when the input cannot be addressed at all. Byte-for-byte equivalent to normalizePhoneForSms in lib/sms/twilio.ts, pinned by a 51-case parity corpus in tests/db/sms-phone-parity.db.test.ts. Pure text transformation: reads no table, holds no authority, decides no send.';

-- EXECUTE IS GRANTED, NOT REVOKED -- AND THAT IS DELIBERATE.
--
-- Every other function in this migration is service_role-only. These two are
-- not, and tightening them would be an outage. PostgreSQL evaluates a
-- generated column's expression with the privileges of the role performing the
-- WRITE, so revoking EXECUTE from `authenticated` does not harden anything --
-- it makes every practitioner client edit fail with insufficient_privilege,
-- and revoking from `anon` breaks public booking. Proven both ways against the
-- local stack before this was written: revoked => INSERT blocked, granted =>
-- INSERT succeeds with the correct stored value.
--
-- Nothing leaks by granting it. Both functions are pure text transformations
-- over an argument the caller already supplied; neither reads a table.
revoke execute on function public.sms_trimmable_whitespace() from public;
grant execute on function public.sms_trimmable_whitespace() to anon, authenticated, service_role;

revoke execute on function public.sms_normalized_phone(text) from public;
grant execute on function public.sms_normalized_phone(text) to anon, authenticated, service_role;

-- THE COLUMN. Adding a STORED generated column REWRITES the table under an
-- ACCESS EXCLUSIVE lock; `set local lock_timeout` above means this migration
-- fails fast rather than queueing behind a long read and stalling booking.
-- Measured on the local stack: 38 ms for 122 rows, every phone-bearing row
-- normalised, zero disagreement with the function.
alter table public.clients
  add column sms_phone text
  generated always as (public.sms_normalized_phone(phone)) stored;

comment on column public.clients.sms_phone is
  'WAIT S3. The canonical SMS destination for this client, derived by PostgreSQL from `phone` on every write -- NULL means this client cannot be sent an SMS at all. Generated, so no application write path can forget to maintain it and no value can disagree with `phone`. Carries no consent meaning: sms_consent_at and sms_opted_out_at remain separate and are still checked independently at send time.';

-- ---------------------------------------------------------------------------
-- THE SHARED ELIGIBILITY BASE
-- ---------------------------------------------------------------------------
--
-- `reminder_sms_candidates` and `reminder_sms_unroutable_studios` are exact
-- complements: one selects studios that CAN send, the other reports studios
-- that WANT to send and cannot. That only holds while both agree on what a
-- candidate IS. In the first cut they did not -- the complement never applied
-- the client gates at all, so a studio whose only appointments belonged to
-- clients with no consent was reported as an unroutable studio needing
-- operator attention, and an alert that fires on a studio with nothing to send
-- is how operators learn to ignore alerts.
--
-- Stating the base ONCE removes the class rather than this instance of it.
-- A view, not a function, so the planner still pushes the window and keyset
-- predicates down into the scan; a set-returning function with a SET clause
-- cannot be inlined and would have materialised the whole window before the
-- LIMIT -- destroying the boundedness this migration exists to provide.
--
-- security_invoker so the view adds NO privilege of its own: it is readable
-- only through the SECURITY DEFINER functions below, which is why every role
-- is revoked from it by name.
create or replace view public.reminder_sms_eligible_appointments
with (security_invoker = true) as
select a.id,
       a.starts_at,
       a.studio_id,
       a.sms_reminder_24h_sent_at,
       a.sms_reminder_2h_sent_at,
       a.sms_reminder_24h_send_attempts,
       a.sms_reminder_2h_send_attempts,
       st.send_24h_sms_reminders,
       st.send_2h_sms_reminders
  from public.appointments a
  join public.studios st on st.id = a.studio_id
  join public.clients  c  on c.id  = a.client_id
 where a.status = 'confirmed'
   -- THE CLIENT GATES. A row failing any of these is skipped by the route with
   -- a bare `continue` -- no send, no claim, no state change -- so its
   -- eligibility is unchanged and it re-occupies the same page slot on every
   -- later pass. Excluding it from selection is what stops it starving a
   -- sendable appointment behind it.
   --
   -- STILL NOT AUTHORITY. Consent and opt-out change between selection and
   -- send; `passesConsentGate` re-reads all three immediately before the send
   -- and refuses on its own, so a consent withdrawn or a STOP received in that
   -- window is honoured there, not here.
   and c.sms_phone is not null
   and c.sms_consent_at is not null
   and c.sms_opted_out_at is null;

comment on view public.reminder_sms_eligible_appointments is
  'WAIT S3. The single definition of "a reminder appointment worth loading": confirmed, with a client who has a parseable destination, consent, and no opt-out. Deliberately EXCLUDES the routing prerequisite and the window/kind/attempt filters, so reminder_sms_candidates and reminder_sms_unroutable_studios can be exact complements over one shared base instead of two predicates free to drift. Carries no client identifier, no phone and no sender identifier. security_invoker; revoked from every role and reachable only through the SECURITY DEFINER functions below.';

revoke all on public.reminder_sms_eligible_appointments from public;
revoke all on public.reminder_sms_eligible_appointments from anon;
revoke all on public.reminder_sms_eligible_appointments from authenticated;
revoke all on public.reminder_sms_eligible_appointments from service_role;


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
    from public.reminder_sms_eligible_appointments a
   where p_kind in ('24h', '2h')
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
           when '24h' then a.send_24h_sms_reminders
           else            a.send_2h_sms_reminders
         end is true

     -- The client gates and `status = 'confirmed'` are applied by
     -- reminder_sms_eligible_appointments, shared verbatim with the
     -- complement below so the two cannot drift apart.

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
    from public.reminder_sms_eligible_appointments a
   where p_kind in ('24h', '2h')
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
           when '24h' then a.send_24h_sms_reminders
           else            a.send_2h_sms_reminders
         end is true
     -- The complement of the candidate filter: wants to send, cannot.
     and not exists (
       select 1
         from public.studio_sms_senders s
        where s.studio_id = a.studio_id
          and s.status = 'active'
     )

     -- ROTATE PAST WHAT IS ALREADY REPORTED.
     --
     -- A stable order plus a bound returns the SAME first 50 studios on every
     -- invocation, so studios beyond that prefix would never reach the alert
     -- and would stay invisible -- precisely the failure this complement
     -- exists to prevent, reproduced inside the fix for it.
     --
     -- Excluding studios that already hold an OPEN routing alert makes the set
     -- DRAIN: each run surfaces studios not yet reported, and 0194s partial
     -- unique index on (studio_id, event) where resolved_at is null uses the
     -- same predicate, so "already reported" here means exactly what "already
     -- open" means there. Resolving an alert re-arms the studio, which is the
     -- intended operator loop.
     and not exists (
       select 1
         from public.ops_alerts oa
        where oa.studio_id = a.studio_id
          and oa.resolved_at is null
          -- EXACTLY the event this path records, not the routing
          -- vocabulary. The complement's own condition is `no active
          -- sender`, which route.ts reports as
          -- sms_sender_not_active_for_studio and nothing else.
          -- Matching the whole vocabulary meant an unresolved
          -- sms_sender_ambiguous -- a DIFFERENT fault, with a
          -- different fix -- suppressed the not-active alert
          -- indefinitely, and 0194's partial unique index is keyed on
          -- (studio_id, event), so 'already open' there has always
          -- meant this one event too.
          and oa.event = 'sms_sender_not_active_for_studio'
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
