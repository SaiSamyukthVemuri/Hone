-- 0363 -- owner over-invite batches, the batch-aware admit, and an atomic replace.
-- Rules: a CONFIRMED batch is governed by its own confirmation, not by the capacity estimate: with an estimate of
-- zero, or capacity already exhausted, every confirmed recipient is still invited unless a REAL guard refuses (owner, entry status,
-- owner-review hold, service/scope, already_invited, consent and delivery limits in the app). The unconfirmed path keeps 0325's `no_capacity`.
-- The app is the single availability authority; the database trusts the fit it is given (stored as the estimate SHOWN), re-checks only the
-- live-invitation count under the studio lock, and returns `material_change` when it moved. Booking conflicts stay atomic in the booking
-- command, so over-inviting cannot overbook. Batch size, delivery chunk, send rate and pauses are NOT enforced here.
-- The raw token is returned once by admit and never stored: the worker runs admit and the send together per item.
begin;
set local lock_timeout = '5s';

create table if not exists public.waitlist_invitation_batches (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  batch_key uuid not null,
  confirmed_by_practitioner_id uuid not null,
  confirmed_by_user_id uuid not null,
  confirmed_at timestamptz not null default now(),
  quantity integer not null check (quantity >= 1),
  extra_requested integer not null check (extra_requested >= 0),
  fit_shown integer not null check (fit_shown >= 0),
  live_shown integer not null check (live_shown >= 0),
  service_id uuid not null,
  start_date date not null,
  end_date date not null,
  allowed_weekdays smallint[],
  ttl_hours integer not null check (ttl_hours between 1 and 168),
  constraint waitlist_invitation_batches_window_check check (end_date >= start_date),
  constraint waitlist_invitation_batches_key unique (studio_id, batch_key),
  constraint waitlist_invitation_batches_id_studio unique (id, studio_id),
  constraint waitlist_invitation_batches_actor_fk foreign key (confirmed_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict
);
create table if not exists public.waitlist_invitation_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  studio_id uuid not null,
  entry_id uuid not null,
  state text not null default 'pending' check (state in ('pending','claimed','issued','sent','unknown','failed','skipped')),
  reason_class text check (reason_class is null or reason_class ~ '^[a-z_]{1,40}$'),
  attempts integer not null default 0 check (attempts >= 0),
  invitation_id uuid,
  claimed_at timestamptz, issued_at timestamptz, settled_at timestamptz,
  constraint waitlist_invitation_batch_items_unique unique (batch_id, entry_id),
  constraint waitlist_invitation_batch_items_batch_fk foreign key (batch_id, studio_id)
    references public.waitlist_invitation_batches (id, studio_id) on delete cascade,
  constraint waitlist_invitation_batch_items_entry_fk foreign key (entry_id, studio_id)
    references public.new_client_waitlist_entries (id, studio_id) on delete cascade,
  constraint waitlist_invitation_batch_items_shape check (
    (state in ('pending','claimed') and invitation_id is null)
    or (state in ('issued','sent','unknown') and invitation_id is not null)
    or state in ('failed','skipped')),
  constraint waitlist_invitation_batch_items_skip_reason check (state <> 'skipped' or reason_class is not null)
);
-- One entry in at most one ACTIVE batch: two simultaneous owner actions cannot both queue the same person.
create unique index if not exists waitlist_invitation_batch_items_active_entry
  on public.waitlist_invitation_batch_items (entry_id) where state in ('pending','claimed','issued','unknown','failed');
create index if not exists waitlist_invitation_batch_items_claimable
  on public.waitlist_invitation_batch_items (studio_id, state) where state in ('pending','claimed');

alter table public.waitlist_invitation_batches enable row level security;
alter table public.waitlist_invitation_batch_items enable row level security;
drop policy if exists waitlist_invitation_batches_owner_select on public.waitlist_invitation_batches;
create policy waitlist_invitation_batches_owner_select on public.waitlist_invitation_batches for select to authenticated
  using (public.is_studio_owner(waitlist_invitation_batches.studio_id));
drop policy if exists waitlist_invitation_batch_items_owner_select on public.waitlist_invitation_batch_items;
create policy waitlist_invitation_batch_items_owner_select on public.waitlist_invitation_batch_items for select to authenticated
  using (public.is_studio_owner(waitlist_invitation_batch_items.studio_id));
revoke all on public.waitlist_invitation_batches, public.waitlist_invitation_batch_items from public, anon, authenticated, service_role;
grant select on public.waitlist_invitation_batches, public.waitlist_invitation_batch_items to authenticated;

-- Admit, batch-aware. The old 9-argument function is dropped: one overload remains, and 9-argument callers still work through the default.
drop function if exists public.admit_new_client_waitlist_entry(uuid, uuid, uuid, uuid, date, date, smallint[], integer, integer);

create or replace function public.admit_new_client_waitlist_entry(
  p_studio_id        uuid,
  p_actor_user_id    uuid,
  p_entry_id         uuid,
  p_service_id       uuid,
  p_start_date       date,
  p_end_date         date,
  p_allowed_weekdays smallint[] default null,
  p_ttl_hours        integer default 72,
  p_fit              integer default null,
  p_batch_item_id    uuid default null
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
  v_bi_state text;
  v_bi_entry uuid;
  v_bi_studio uuid;
  v_bi_confirmed timestamptz;
  v_bi_svc uuid; v_bi_start date; v_bi_end date; v_bi_wd smallint[]; v_bi_ttl integer;
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
  -- 0363. A CONFIRMED BATCH ITEM IS GOVERNED BY ITS BATCH'S CONFIRMATION, NOT BY THE CAPACITY ESTIMATE (an explicitly
  -- confirmed over-invite may send when estimated capacity is zero or exhausted; the estimate must not become a hidden block). The item
  -- must be CLAIMED, belong to this studio and this entry, and its batch must be confirmed; anything else is refused and nothing is
  -- written. Every other guard below (owner, entry status, owner-review hold, service, scope, already_invited, consent in the caller)
  -- still applies. Without a batch item the capacity guard is exactly 0325's.
  if p_batch_item_id is not null then
    select i.state, i.entry_id, i.studio_id, b.confirmed_at, b.service_id, b.start_date, b.end_date, b.allowed_weekdays, b.ttl_hours
      into v_bi_state, v_bi_entry, v_bi_studio, v_bi_confirmed, v_bi_svc, v_bi_start, v_bi_end, v_bi_wd, v_bi_ttl
      from public.waitlist_invitation_batch_items i
      join public.waitlist_invitation_batches b on b.id = i.batch_id
     where i.id = p_batch_item_id
       for update of i;
    if v_bi_state is distinct from 'claimed' or v_bi_entry is distinct from p_entry_id
       or v_bi_studio is distinct from p_studio_id or v_bi_confirmed is null
       -- THE ITEM AUTHORISES EXACTLY WHAT THE OWNER CONFIRMED: the same service, window, weekdays and TTL the batch stored. A caller cannot ride a
       -- confirmed item into a different offer.
       or v_bi_svc is distinct from p_service_id or v_bi_start is distinct from p_start_date or v_bi_end is distinct from p_end_date
       or v_bi_wd is distinct from p_allowed_weekdays or v_bi_ttl is distinct from p_ttl_hours then
      return query select 'batch_item_invalid'::text, null::uuid, null::text, null::timestamptz, null::timestamptz, null::text, null::text;
      return;
    end if;
  else
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
  end if;

  -- 3d. THE OWNER-REVIEW HOLD (0325). An entry with an OPEN decline follow-up or withdrawal request is not offered
  -- again until the owner has handled it. Placed AFTER the owner check at the top (so a non-owner gets the membership
  -- refusal and never learns a follow-up exists) and AFTER the capacity guard (so `no_capacity` keeps its precedence).
  -- A refusal, never a throw: a batch send reports it per entry and goes on. Nothing is claimed or rotated.
  if exists (select 1 from public.waitlist_followups f
              where f.entry_id = p_entry_id and f.studio_id = p_studio_id and f.status = 'open') then
    return query select 'pending_owner_review'::text, null::uuid, null::text, null::timestamptz, null::timestamptz, null::text, null::text;
    return;
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

    if p_batch_item_id is not null then
      update public.waitlist_invitation_batch_items
         set state = 'issued', invitation_id = v_issue.invitation_id, issued_at = clock_timestamp(), attempts = attempts + 1
       where id = p_batch_item_id and state = 'claimed';
    end if;

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


-- create: owner-only, explicit entry ids, explicit confirmation, idempotent on (studio, batch_key).
-- Results: created | exists | key_reused | not_owner | confirmation_required | invalid_input | invalid_entries | entry_in_other_batch | material_change.
create or replace function public.create_waitlist_invitation_batch(
  p_studio_id uuid, p_actor_user_id uuid, p_batch_key uuid, p_entry_ids uuid[], p_service_id uuid,
  p_start_date date, p_end_date date, p_allowed_weekdays smallint[], p_ttl_hours integer,
  p_fit integer, p_shown_live_count integer, p_confirmed boolean)
returns table (result text, batch_id uuid, quantity integer, extra_requested integer, live_count integer)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid; v_code text; v_n integer; v_live integer; v_batch uuid; v_extra integer; v_have record;
begin
  select r.practitioner_id, r.code into v_actor, v_code from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return query select 'not_owner'::text, null::uuid, null::integer, null::integer, null::integer; return; end if;
  if not coalesce(p_confirmed, false) then return query select 'confirmation_required'::text, null::uuid, null::integer, null::integer, null::integer; return; end if;
  v_n := coalesce(pg_catalog.cardinality(p_entry_ids), 0);
  if p_batch_key is null or v_n < 1 or p_fit is null or p_fit < 0 or p_shown_live_count is null or p_shown_live_count < 0
     or p_service_id is null or p_start_date is null or p_end_date is null or p_end_date < p_start_date
     or p_ttl_hours is null or p_ttl_hours < 1 or p_ttl_hours > 168
     or exists (select 1 from pg_catalog.unnest(p_entry_ids) u where u is null)
     or (select count(distinct u) from pg_catalog.unnest(p_entry_ids) u) <> v_n then
    return query select 'invalid_input'::text, null::uuid, null::integer, null::integer, null::integer; return;
  end if;

  perform 1 from public.studios s where s.id = p_studio_id for no key update;  -- the same studio lock admit takes: owner actions serialise

  select b.id, b.quantity, b.extra_requested, b.service_id, b.start_date, b.end_date, b.allowed_weekdays, b.ttl_hours into v_have
    from public.waitlist_invitation_batches b where b.studio_id = p_studio_id and b.batch_key = p_batch_key;
  if v_have.id is not null then
    if v_have.quantity = v_n and v_have.service_id = p_service_id and v_have.start_date = p_start_date and v_have.end_date = p_end_date
       and v_have.allowed_weekdays is not distinct from p_allowed_weekdays and v_have.ttl_hours = p_ttl_hours
       and not exists (select 1 from pg_catalog.unnest(p_entry_ids) u
                        where not exists (select 1 from public.waitlist_invitation_batch_items i where i.batch_id = v_have.id and i.entry_id = u)) then
      return query select 'exists'::text, v_have.id, v_have.quantity, v_have.extra_requested, null::integer;
    else
      return query select 'key_reused'::text, null::uuid, null::integer, null::integer, null::integer;
    end if;
    return;
  end if;

  if (select count(*) from public.new_client_waitlist_entries e where e.studio_id = p_studio_id and e.id = any (p_entry_ids)) <> v_n then
    return query select 'invalid_entries'::text, null::uuid, null::integer, null::integer, null::integer; return;
  end if;
  if exists (select 1 from public.waitlist_invitation_batch_items i
              where i.entry_id = any (p_entry_ids) and i.state in ('pending','claimed','issued','unknown','failed')) then
    return query select 'entry_in_other_batch'::text, null::uuid, null::integer, null::integer, null::integer; return;
  end if;

  v_live := public.count_waitlist_competing_invitations_internal(p_studio_id, p_start_date, p_end_date, p_allowed_weekdays);
  if v_live <> p_shown_live_count then
    return query select 'material_change'::text, null::uuid, v_n, null::integer, v_live; return;
  end if;

  v_extra := greatest(v_n - greatest(p_fit - v_live, 0), 0);
  insert into public.waitlist_invitation_batches
    (studio_id, batch_key, confirmed_by_practitioner_id, confirmed_by_user_id, quantity, extra_requested, fit_shown, live_shown,
     service_id, start_date, end_date, allowed_weekdays, ttl_hours)
  values (p_studio_id, p_batch_key, v_actor, p_actor_user_id, v_n, v_extra, p_fit, v_live,
          p_service_id, p_start_date, p_end_date, p_allowed_weekdays, p_ttl_hours)
  returning id into v_batch;
  insert into public.waitlist_invitation_batch_items (batch_id, studio_id, entry_id)
    select v_batch, p_studio_id, u from pg_catalog.unnest(p_entry_ids) u;
  return query select 'created'::text, v_batch, v_n, v_extra, v_live;
end;
$$;

-- preview: read only. Live invitations overlapping the window, studio-wide live invitations expiring within 24 h (not window-scoped),
-- and how many of the selected entries could actually be invited (waiting, no open follow-up, not already in an active batch).
create or replace function public.preview_waitlist_over_invite(
  p_studio_id uuid, p_actor_user_id uuid, p_entry_ids uuid[], p_start_date date, p_end_date date, p_allowed_weekdays smallint[])
returns table (result text, live_count integer, expiring_within_24h integer, selected integer, admissible integer)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare v_code text;
begin
  select r.code into v_code from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return query select 'not_owner'::text, null::integer, null::integer, null::integer, null::integer; return; end if;
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    return query select 'invalid_input'::text, null::integer, null::integer, null::integer, null::integer; return; end if;
  return query select 'ok'::text,
    public.count_waitlist_competing_invitations_internal(p_studio_id, p_start_date, p_end_date, p_allowed_weekdays),
    (select count(*)::integer from public.new_client_waitlist_invitations i
      where i.studio_id = p_studio_id and i.redeemed_at is null and i.expired_at is null and i.released_at is null and i.declined_at is null
        and i.expires_at > pg_catalog.clock_timestamp() and i.expires_at <= pg_catalog.clock_timestamp() + interval '24 hours'),
    coalesce(pg_catalog.cardinality(p_entry_ids), 0),
    (select count(*)::integer from public.new_client_waitlist_entries e
      where e.studio_id = p_studio_id and e.id = any (coalesce(p_entry_ids, '{}')) and e.status = 'waiting'
        and not exists (select 1 from public.waitlist_followups f where f.entry_id = e.id and f.status = 'open')
        and not exists (select 1 from public.waitlist_invitation_batch_items bi where bi.entry_id = e.id and bi.state in ('pending','claimed','issued','unknown','failed')));
end;
$$;

-- claim: service-only worker queue. Per-studio fairness: studios are visited oldest-waiting first, at most p_per_studio items each, at most
-- p_total overall, `for update skip locked`. A claimed item whose admit never ran (no invitation) is reclaimed after p_lease_seconds.
create or replace function public.claim_waitlist_batch_items(p_per_studio integer, p_total integer, p_lease_seconds integer, p_batch_id uuid default null, p_actor_user_id uuid default null)
returns table (item_id uuid, batch_id uuid, studio_id uuid, entry_id uuid, actor_user_id uuid, service_id uuid,
               start_date date, end_date date, allowed_weekdays smallint[], ttl_hours integer)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare v_studio uuid; v_left integer; v_take integer; v_rec record; v_batch_studio uuid; v_code text;
begin
  if p_per_studio is null or p_per_studio < 1 or p_total is null or p_total < 1 or p_lease_seconds is null or p_lease_seconds < 5 then return; end if;
  -- SCOPED CLAIM (the owner's own first rounds): with a batch id, ONLY that batch's items are claimed, and only for an owner of the batch's studio
  -- (the actor is resolved through the batch's own studio, never taken from the caller). Nothing of another studio or batch is claimed or leased.
  -- Without a batch id this is the cron's round-robin over every studio.
  if p_batch_id is not null then
    if p_actor_user_id is null then return; end if;
    select b.studio_id into v_batch_studio from public.waitlist_invitation_batches b where b.id = p_batch_id;
    if v_batch_studio is null then return; end if;
    select r.code into v_code from public.new_client_waitlist_resolve_owner(v_batch_studio, p_actor_user_id) r;
    if v_code is distinct from 'ok' then return; end if;
  end if;
  -- AN ISSUED ITEM NOBODY SETTLED within the lease (the worker died between the issue and the delivery answer) becomes UNKNOWN, never claimable:
  -- whether the message left is not known, so it is not sent again by itself.
  -- The rows are picked in id order with FOR UPDATE SKIP LOCKED first, so two overlapping claim calls never wait on each other's rows (no 40P01).
  update public.waitlist_invitation_batch_items u set state = 'unknown', reason_class = 'delivery_unconfirmed', settled_at = pg_catalog.clock_timestamp()
   where u.id in (select x.id from public.waitlist_invitation_batch_items x
                   where x.state = 'issued' and (p_batch_id is null or x.batch_id = p_batch_id) and x.issued_at < pg_catalog.clock_timestamp() - make_interval(secs => p_lease_seconds)
                   order by x.id for update skip locked);
  v_left := p_total;
  for v_studio in
    select x.studio_id from (
      select i.studio_id, min(b.confirmed_at) as oldest
        from public.waitlist_invitation_batch_items i join public.waitlist_invitation_batches b on b.id = i.batch_id
       where (i.state = 'pending' or (i.state = 'claimed' and i.invitation_id is null and i.claimed_at < pg_catalog.clock_timestamp() - make_interval(secs => p_lease_seconds)))
         and (p_batch_id is null or i.batch_id = p_batch_id)
       group by i.studio_id) x order by x.oldest, x.studio_id
  loop
    exit when v_left <= 0;
    v_take := least(p_per_studio, v_left);
    for v_rec in
      with picked as (
        select i.id from public.waitlist_invitation_batch_items i join public.waitlist_invitation_batches b on b.id = i.batch_id
         where i.studio_id = v_studio and (p_batch_id is null or i.batch_id = p_batch_id)
           and (i.state = 'pending' or (i.state = 'claimed' and i.invitation_id is null and i.claimed_at < pg_catalog.clock_timestamp() - make_interval(secs => p_lease_seconds)))
         order by b.confirmed_at, i.id limit v_take for update of i skip locked),
      upd as (
        update public.waitlist_invitation_batch_items i set state = 'claimed', claimed_at = pg_catalog.clock_timestamp()
          from picked where i.id = picked.id returning i.id as uid, i.batch_id as ubatch, i.studio_id as ustudio, i.entry_id as uentry)
      select upd.uid, upd.ubatch, upd.ustudio, upd.uentry, b.confirmed_by_user_id as uactor, b.service_id as usvc,
             b.start_date as ustart, b.end_date as uend, b.allowed_weekdays as uwd, b.ttl_hours as uttl
        from upd join public.waitlist_invitation_batches b on b.id = upd.ubatch
    loop
      item_id := v_rec.uid; batch_id := v_rec.ubatch; studio_id := v_rec.ustudio; entry_id := v_rec.uentry; actor_user_id := v_rec.uactor;
      service_id := v_rec.usvc; start_date := v_rec.ustart; end_date := v_rec.uend; allowed_weekdays := v_rec.uwd; ttl_hours := v_rec.uttl;
      return next;
      v_left := v_left - 1;
    end loop;
  end loop;
end;
$$;

-- settle: records one item's outcome. A SENT item is terminal: settling it again changes nothing (a retry never resends a success).
-- UNKNOWN is distinct from failed: the invitation was issued but whether it was DELIVERED is not known (a timeout, a lost answer). It is never
-- claimed or sent again automatically, it still blocks the entry from another batch, and only the owner's separate retry (replace) or a later
-- confirmation (sent / failed) moves it on. Outcomes: sent (from issued | failed | unknown), failed (same, with a reason class), unknown (from
-- issued, with a reason class), skipped (from claimed, with a reason class).
-- Results: settled | already_sent | not_found | invalid_state | invalid_input | state_changed.
create or replace function public.settle_waitlist_batch_item(p_item_id uuid, p_studio_id uuid, p_entry_id uuid, p_outcome text, p_reason_class text, p_expected_state text default null)
returns text language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare v_state text;
begin
  -- THE ITEM MUST BELONG TO THE STUDIO AND THE ENTRY THE CALLER NAMES. The caller is the service worker, which holds the claimed row's studio and
  -- entry; a forged or stale item id therefore cannot settle another studio's item or another entry's. A mismatch is indistinguishable from a
  -- missing item ('not_found'), and a null studio or entry is refused rather than treated as "any", so omitting them cannot bypass the check.
  -- THE REASON CLASS IS A CLOSED SHAPE, checked here before anything is written: a free-text value (for example provider text carrying an address)
  -- would otherwise reach the table's check constraint, whose error echoes the value into the error and any log.
  if p_item_id is null or p_studio_id is null or p_entry_id is null or p_outcome not in ('sent','failed','skipped','unknown')
     or (p_reason_class is not null and p_reason_class !~ '^[a-z_]{1,40}$') then return 'invalid_input'; end if;
  select i.state into v_state from public.waitlist_invitation_batch_items i
   where i.id = p_item_id and i.studio_id = p_studio_id and i.entry_id = p_entry_id for update;
  if v_state is null then return 'not_found'; end if;
  -- COMPARE-AND-SWAP (optional): when the caller names the state it saw, the settle applies only if the item is still in it; otherwise nothing
  -- changes and the answer is 'state_changed'. Checked before the terminal-state answers, so a stale caller is told the state moved.
  if p_expected_state is not null and v_state <> p_expected_state then return 'state_changed'; end if;
  if v_state = 'sent' then return 'already_sent'; end if;
  if p_outcome = 'sent' and v_state in ('issued','failed','unknown') then
    update public.waitlist_invitation_batch_items set state = 'sent', reason_class = null, settled_at = pg_catalog.clock_timestamp() where id = p_item_id;
  elsif p_outcome = 'unknown' and v_state = 'issued' and p_reason_class is not null then
    update public.waitlist_invitation_batch_items set state = 'unknown', reason_class = p_reason_class, settled_at = pg_catalog.clock_timestamp() where id = p_item_id;
  elsif p_outcome = 'failed' and v_state in ('issued','failed','unknown') and p_reason_class is not null then
    update public.waitlist_invitation_batch_items set state = 'failed', reason_class = p_reason_class, settled_at = pg_catalog.clock_timestamp() where id = p_item_id;
  elsif p_outcome = 'skipped' and v_state = 'claimed' and p_reason_class is not null then
    update public.waitlist_invitation_batch_items set state = 'skipped', reason_class = p_reason_class, settled_at = pg_catalog.clock_timestamp() where id = p_item_id;
  else
    return 'invalid_state';
  end if;
  return 'settled';
end;
$$;

-- replace: atomic release + requeue + claim + issue for an entry holding a LIVE invitation (the retry path for a failed delivery). The live
-- count is unchanged and no capacity check runs. The entry keeps joined_at (so its queue priority). Refused when the person already used the
-- invitation. Results: replaced | not_owner | not_found | no_live_invitation | invitation_redeemed | invalid_service | pending_owner_review | state_changed | refused:<code from a closed set> | refused:other. Raw token returned once.
create or replace function public.replace_waitlist_invitation(p_studio_id uuid, p_actor_user_id uuid, p_entry_id uuid, p_expected_invitation_id uuid)
returns table (result text, invitation_id uuid, raw_token text, issued_at timestamptz, expires_at timestamptz)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid; v_round_id uuid; v_round_allowance integer;
  v_code text; v_status text; v_old record; v_r text; v_issue record; v_issued timestamptz; v_expires timestamptz; v_ttl integer;
  v_svc_active boolean; v_svc_modality text; v_svc_name text;
begin
  select r.practitioner_id, r.code into v_actor, v_code from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return query select 'not_owner'::text, null::uuid, null::text, null::timestamptz, null::timestamptz; return; end if;
  -- THE STUDIO LOCK FIRST, the same outer mutex admit and create take, so two replaces (or a replace and an admit) in one studio
  -- serialise instead of deadlocking on the entry rows (40P01). Order everywhere: owner -> studio -> entry.
  perform 1 from public.studios s where s.id = p_studio_id for no key update;
  select e.status into v_status from public.new_client_waitlist_entries e where e.id = p_entry_id and e.studio_id = p_studio_id for update;
  if v_status is null then return query select 'not_found'::text, null::uuid, null::text, null::timestamptz, null::timestamptz; return; end if;
  select i.id, i.redeemed_at, i.issued_at, i.expires_at, i.scope_service_id, i.scope_start_date, i.scope_end_date, i.scope_allowed_weekdays
    into v_old from public.new_client_waitlist_invitations i
   where i.entry_id = p_entry_id and i.studio_id = p_studio_id order by i.issued_at desc limit 1;
  if v_status <> 'invited' or v_old.id is null then
    return query select 'no_live_invitation'::text, null::uuid, null::text, null::timestamptz, null::timestamptz; return; end if;
  -- COMPARE-AND-SWAP: the replace applies only to the invitation the caller SAW. Two instances that both re-checked and both call replace cannot
  -- both succeed: the first replaces (a new invitation becomes the latest), the second finds a different latest invitation and changes nothing.
  -- A null expected id never matches a live invitation.
  if v_old.id is distinct from p_expected_invitation_id then
    return query select 'state_changed'::text, null::uuid, null::text, null::timestamptz, null::timestamptz; return; end if;
  if v_old.redeemed_at is not null then
    return query select 'invitation_redeemed'::text, null::uuid, null::text, null::timestamptz, null::timestamptz; return; end if;
  -- THE SAME GUARDS ADMIT APPLIES, re-checked now: the service must still be bookable by a new client, and an entry with an OPEN
  -- decline follow-up or withdrawal request is not offered again until the owner has handled it.
  select sv.active, sv.modality, sv.name into v_svc_active, v_svc_modality, v_svc_name
    from public.services sv where sv.id = v_old.scope_service_id and sv.studio_id = p_studio_id for share;
  if not found or not public.service_is_bookable_by_new_client(v_svc_active, v_svc_modality, v_svc_name) then
    return query select 'invalid_service'::text, null::uuid, null::text, null::timestamptz, null::timestamptz; return; end if;
  if exists (select 1 from public.waitlist_followups f where f.entry_id = p_entry_id and f.studio_id = p_studio_id and f.status = 'open') then
    return query select 'pending_owner_review'::text, null::uuid, null::text, null::timestamptz, null::timestamptz; return; end if;
  v_ttl := greatest(1, least(168, ceil(extract(epoch from (v_old.expires_at - v_old.issued_at)) / 3600.0)::integer));
  begin
    v_r := public.release_new_client_waitlist_entry(p_studio_id, p_entry_id, p_actor_user_id);
    if v_r <> 'released' then raise exception '%', v_r using errcode = 'WA001'; end if;
    v_r := public.requeue_new_client_waitlist_entry(p_studio_id, p_entry_id, p_actor_user_id);
    if v_r <> 'requeued' then raise exception '%', v_r using errcode = 'WA001'; end if;
    v_r := public.claim_new_client_waitlist_entry(p_studio_id, p_entry_id, p_actor_user_id);
    if v_r <> 'claimed' then raise exception '%', v_r using errcode = 'WA001'; end if;
    -- A FULL ADMISSION ROUND DOES NOT BLOCK A REPLACE. Rotated here exactly as admit rotates it (a replace issues a new invitation, which the
    -- round's allowance counts): without it, a replace from a closed older round while the open round is full would be refused as round_full
    -- and hide the delivery retry. Safe for the same reason as in admit: the capacity count is studio-wide, not per round.
    select r.id, r.allowance into v_round_id, v_round_allowance
      from public.studio_waitlist_admission_rounds r
     where r.studio_id = p_studio_id and r.closed_at is null;
    if v_round_id is not null
       and public.waitlist_admission_round_consumed(v_round_id) >= v_round_allowance then
      update public.studio_waitlist_admission_rounds r
         set closed_at = clock_timestamp(), closed_by_practitioner_id = v_actor, updated_at = clock_timestamp()
       where r.id = v_round_id and r.closed_at is null;
      insert into public.studio_waitlist_admission_rounds
        (studio_id, allowance, opened_at, opened_by_practitioner_id, updated_at)
      values (p_studio_id, 100, clock_timestamp(), v_actor, clock_timestamp());
    end if;
    select * into v_issue from public.issue_scoped_new_client_waitlist_invitation(
      p_studio_id, p_entry_id, p_actor_user_id, v_old.scope_service_id, v_old.scope_start_date, v_old.scope_end_date,
      v_old.scope_allowed_weekdays, v_ttl);
    if v_issue.result <> 'issued' then raise exception '%', v_issue.result using errcode = 'WA001'; end if;
    select i.issued_at, i.expires_at into v_issued, v_expires from public.new_client_waitlist_invitations i where i.id = v_issue.invitation_id;
    -- A batch item that pointed at the old invitation follows the new one.
    update public.waitlist_invitation_batch_items bi set invitation_id = v_issue.invitation_id
     where bi.entry_id = p_entry_id and bi.invitation_id = v_old.id and bi.state in ('issued','unknown','failed');
    return query select 'replaced'::text, v_issue.invitation_id, v_issue.raw_token, v_issued, v_expires;
    return;
  exception when sqlstate 'WA001' then
    -- A CLOSED SET OF REFUSAL CODES. The suffix is the inner command's own code when it is one of the known ones and 'refused:other' for anything
    -- else, so no free text (a message, a value) can ride out in a result that a worker logs.
    return query select (case when SQLERRM = any (array['already_redeemed','invalid_input','not_releasable','already_active','not_requeueable',
                                                          'not_found','not_waiting','already_declined_offer','invalid_scope_dates','invalid_service',
                                                          'invalid_weekdays','no_round_open','round_full','unknown_studio','already_invited','invalid_ttl'])
                              then 'refused:' || SQLERRM else 'refused:other' end)::text,
                        null::uuid, null::text, null::timestamptz, null::timestamptz;
    return;
  end;
end;
$$;

-- stop: the OWNER's stop control for a running batch. Moves the batch's PENDING items, and its lease-expired CLAIMED items that have no invitation
-- (a worker that died before admit), to skipped (reason owner_stopped). It never touches an issued, unknown, failed or sent item or a claim still
-- inside its lease, so work in flight finishes and nothing delivered is undone. Idempotent: a second call
-- stops nothing and says so. A race with a claim is decided by the item's row lock: the item is either already claimed (not stopped) or
-- stopped before it can be claimed, never both.
-- Results: stopped | nothing_pending | not_owner | not_found | invalid_input. The count is how many items this call stopped.
create or replace function public.stop_waitlist_batch(p_studio_id uuid, p_actor_user_id uuid, p_batch_id uuid, p_lease_seconds integer)
returns table (result text, cancelled integer)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare v_code text; v_n integer;
begin
  if p_studio_id is null or p_actor_user_id is null or p_batch_id is null or p_lease_seconds is null or p_lease_seconds < 5 then return query select 'invalid_input'::text, 0; return; end if;
  select r.code into v_code from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return query select 'not_owner'::text, 0; return; end if;
  perform 1 from public.studios s where s.id = p_studio_id for no key update;
  if not exists (select 1 from public.waitlist_invitation_batches b where b.id = p_batch_id and b.studio_id = p_studio_id) then
    return query select 'not_found'::text, 0; return; end if;
  update public.waitlist_invitation_batch_items i
     set state = 'skipped', reason_class = 'owner_stopped', settled_at = pg_catalog.clock_timestamp()
   where i.batch_id = p_batch_id and i.studio_id = p_studio_id
     and (i.state = 'pending'
          or (i.state = 'claimed' and i.invitation_id is null and i.claimed_at < pg_catalog.clock_timestamp() - make_interval(secs => p_lease_seconds)));
  get diagnostics v_n = row_count;
  return query select (case when v_n > 0 then 'stopped' else 'nothing_pending' end)::text, v_n;
end;
$$;

-- Grants BY NAME for every default grantee, service_role only.
revoke all privileges on function public.create_waitlist_invitation_batch(uuid, uuid, uuid, uuid[], uuid, date, date, smallint[], integer, integer, integer, boolean) from public, anon, authenticated, service_role;
grant execute on function public.create_waitlist_invitation_batch(uuid, uuid, uuid, uuid[], uuid, date, date, smallint[], integer, integer, integer, boolean) to service_role;
revoke all privileges on function public.preview_waitlist_over_invite(uuid, uuid, uuid[], date, date, smallint[]) from public, anon, authenticated, service_role;
grant execute on function public.preview_waitlist_over_invite(uuid, uuid, uuid[], date, date, smallint[]) to service_role;
revoke all privileges on function public.claim_waitlist_batch_items(integer, integer, integer, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_waitlist_batch_items(integer, integer, integer, uuid, uuid) to service_role;
revoke all privileges on function public.settle_waitlist_batch_item(uuid, uuid, uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.settle_waitlist_batch_item(uuid, uuid, uuid, text, text, text) to service_role;
revoke all privileges on function public.stop_waitlist_batch(uuid, uuid, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.stop_waitlist_batch(uuid, uuid, uuid, integer) to service_role;
revoke all privileges on function public.replace_waitlist_invitation(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.replace_waitlist_invitation(uuid, uuid, uuid, uuid) to service_role;
revoke all privileges on function public.admit_new_client_waitlist_entry(uuid, uuid, uuid, uuid, date, date, smallint[], integer, integer, uuid) from public, anon, authenticated, service_role;
grant execute on function public.admit_new_client_waitlist_entry(uuid, uuid, uuid, uuid, date, date, smallint[], integer, integer, uuid) to service_role;

do $$
declare v_fn regprocedure; v_role text;
begin
  foreach v_fn in array array['public.stop_waitlist_batch(uuid, uuid, uuid, integer)'::regprocedure,'public.create_waitlist_invitation_batch(uuid, uuid, uuid, uuid[], uuid, date, date, smallint[], integer, integer, integer, boolean)'::regprocedure,'public.preview_waitlist_over_invite(uuid, uuid, uuid[], date, date, smallint[])'::regprocedure,'public.claim_waitlist_batch_items(integer, integer, integer, uuid, uuid)'::regprocedure,'public.settle_waitlist_batch_item(uuid, uuid, uuid, text, text, text)'::regprocedure,'public.replace_waitlist_invitation(uuid, uuid, uuid, uuid)'::regprocedure,'public.admit_new_client_waitlist_entry(uuid, uuid, uuid, uuid, date, date, smallint[], integer, integer, uuid)'::regprocedure] loop
    foreach v_role in array array['anon','authenticated'] loop
      if pg_catalog.has_function_privilege(v_role, v_fn, 'EXECUTE') then raise exception '0363: % must not execute %', v_role, v_fn; end if;
    end loop;
    if not pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE') then raise exception '0363: service_role must execute %', v_fn; end if;
  end loop;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'admit_new_client_waitlist_entry') <> 1 then
    raise exception '0363: exactly one admit_new_client_waitlist_entry overload must remain';
  end if;
end;
$$;

commit;
