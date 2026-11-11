-- 0324 (provisional number) -- atomic invitation allowance.
--
-- The owner no longer types an invitation capacity. The number of people who can be invited is the
-- consultations that fit the offered window, minus live invitations that compete for it. This
-- migration makes the SEND enforce that, under the studio lock, so two simultaneous sends cannot
-- both take the last slot.
--
--   * count_waitlist_competing_invitations_internal: the same overlap rule as 0323's owner-facing
--     count, without the auth.uid() derivation. Revoked from EVERY role: only the security-definer
--     admit command below can reach it. 0323 is not edited.
--   * admit_new_client_waitlist_entry gains a REQUIRED p_fit and a guard after its studio lock,
--     refusing no_capacity (or invalid_fit). Lock order is unchanged: studio -> round -> entry ->
--     service -> invitation.
--
-- RESIDUAL RACE, NAMED: p_fit is computed by the send server action from the slot engine just
-- before this command runs. A slot taken between that computation and the studio lock is not seen
-- here. Invitations do not reserve appointments, and the UI says availability can change.
--
-- The previous eight-argument signature is dropped (an overload with a defaulted last argument would
-- make existing 8-argument calls ambiguous and keep an unguarded path alive).

begin;
set local lock_timeout = '5s';

create or replace function public.count_waitlist_competing_invitations_internal(
  p_studio_id uuid,
  p_from      date,
  p_to        date,
  p_weekdays  smallint[] default null
)
returns integer
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_n integer;
begin
  select count(*)::integer into v_n
    from public.new_client_waitlist_invitations i
   where i.studio_id = p_studio_id
     and i.redeemed_at is null
     and i.expired_at  is null
     and i.released_at is null
     and i.declined_at is null
     and i.expires_at > pg_catalog.clock_timestamp()
     and (
       -- No recorded scope: cannot be shown to be elsewhere, so it competes.
       i.scope_start_date is null
       or i.scope_end_date is null
       or exists (
         select 1
           from pg_catalog.generate_series(
                  0,
                  least(i.scope_end_date, p_to) - greatest(i.scope_start_date, p_from)
                ) o
          cross join lateral (select greatest(i.scope_start_date, p_from) + o as d) x
          where (p_weekdays is null or pg_catalog.cardinality(p_weekdays) = 0
                 or extract(dow from x.d)::smallint = any (p_weekdays))
            and (i.scope_allowed_weekdays is null or pg_catalog.cardinality(i.scope_allowed_weekdays) = 0
                 or extract(dow from x.d)::smallint = any (i.scope_allowed_weekdays))
       )
     );
  return v_n;
end;
$$;

revoke all on function public.count_waitlist_competing_invitations_internal(uuid, date, date, smallint[]) from public;
revoke all on function public.count_waitlist_competing_invitations_internal(uuid, date, date, smallint[]) from anon;
revoke all on function public.count_waitlist_competing_invitations_internal(uuid, date, date, smallint[]) from authenticated;
revoke all on function public.count_waitlist_competing_invitations_internal(uuid, date, date, smallint[]) from service_role;

comment on function public.count_waitlist_competing_invitations_internal(uuid, date, date, smallint[]) is
  'Internal. Live invitations in the studio whose scope overlaps the window (any service). Callable by no role; reached only from admit_new_client_waitlist_entry.';

drop function if exists public.admit_new_client_waitlist_entry(uuid, uuid, uuid, uuid, date, date, smallint[], integer);

-- p_fit: the number of consultations that fit, computed by the SEND server action at send time from the
-- slot engine and the exact selections being sent. Required in effect: NULL is refused, never defaulted.
create or replace function public.admit_new_client_waitlist_entry(
  p_studio_id        uuid,
  p_actor_user_id    uuid,
  p_entry_id         uuid,
  p_service_id       uuid,
  p_start_date       date,
  p_end_date         date,
  p_allowed_weekdays smallint[] default null,
  p_ttl_hours        integer default 72,
  p_fit              integer default null
)
returns table (
  result         text,
  invitation_id  uuid,
  raw_token      text,
  -- BOTH INSTANTS, READ FROM THE STORED INVITATION ROW. Delivery needs the mint
  -- time as well as the deadline, and a caller that reconstructed it as
  -- `expires_at - ttl` or read its own clock would become a SECOND timestamp
  -- authority over a row the database already owns -- changing a send decision
  -- on clock skew alone. 0192 mints; this command only carries the facts out.
  issued_at      timestamptz,
  expires_at     timestamptz,
  delivery_email text,
  delivery_name  text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor    uuid;
  v_code     text;
  v_status   text;
  v_needs_claim boolean;
  v_claim    text;
  v_issue    record;
  v_issued   timestamptz;
  v_expires  timestamptz;
  v_svc_active   boolean;
  v_svc_modality text;
  v_svc_name     text;
  v_email    text;
  v_competing integer;
  v_round_id  uuid;
  v_round_allowance integer;
  v_name     text;
begin
  -- 1. AUTHORITY. Membership and owner role are re-derived in the database from
  -- (studio_id, auth user id). No browser-supplied studio or actor becomes
  -- authority: the caller passes ids, the database decides what they mean.
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then
    return query select v_code, null::uuid, null::text, null::timestamptz, null::timestamptz, null::text, null::text;
    return;
  end if;

  -- 2. LOCK ORDER STEP 1 and 2, before any entry is touched.
  --
  -- NO KEY UPDATE, not FOR UPDATE, for the reason spelled out in the issue
  -- command: FOR UPDATE blocks the KEY SHARE that the lifecycle writers' event
  -- trigger requests through its studio_id FK, and this command waits on the
  -- entry those writers hold. Two NO KEY UPDATE holders still exclude each
  -- other, so the allowance seat stays serialised.
  --
  -- 0192's issue_scoped_new_client_waitlist_invitation takes `studios FOR
  -- UPDATE` of its own, and that migration is not this lane's to change. It is
  -- reached only AFTER this transaction already holds the entry, so a lifecycle
  -- writer on ANOTHER entry may hold KEY SHARE and delay the upgrade, but it
  -- needs nothing this transaction holds and no cycle forms. Proved by test
  -- rather than argued: see "admission vs each lifecycle writer".
  perform 1 from public.studios s where s.id = p_studio_id for no key update;
  if not found then
    return query select 'unknown_studio'::text, null::uuid, null::text, null::timestamptz, null::timestamptz, null::text, null::text;
    return;
  end if;
  --
  -- THE OPEN ROUND, NOT EVERY ROUND THIS STUDIO HAS EVER HAD. `studio_id` was
  -- the primary key of this table when the line below was written, so
  -- `where r.studio_id = ...` named exactly one row. It no longer does: the key
  -- is now `id`, closed rounds persist as an append-mostly ledger, and at most
  -- one open round per studio is enforced by a PARTIAL unique index
  -- `(studio_id) where closed_at is null`. Without the predicate this statement
  -- would still take a lock -- it has no `found` check and never decided
  -- anything -- but it would take FOR UPDATE on every historical row, so
  -- admission contention would grow with the studio's history and the order
  -- named above would no longer describe a round.
  --
  -- THE PREDICATE IS THE ISSUER'S, CHARACTER FOR CHARACTER. 0192's
  -- issue_scoped_new_client_waitlist_invitation selects
  -- `where r.studio_id = p_studio_id and r.closed_at is null for update`, and
  -- this lock is only useful if it names the same row that command will.
  --
  -- FOR UPDATE, NOT FOR NO KEY UPDATE, unlike the studios lock above. This row
  -- is the TARGET of the invitation's composite (admission_round_id, studio_id)
  -- foreign key, so a competing issuance needs KEY SHARE on it. FOR UPDATE
  -- excludes KEY SHARE and that exclusion is precisely what serialises the
  -- allowance seat; NO KEY UPDATE here would let two issuances past.
  --
  -- LOCK-ONLY, WITH NO VERDICT. `no_round_open` belongs to 0192 and is returned
  -- by the issuer below. Deciding it here would duplicate the authority this
  -- command exists to delegate, and would be a second place to get it wrong.
  -- When no round is open this locks nothing, the entry lock is still taken,
  -- and the issuer refuses -- unwinding the claim through WA001.
  perform 1 from public.studio_waitlist_admission_rounds r
   where r.studio_id = p_studio_id
     and r.closed_at is null
   for update;

  -- 3. LOCK ORDER STEP 3. Read the entry's admissibility under its own lock, so
  -- the status this decision rests on cannot move underneath it.
  select e.status, e.email, e.name into v_status, v_email, v_name
    from public.new_client_waitlist_entries e
   where e.id = p_entry_id and e.studio_id = p_studio_id
   for update;

  -- Scoped by BOTH id and studio_id, so an entry belonging to another tenant is
  -- indistinguishable from one that does not exist.
  if v_status is null then
    return query select 'not_found'::text, null::uuid, null::text, null::timestamptz, null::timestamptz, null::text, null::text;
    return;
  end if;

  if v_status = 'waiting' then
    v_needs_claim := true;
  elsif v_status = 'claimed' then
    -- Left by the previous workflow, or by an internal path. Legitimate.
    v_needs_claim := false;
  else
    -- invited / converted / expired / released / removed. Each has its own
    -- lifecycle exit; none of them is admissible by pressing this button.
    return query select 'not_admissible'::text, null::uuid, null::text, null::timestamptz, null::timestamptz, null::text, null::text;
    return;
  end if;

  -- 3b. THE SERVICE MUST BE ONE A NEW CLIENT MAY ACTUALLY BOOK.
  --
  -- BEFORE THE SUBTRANSACTION, so no claim is taken and unwound -- this refusal
  -- leaves no durable state at all rather than relying on a rollback to remove
  -- it. 0192's issuer checks that the service EXISTS and belongs to the studio;
  -- it does not ask whether a new client may book it, and that migration is not
  -- this lane's to change.
  --
  -- AFTER the studio, round and entry decisions, so every existing refusal
  -- keeps its precedence: unknown_studio, not_found and not_admissible are
  -- still answered first and none of their meanings move.
  --
  -- `invalid_service` IS THE EXISTING WORD for it, carried from 0192's own
  -- vocabulary. A new code would make callers learn a second name for "that
  -- service cannot be offered", and the recipient-facing outcome is identical.
  --
  -- Tenancy is the query filter here, which is why the predicate does not take
  -- a studio id: a row fetched without `studio_id` is already the wrong row.
  -- A missing row therefore also refuses, covering an unknown or deleted id.
  -- READ UNDER A LOCK THAT OUTLIVES THE DECISION. An unlocked `exists` check
  -- decided eligibility against a snapshot the owner could change before the
  -- nested issuer committed: deactivate the service, or retitle it, and the
  -- invitation was still minted against the stale verdict. The lock is held to
  -- COMMIT, so the row the decision rests on cannot move underneath it.
  --
  -- FOR SHARE, AND THE MODE IS THE POINT.
  --
  --   * FOR KEY SHARE WOULD NOT WORK AND LOOKS LIKE IT WOULD. `active`,
  --     `modality` and `name` are NON-KEY columns, so an ordinary UPDATE of them
  --     takes FOR NO KEY UPDATE -- which KEY SHARE does not conflict with.
  --     Protecting the service's KEY protects nothing this predicate reads.
  --   * FOR SHARE is the NARROWEST mode that does conflict with FOR NO KEY
  --     UPDATE, so it blocks every eligibility-changing UPDATE and any DELETE.
  --   * FOR UPDATE / FOR NO KEY UPDATE would ALSO work and are worse: they
  --     exclude each other, so two admissions naming the SAME service would
  --     serialise on it. They should contend for the round seat, not for a row
  --     neither of them writes. FOR SHARE admits both.
  --   * AND FOR SHARE DOES NOT BLOCK FK KEY-SHARE CHECKS. An appointment
  --     referencing this service requests FOR KEY SHARE, which FOR SHARE
  --     permits -- so holding this lock cannot stall an ordinary booking. Same
  --     reasoning that chose NO KEY UPDATE for the studios row above, applied to
  --     the other side of the matrix.
  --
  -- LOCK ORDER STEP 4: services comes LAST, after the entry, and no existing
  -- writer inverts it. Every service mutation -- the settings UPDATE, the
  -- active toggle, show_studio_service and reorder_studio_service -- locks
  -- service rows and NOTHING this command holds, so none of them can be waiting
  -- on the studio, round or entry while this command waits on them. No cycle
  -- can form.
  select sv.active, sv.modality, sv.name
    into v_svc_active, v_svc_modality, v_svc_name
    from public.services sv
   where sv.id = p_service_id
     and sv.studio_id = p_studio_id
   for share;

  -- Tenancy is the query filter, which is why the predicate takes no studio id.
  -- A missing row covers an unknown id, a deleted one, another studio's, and a
  -- null p_service_id -- all of them `invalid_service`, as 0192 already says.
  if not found
     or not public.service_is_bookable_by_new_client(v_svc_active, v_svc_modality, v_svc_name) then
    return query select 'invalid_service'::text, null::uuid, null::text, null::timestamptz, null::timestamptz, null::text, null::text;
    return;
  end if;

  -- 3c. CAPACITY, decided under the studio lock taken above.
  --
  -- The rule is "live invitations that compete with this window, plus this one, must not exceed the
  -- consultations that fit". `p_fit` is the sender's own computation at send time; this command
  -- cannot recompute availability, it SERIALISES the count. Two simultaneous sends therefore see
  -- each other: the second waits on the studio lock, then counts the first's committed invitation.
  --
  -- RESIDUAL, AND NAMED: availability can change between the sender's fit computation and this
  -- lock. A slot taken in that gap is not seen here. Invitations do not reserve appointments.
  --
  -- NULL OR NEGATIVE IS REFUSED rather than treated as "no limit", so omitting the argument cannot
  -- bypass the rule.
  if p_fit is null or p_fit < 0 then
    return query select 'invalid_fit'::text, null::uuid, null::text, null::timestamptz, null::timestamptz, null::text, null::text;
    return;
  end if;
  -- Only a well-formed window is counted here. A null or reversed one is refused by the issuer
  -- below as invalid_scope_dates, so that existing refusal keeps its meaning and precedence.
  if p_start_date is not null and p_end_date is not null and p_end_date >= p_start_date then
    v_competing := public.count_waitlist_competing_invitations_internal(
                     p_studio_id, p_start_date, p_end_date, p_allowed_weekdays);
    if v_competing + 1 > p_fit then
      return query select 'no_capacity'::text, null::uuid, null::text, null::timestamptz, null::timestamptz, null::text, null::text;
      return;
    end if;
  end if;

  -- 4-9. THE MUTATING HALF, in a subtransaction. Everything from here either
  -- commits together or leaves no trace.
  begin
    -- A FULL ADMISSION ROUND DOES NOT GATE A SEND. It is rotated here, in this transaction.
    --
    -- This runs AFTER the fit guard above, so `no_capacity` always takes precedence over a full
    -- round, and inside the subtransaction, so a send refused for any later reason (service, scope,
    -- already invited ...) rotates nothing.
    --
    -- IT DELIBERATELY BYPASSES 0192's `live_offers_outstanding` RULE. 0192 refuses to close a round
    -- while an offer it authorised is still live, because the round was then the only place that
    -- offer's seat was counted. That is no longer true: the fit guard above counts live invitations
    -- STUDIO-WIDE, across every round (count_waitlist_competing_invitations_internal never joins to
    -- rounds). An offer left behind in the closed round therefore still counts against the next
    -- send, and redeem and book never read the round's `closed_at`. THIS IS SAFE ONLY BECAUSE THAT
    -- COUNT IS STUDIO-WIDE. If it were ever narrowed to one round, this block would have to go.
    --
    -- CONDITIONAL, under the locks this command already holds (studio, then the open round FOR
    -- UPDATE): only when the open round's consumed count has reached its allowance. A concurrent
    -- second sender therefore never closes a fresh, healthy round. Close first, then insert, so the
    -- partial unique index (one open round per studio) never sees two open rows. The actor is the
    -- owner this command derived at its top, never a parameter. 0192 is unchanged.
    --
    -- ACCEPTED RESIDUE: the new round's allowance (100) is plumbing, not a real ceiling. The
    -- studio-wide fit above is the only limit that means anything.
    select r.id, r.allowance into v_round_id, v_round_allowance
      from public.studio_waitlist_admission_rounds r
     where r.studio_id = p_studio_id and r.closed_at is null;
    if v_round_id is not null
       and public.waitlist_admission_round_consumed(v_round_id) >= v_round_allowance then
      update public.studio_waitlist_admission_rounds r
         set closed_at = clock_timestamp(),
             closed_by_practitioner_id = v_actor,
             updated_at = clock_timestamp()
       where r.id = v_round_id and r.closed_at is null;
      insert into public.studio_waitlist_admission_rounds
        (studio_id, allowance, opened_at, opened_by_practitioner_id, updated_at)
      values (p_studio_id, 100, clock_timestamp(), v_actor, clock_timestamp());
    end if;

    if v_needs_claim then
      v_claim := public.claim_new_client_waitlist_entry(p_studio_id, p_entry_id, p_actor_user_id);
      if v_claim <> 'claimed' then
        raise exception '%', v_claim using errcode = 'WA001';
      end if;
    end if;

    -- 0192 owns service validation, scope validation, weekday canonicalisation,
    -- the no-repeat-declined rule, the allowance verdict and the token. This
    -- command owns only the ORDER and the atomicity.
    select * into v_issue
      from public.issue_scoped_new_client_waitlist_invitation(
             p_studio_id, p_entry_id, p_actor_user_id, p_service_id,
             p_start_date, p_end_date, p_allowed_weekdays, p_ttl_hours);

    if v_issue.result <> 'issued' then
      -- Carries 0192's own vocabulary out unchanged: no_round_open, round_full,
      -- invalid_service, invalid_scope_dates, invalid_weekdays,
      -- already_declined_offer, already_invited, invalid_ttl...
      raise exception '%', v_issue.result using errcode = 'WA001';
    end if;

    -- ONE ROW, BOTH COLUMNS, NEITHER DERIVED. issued_at is the post-lock mint
    -- 0192 stamped; expires_at is the deadline it derived from that same mint.
    -- Reading them together is what makes them consistent with each other by
    -- construction rather than by two queries agreeing.
    select i.issued_at, i.expires_at into v_issued, v_expires
      from public.new_client_waitlist_invitations i
     where i.id = v_issue.invitation_id;

    return query select 'admitted'::text, v_issue.invitation_id, v_issue.raw_token,
                        v_issued, v_expires, v_email, v_name;
    return;

  exception
    when sqlstate 'WA001' then
      -- The subtransaction has already rolled back the claim, if one was taken.
      -- SQLERRM carries the refusal code the inner command produced.
      return query select SQLERRM::text, null::uuid, null::text, null::timestamptz, null::timestamptz, null::text, null::text;
      return;
  end;
end;
$$;

revoke execute on function public.admit_new_client_waitlist_entry(uuid, uuid, uuid, uuid, date, date, smallint[], integer, integer) from public;
revoke execute on function public.admit_new_client_waitlist_entry(uuid, uuid, uuid, uuid, date, date, smallint[], integer, integer) from anon;
revoke execute on function public.admit_new_client_waitlist_entry(uuid, uuid, uuid, uuid, date, date, smallint[], integer, integer) from authenticated;
revoke execute on function public.admit_new_client_waitlist_entry(uuid, uuid, uuid, uuid, date, date, smallint[], integer, integer) from service_role;
grant execute on function public.admit_new_client_waitlist_entry(uuid, uuid, uuid, uuid, date, date, smallint[], integer, integer) to service_role;

do $$
declare
  v_admit    regprocedure := 'public.admit_new_client_waitlist_entry(uuid, uuid, uuid, uuid, date, date, smallint[], integer, integer)'::regprocedure;
  v_internal regprocedure := 'public.count_waitlist_competing_invitations_internal(uuid, date, date, smallint[])'::regprocedure;
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if pg_catalog.has_function_privilege(v_role, v_internal, 'EXECUTE') then
      raise exception '0324: % must not execute count_waitlist_competing_invitations_internal', v_role;
    end if;
  end loop;
  foreach v_role in array array['anon', 'authenticated'] loop
    if pg_catalog.has_function_privilege(v_role, v_admit, 'EXECUTE') then
      raise exception '0324: % must not execute admit_new_client_waitlist_entry', v_role;
    end if;
  end loop;
  if not pg_catalog.has_function_privilege('service_role', v_admit, 'EXECUTE') then
    raise exception '0324: service_role must execute admit_new_client_waitlist_entry';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(p.proacl) a
              where p.oid in (v_admit::oid, v_internal::oid) and a.grantee = 0) then
    raise exception '0324: PUBLIC must not hold EXECUTE on either function';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.proname = 'admit_new_client_waitlist_entry') <> 1 then
    raise exception '0324: exactly one admit_new_client_waitlist_entry overload must exist';
  end if;
end;
$$;

commit;
