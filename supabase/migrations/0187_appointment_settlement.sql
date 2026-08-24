-- ===========================================================================
-- APPOINTMENT SETTLEMENT — PRACTITIONER-ATTESTED DISPOSITION (PAY-SETTLE) — 0187
-- ===========================================================================
--
-- THE DEFECT. A completed appointment offers exactly one way to stop asking to
-- be paid: run a card charge through Stripe. When the client paid cash, sent an
-- e-transfer, settled some other way, was forgiven the fee, or simply still
-- owes, the practitioner's only options are to leave Checkout showing forever
-- or to run a payment that did not happen. The second one is worse: it puts a
-- fabricated Stripe charge on a real client's card record, and it makes the
-- studio's revenue number a fiction. Chloe has been living with the first.
--
-- THE LAW THIS FILE ENFORCES. There are two kinds of money truth and they are
-- never the same kind:
--
--   MONEY HONE VERIFIED             a Stripe charge that actually succeeded.
--                                   Lives in payment_charge_attempts, and
--                                   NOWHERE ELSE. Untouched by this file.
--
--   DISPOSITION A PRACTITIONER      what the practitioner says happened.
--   ATTESTED                        Lives here. Carries an actor, a server
--                                   timestamp, and no Stripe identifier of any
--                                   kind.
--
-- The structural guarantee is the absence of a value: `method` HAS NO `card`
-- OR `hone` MEMBER. An attestation that a card was charged is not a thing this
-- schema can store. Collapsing the two concepts is therefore not discouraged
-- here, it is unrepresentable — which is the only form of the guarantee that
-- survives a future author who has not read this header.
--
-- WHAT UNKNOWN IS. The ABSENCE of a live row. Every appointment in production
-- history has no row here and therefore no disposition, and that is the
-- truthful answer. This migration writes ZERO rows and backfills NOTHING: a
-- guess about a visit from three months ago, written into a financial table,
-- is indistinguishable from evidence a week later. `unknown` is deliberately
-- NOT a `method` value, because a value would have to be written by somebody,
-- and nobody knows.
--
-- WHAT THIS FILE ALSO DOES, AND WHY IT IS NOT PURELY ADDITIVE. It replaces
-- public.claim_session_payment_charge_attempt (0075 -> 0083 -> 0101), the
-- function that turns a prepared attempt into an in-flight Stripe charge. That
-- replacement is the ONLY way to make settlement and card charging mutually
-- exclusive at the authority rather than in a browser. See "THE SHARED LOCK".
--
-- WHAT THIS FILE DOES NOT DO. No Financials page, no revenue rollup, no view,
-- no report. It establishes the trustworthy data FIN-01A will later consume
-- and stops there.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- THE TABLE
-- ---------------------------------------------------------------------------
-- ANCHORED ON THE APPOINTMENT, NOT THE SESSION.
--
-- The card path is session-scoped: payment_charge_attempts requires a
-- session_id for charge_reason = 'session_payment', and quick checkout tells a
-- practitioner with no session yet to go and chart first. That ordering is
-- correct for a card charge — the amount comes off the treatment record.
--
-- It is WRONG for cash. "She paid me forty dollars at the door" is a fact about
-- the VISIT, and forcing it to wait for charting is exactly the coupling that
-- produced the fake-payment workaround this release exists to end. So the
-- anchor is the appointment, and the treatment session is joined when a
-- reader wants it rather than copied here.
--
-- TENANCY IS THE FIRST PROPERTY. studio_id is NOT NULL, and the appointment,
-- session and actor references are all COMPOSITE FKs that include it (the 0179
-- actor-FK doctrine, widened here to every relation). A row that names another
-- studio's appointment is not merely rejected by a policy — it cannot be
-- stored, because no such parent tuple exists.
create table if not exists public.appointment_settlements (
  id uuid primary key default gen_random_uuid(),

  studio_id uuid not null
    references public.studios(id) on delete cascade,

  -- The visit this disposition is about. ON DELETE RESTRICT, not CASCADE:
  -- financial history does not disappear because somebody tidied a calendar.
  appointment_id uuid not null,

  -- THERE IS DELIBERATELY NO session_id. It would be pure denormalization: a
  -- reader that wants the treatment session joins sessions ON appointment_id,
  -- which is the same fact with no second copy to drift. It would also be the
  -- one relation here that could NOT be made structurally same-studio, because
  -- public.sessions carries no companion unique (id, studio_id) the way
  -- appointments, clients and practitioners have since 0032 — so the column
  -- would have had to rely on the command being careful rather than on the
  -- schema being unable to store the wrong thing. Removing it keeps every
  -- relation on this table cross-studio-proof by construction.

  -- ---------------------------------------------------------------------
  -- THE VOCABULARY. Five values, closed by CHECK.
  -- ---------------------------------------------------------------------
  --   paid_cash            collected, externally, in cash
  --   paid_e_transfer      collected, externally, by e-transfer
  --   paid_other_external  collected, externally, some other way
  --   waived               NOT collected, and never will be. Owner only.
  --   still_owes           NOT collected, outstanding
  --
  -- THERE IS NO 'card' AND NO 'hone'. See the header. A reader that wants
  -- Hone-verified money reads payment_charge_attempts; there is no second
  -- place to look, so the two can never be summed into one another by
  -- accident.
  method text not null,

  -- WHAT THE AMOUNT MEANS IS FIXED BY THE METHOD, and there is exactly ONE
  -- amount column.
  --
  --   paid_*      -> the amount COLLECTED
  --   waived      -> the amount FORGIVEN
  --   still_owes  -> the amount OUTSTANDING
  --
  -- Three nullable columns (collected_cents / waived_cents / outstanding_cents)
  -- were considered and rejected: they can disagree with each other, and a
  -- reader has to know which combination is legal. One column whose meaning is
  -- determined by a closed enum cannot be internally inconsistent.
  --
  -- >= 0 rather than > 0: a $0 waiver of a $0 service is coherent, and
  -- refusing it would push a truthful record out of the system.
  amount_cents integer not null,

  -- Mirrors payment_charge_attempts.currency exactly, including its single
  -- legal value, so the two ledgers cannot drift into different money.
  currency text not null default 'cad',

  -- THE PRICE AT THE TIME, SNAPSHOTTED.
  --
  -- Resolved by the caller from the SAME authoritative resolver the card path
  -- uses (getAuthoritativeSessionPaymentAmount -> resolveAuthoritative-
  -- SessionPaymentAmount), never recomputed here and never read from a form.
  -- It is stored because the menu price is mutable: without the snapshot, a
  -- service repriced in March silently rewrites what February's completed
  -- visits were worth, and FIN-01A's collection rate drifts away from what
  -- Checkout actually showed. Null only when the price could not be resolved,
  -- which is a fact worth keeping rather than a zero worth inventing.
  quoted_amount_cents integer,

  -- ACTOR. Composite FK per 0179: a settlement can never be attributed to a
  -- practitioner from another studio, which is precisely the dual-membership
  -- configuration behind the 0181 incident. RESTRICT because attribution is
  -- durable; practitioners are deactivated, not deleted.
  recorded_by_practitioner_id uuid not null,

  -- SERVER-OWNED TIME, forced by the BEFORE INSERT trigger below rather than
  -- defaulted. `default now()` applies only when the caller omits the column,
  -- and this is a financial record whose ordering must not be author-supplied.
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Optional practitioner-entered context. Sensitive by default: never sent to
  -- a client, never placed on a Stripe receipt. Bounded here because the
  -- application's bound is a courtesy and this is the authority.
  note text,

  -- ---------------------------------------------------------------------
  -- SUPERSESSION — THE ONLY MUTABLE FIELDS ON THIS TABLE
  -- ---------------------------------------------------------------------
  -- A correction NEVER edits the record it corrects. It inserts a new row
  -- carrying supersedes_id, and stamps the old row's two supersession columns,
  -- in ONE transaction under ONE lock. The old row's method, amount, actor and
  -- timestamp are frozen forever; the immutable-fields trigger below enforces
  -- that every other column is untouchable on UPDATE, and no role ever holds
  -- DELETE.
  supersedes_id uuid
    references public.appointment_settlements(id) on delete restrict,
  superseded_at timestamptz,
  -- DEFERRABLE INITIALLY DEFERRED, and that is load-bearing rather than
  -- decorative. The single-truth partial unique index is checked IMMEDIATELY
  -- and cannot be deferred (PostgreSQL has no deferrable partial unique
  -- constraint), so a correction MUST retire the old row before inserting its
  -- replacement or the index refuses the write. Retiring first means naming a
  -- successor that does not exist yet for the length of one statement, which
  -- an immediate FK would reject. Deferring THIS constraint — and only this
  -- one — is what lets both invariants hold inside a single transaction.
  superseded_by_settlement_id uuid,

  -- Required on the CORRECTING row (CHECK below). "Why is this different from
  -- what we said before" is the whole value of an audit trail; a correction
  -- without a reason is just a second contradictory claim.
  supersede_reason text,

  constraint appointment_settlements_superseded_by_fk
    foreign key (superseded_by_settlement_id)
    references public.appointment_settlements (id) on delete restrict
    deferrable initially deferred,

  constraint appointment_settlements_appointment_same_studio_fk
    foreign key (appointment_id, studio_id)
    references public.appointments (id, studio_id) on delete restrict,

  constraint appointment_settlements_actor_same_studio_fk
    foreign key (recorded_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict
);

-- ---------------------------------------------------------------------------
-- CONSTRAINTS. DROP+ADD so the file is re-runnable.
-- ---------------------------------------------------------------------------

-- THE CLOSED VOCABULARY. The single most important line in this file: adding
-- 'card' or 'hone' here is the mutation that would collapse Stripe truth into
-- practitioner attestation, and it is pinned by a positive allowlist in
-- tests/migrations/0187-appointment-settlement.test.ts.
alter table public.appointment_settlements
  drop constraint if exists appointment_settlements_method_check;
alter table public.appointment_settlements
  add constraint appointment_settlements_method_check
  check (method in (
    'paid_cash',
    'paid_e_transfer',
    'paid_other_external',
    'waived',
    'still_owes'
  ));

-- Same ceiling as payment_charge_attempts.amount_cents (0073), so a
-- disposition cannot claim an amount the card path would have refused.
alter table public.appointment_settlements
  drop constraint if exists appointment_settlements_amount_check;
alter table public.appointment_settlements
  add constraint appointment_settlements_amount_check
  check (amount_cents >= 0 and amount_cents <= 200000);

alter table public.appointment_settlements
  drop constraint if exists appointment_settlements_quoted_amount_check;
alter table public.appointment_settlements
  add constraint appointment_settlements_quoted_amount_check
  check (
    quoted_amount_cents is null
    or (quoted_amount_cents >= 0 and quoted_amount_cents <= 200000)
  );

alter table public.appointment_settlements
  drop constraint if exists appointment_settlements_currency_check;
alter table public.appointment_settlements
  add constraint appointment_settlements_currency_check
  check (currency in ('cad'));

alter table public.appointment_settlements
  drop constraint if exists appointment_settlements_note_check;
alter table public.appointment_settlements
  add constraint appointment_settlements_note_check
  check (note is null or length(btrim(note)) between 1 and 500);

-- A CORRECTION MUST SAY WHY. supersedes_id and supersede_reason are
-- all-or-nothing: an original record carries neither, a correcting record
-- carries both. A correction with a blank reason is unrepresentable, not
-- merely discouraged.
alter table public.appointment_settlements
  drop constraint if exists appointment_settlements_supersede_reason_check;
alter table public.appointment_settlements
  add constraint appointment_settlements_supersede_reason_check
  check (
    (supersedes_id is null and supersede_reason is null)
    or (supersedes_id is not null
        and supersede_reason is not null
        and length(btrim(supersede_reason)) between 1 and 500)
  );

-- SUPERSESSION EVIDENCE IS ALL-OR-NOTHING TOO. A row stamped with a time but
-- no successor is an unexplained retirement; a successor pointer with no time
-- is a dangling claim. Neither can exist.
alter table public.appointment_settlements
  drop constraint if exists appointment_settlements_superseded_evidence_check;
alter table public.appointment_settlements
  add constraint appointment_settlements_superseded_evidence_check
  check (
    (superseded_at is null and superseded_by_settlement_id is null)
    or (superseded_at is not null and superseded_by_settlement_id is not null)
  );

-- A row cannot supersede itself, in either direction.
alter table public.appointment_settlements
  drop constraint if exists appointment_settlements_no_self_supersede_check;
alter table public.appointment_settlements
  add constraint appointment_settlements_no_self_supersede_check
  check (
    (supersedes_id is null or supersedes_id <> id)
    and (superseded_by_settlement_id is null or superseded_by_settlement_id <> id)
  );

-- ---------------------------------------------------------------------------
-- THE SINGLE-TRUTH LAW
-- ---------------------------------------------------------------------------
-- EXACTLY ONE LIVE SETTLEMENT PER APPOINTMENT.
--
-- This one partial index is simultaneously:
--
--   * the DOUBLE-COLLECTION law  — one appointment cannot carry both a cash
--                                  record and an e-transfer record;
--   * the REPLAY law             — a double-submitted server action inserts
--                                  once and the loser reads back the winner;
--   * the CORRECTION law         — supersession must retire the old row in the
--                                  same statement that inserts the new one, or
--                                  the index refuses the write.
--
-- Enforced by the database rather than by a read-then-insert in application
-- code, because a read-then-insert is decided by luck under concurrency. It is
-- also why the commands below never need a caller-supplied idempotency token:
-- the natural key IS the idempotency key.
create unique index if not exists appointment_settlements_one_live_per_appointment
  on public.appointment_settlements (studio_id, appointment_id)
  where superseded_at is null;

-- A superseded row may be pointed at exactly once, so a correction chain is a
-- line and never a tree.
create unique index if not exists appointment_settlements_one_successor_per_row
  on public.appointment_settlements (supersedes_id)
  where supersedes_id is not null;

-- The FIN-01A read: one studio, a date range, newest first. Column order
-- matches the intended ORDER BY so the bounded read is an index scan.
create index if not exists appointment_settlements_studio_recorded_idx
  on public.appointment_settlements (studio_id, recorded_at desc, id);

-- The per-appointment badge read used by the dashboard/calendar loader.
create index if not exists appointment_settlements_appointment_idx
  on public.appointment_settlements (studio_id, appointment_id)
  where superseded_at is null;

-- ---------------------------------------------------------------------------
-- TRIGGERS
-- ---------------------------------------------------------------------------
drop trigger if exists appointment_settlements_set_updated_at
  on public.appointment_settlements;
create trigger appointment_settlements_set_updated_at
  before update on public.appointment_settlements
  for each row execute function public.set_updated_at();

-- FINANCIAL TIME IS DATABASE TIME.
--
-- recorded_at orders the audit trail and will order FIN-01A's period buckets.
-- A caller able to supply it could date a cash record into a closed period.
-- Overwritten rather than rejected: on INSERT there is no prior value to
-- protect.
create or replace function public.appointment_settlements_server_timestamps()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.recorded_at := now();
  new.created_at  := now();
  new.updated_at  := now();
  -- Supersession evidence is never written by the INSERT of a row; it is
  -- stamped onto the row being RETIRED, by the UPDATE inside the supersede
  -- command. A caller that supplies it on insert is claiming a retirement that
  -- never happened.
  new.superseded_at := null;
  new.superseded_by_settlement_id := null;
  return new;
end;
$$;

drop trigger if exists appointment_settlements_server_timestamps
  on public.appointment_settlements;
create trigger appointment_settlements_server_timestamps
  before insert on public.appointment_settlements
  for each row execute function public.appointment_settlements_server_timestamps();

-- THE APPEND-ONLY LAW.
--
-- THE ONLY LEGAL UPDATE ON THIS TABLE IS THE ONE THAT RETIRES A ROW: null
-- supersession evidence -> populated supersession evidence, once, forever.
--
-- Everything else is frozen. Not "should not be changed" — cannot be. This is
-- the 0183 failure shape stated as a rule: a contract written in prose and
-- enforced over a narrower set than the prose describes is not a contract. So
-- the guard enumerates every column POSITIVELY and rejects any drift in any of
-- them, rather than listing the few it happens to think of.
--
-- In particular: a disposition is NEVER updated into a different disposition.
-- Correcting "paid cash" to "waived" inserts a new row and retires the old
-- one; the original still says paid_cash a year later, with the practitioner
-- who said it and the second they said it.
create or replace function public.appointment_settlements_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.id is distinct from old.id
     or new.studio_id is distinct from old.studio_id
     or new.appointment_id is distinct from old.appointment_id
     or new.method is distinct from old.method
     or new.amount_cents is distinct from old.amount_cents
     or new.currency is distinct from old.currency
     or new.quoted_amount_cents is distinct from old.quoted_amount_cents
     or new.recorded_by_practitioner_id is distinct from old.recorded_by_practitioner_id
     or new.recorded_at is distinct from old.recorded_at
     or new.created_at is distinct from old.created_at
     or new.note is distinct from old.note
     or new.supersedes_id is distinct from old.supersedes_id
     or new.supersede_reason is distinct from old.supersede_reason then
    raise exception
      'appointment_settlements: financial records are append-only; correct by superseding, never by updating'
      using errcode = 'check_violation';
  end if;

  -- WRITE-ONCE retirement. Not to a different successor, not to a different
  -- time, and never back to NULL — which would resurrect a retired record as
  -- live and break the single-truth index.
  if old.superseded_at is not null
     and (new.superseded_at is distinct from old.superseded_at
          or new.superseded_by_settlement_id is distinct from old.superseded_by_settlement_id) then
    raise exception
      'appointment_settlements: a superseded record is retired once and cannot be re-pointed or revived'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists appointment_settlements_append_only
  on public.appointment_settlements;
create trigger appointment_settlements_append_only
  before update on public.appointment_settlements
  for each row execute function public.appointment_settlements_append_only();

-- HISTORY IS NOT DELETABLE. No role is granted DELETE below, so this trigger
-- is the second of two independent failures required before a financial record
-- could vanish — the same doubled-defence shape as the RLS/grant pairing.
create or replace function public.appointment_settlements_no_delete()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception
    'appointment_settlements: financial history is never deleted'
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists appointment_settlements_no_delete
  on public.appointment_settlements;
create trigger appointment_settlements_no_delete
  before delete on public.appointment_settlements
  for each row execute function public.appointment_settlements_no_delete();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- READ-ONLY, MEMBER-SCOPED, OWN STUDIO ONLY.
--
-- Exactly ONE policy, and it is a SELECT policy. No insert, update or delete
-- policy exists for any role, so a widened table grant alone still produces no
-- browser-reachable write: RLS and the grant would both have to fail.
--
-- MEMBER, not owner — unlike 0185. The badge belongs on the dashboard row of
-- the practitioner who performed the visit, and the authority to RECORD a
-- disposition is the Checkout authority, which is membership. An owner-only
-- read would hide from a practitioner the fact she herself recorded.
alter table public.appointment_settlements enable row level security;

drop policy if exists "appointment_settlements_member_select"
  on public.appointment_settlements;
create policy "appointment_settlements_member_select"
  on public.appointment_settlements for select to authenticated
  -- Fully qualified: 0126 wrote the equivalent clause with a bare column name,
  -- PostgreSQL resolved it against the wrong relation, and the check degraded
  -- into a tautology that 0127 repaired in production.
  using (public.is_studio_member(appointment_settlements.studio_id));

-- ---------------------------------------------------------------------------
-- THE SHARED LOCK
-- ---------------------------------------------------------------------------
-- ONE KEY, THREE CALLERS, BYTE-IDENTICAL.
--
-- Settlement and card charging must be mutually exclusive in BOTH directions,
-- and the exclusion has to live where forged requests, replayed form posts and
-- two browser tabs all arrive: the database.
--
-- WHY AN ADVISORY LOCK AND NOT `FOR UPDATE`. The card path already serializes
-- on the ATTEMPT ROW (claim_session_payment_charge_attempt takes `select ...
-- for update`), and that works there because the row already exists. It cannot
-- work here: a first settlement locks nothing, because `for update` over an
-- empty window locks nothing. That is the exact false guarantee 0181 documented
-- and repaired for session coalescing, and it is why the key below is advisory
-- and keyed on the APPOINTMENT rather than on any row.
--
-- WHAT THE LOCK DOES AND DOES NOT DO. It serializes the DECISION. It is
-- released at commit, which for the card path is BEFORE Stripe is called — so
-- the lock alone is never the guarantee. Both sides therefore decide from
-- PERSISTED state while holding the key, and the single-truth index plus the
-- attempt uniqueness index are the durable backstops.
--
-- LOCK ORDERING IS GLOBAL AND FIXED: ADVISORY FIRST, ROW SECOND, ALWAYS.
-- The claim command must resolve the appointment with a NON-LOCKING read
-- before it can compute the key, then take the advisory lock, and only then
-- take its existing `for update`. Reversing the last two introduces an
-- ordering cycle against this file's commands and deadlocks under exactly the
-- concurrency it exists to survive.
create or replace function public.appointment_settlement_lock_key(
  p_appointment_id uuid
)
returns bigint
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select hashtextextended('hone:appointment_settlement:' || p_appointment_id::text, 0);
$$;

-- ---------------------------------------------------------------------------
-- INTERNAL — THE SERVICE-VALUE SNAPSHOT, DERIVED HERE AND ONLY HERE
-- ---------------------------------------------------------------------------
-- WHY THE CALLER NO LONGER SUPPLIES THIS.
--
-- quoted_amount_cents was a PARAMETER of the granted commands. The server
-- action computed it correctly from the shared resolver, but the commands are
-- granted to `authenticated`, so any practitioner could call them straight
-- through PostgREST with an invented in-range number — and that number was
-- stored verbatim in the column the schema calls the authoritative price
-- snapshot, the one FIN-01A will divide by. A value a caller may choose is not
-- an authority, however carefully the honest caller computes it.
--
-- So the database derives it. There is no parameter left to forge.
--
-- THIS REPRODUCES resolveAuthoritativeSessionPaymentAmount, STEP FOR STEP, and
-- the two are pinned against each other by a parity matrix in
-- tests/db/appointment-settlement.db.test.ts. The order below IS the law:
--
--   1. the appointment, inside the NAMED studio;
--   2. its booked service, through the same-studio lineage;
--   3. client_pricing matched by NORMALIZED SERVICE NAME — lower(btrim(...)) —
--      because that linkage has always been by name, not by id;
--   4. only rows effective ON OR BEFORE the STUDIO-LOCAL date qualify, so a
--      price that starts tomorrow does not price today's visit;
--   5. newest effective_from wins;
--   6. equally-current rows that DISAGREE resolve to NULL. Never by row order:
--      a pick there would be decided by the planner, not by anything the studio
--      recorded;
--   7. equally-current rows that AGREE are deterministic, and resolve;
--   8. otherwise a POSITIVE menu price wins;
--   9. an explicit menu price of 0 is an authoritative zero;
--  10. a missing service, a NULL price, or ambiguity is NULL — a configuration
--      gap is never "free", and never a manufactured number.
--
-- A zero or negative CUSTOM price is read as "no custom price recorded", not as
-- "charge nothing" — the same filter the resolver applies, and the reason a bad
-- row falls through to the menu price instead of silently zeroing a visit.
--
-- THE DATE COMES FROM THE STUDIO'S OWN TIMEZONE, never from UTC and never from
-- a caller. `now() at time zone s.timezone` is the same studio-local day
-- todayInTz() produces for the resolver.
create or replace function public.appointment_quoted_amount_cents(
  p_studio_id uuid,
  p_appointment_id uuid
)
returns integer
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_service_name  text;
  v_service_price integer;
  v_client_id     uuid;
  v_today         date;
  v_latest        date;
  v_distinct      integer;
  v_custom        integer;
begin
  select s.name, s.price_cents, a.client_id,
         (now() at time zone st.timezone)::date
    into v_service_name, v_service_price, v_client_id, v_today
    from public.appointments a
    join public.studios st
      on st.id = a.studio_id
    left join public.services s
      on s.id = a.service_id
     and s.studio_id = a.studio_id
   where a.id = p_appointment_id
     and a.studio_id = p_studio_id;

  -- No appointment, or no booked service: nothing to price. NULL, never 0.
  if not found or v_service_name is null then
    return null;
  end if;

  if v_client_id is not null then
    select max(cp.effective_from) into v_latest
      from public.client_pricing cp
     where cp.studio_id = p_studio_id
       and cp.client_id = v_client_id
       and lower(btrim(cp.service_name)) = lower(btrim(v_service_name))
       and cp.effective_from <= v_today
       and cp.price_cents > 0;

    if v_latest is not null then
      select count(distinct cp.price_cents), min(cp.price_cents)
        into v_distinct, v_custom
        from public.client_pricing cp
       where cp.studio_id = p_studio_id
         and cp.client_id = v_client_id
         and lower(btrim(cp.service_name)) = lower(btrim(v_service_name))
         and cp.effective_from = v_latest
         and cp.price_cents > 0;

      -- Equally current, disagreeing. Fail closed rather than guess.
      if v_distinct > 1 then
        return null;
      end if;
      return v_custom;
    end if;
  end if;

  if v_service_price is not null and v_service_price > 0 then
    return v_service_price;
  end if;
  -- An explicit 0 is a decision the studio made. NULL is not.
  if v_service_price = 0 then
    return 0;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- INTERNAL — RETIRE A PREPARED-BUT-UNCHARGED CARD ATTEMPT
-- ---------------------------------------------------------------------------
-- THE DEAD END THIS REMOVES.
--
-- `ready` means a charge was PREPARED and Stripe has never been called. The
-- first draft treated it as card money, so: the practitioner prepares a charge,
-- the client then says "I'll pay cash", and every settlement command answers
-- card_payment_exists forever while the UI hides the controls. There is no
-- cancellation path for a ready SESSION-PAYMENT attempt anywhere in the product
-- (the 0146 cancel action is gated to fee reasons), so the only ways out were
-- to run the card charge that is not happening — the exact fake payment this
-- release exists to end — or to leave Checkout on the row forever.
--
-- CHOOSING A NON-CARD OUTCOME *IS* THE DECISION NOT TO USE THE PREPARED
-- ATTEMPT. It needs no second screen and no second confirmation, so the
-- retirement happens inside the settlement command, under the SAME advisory
-- key, in the SAME transaction, BEFORE card money is assessed.
--
-- EXACTLY ONE STATUS IS TOUCHED, AND NO NEW ONE IS INVENTED. The existing
-- lifecycle from 0073 already carries cancelled + cancelled_at +
-- cancelled_by_practitioner_id + cancelled_reason; this uses it. `ready` and
-- nothing else:
--
--   pending_stripe  a charge is IN FLIGHT at Stripe. Never retired here, and it
--                   remains a hard settlement refusal.
--   succeeded       money moved. Never retired; refunding is the reversal
--                   instrument and it lives in the card ledger.
--   failed / cancelled / blocked  already terminal; nothing to retire.
--
-- Nothing but the four cancellation columns is written: the amount, the card,
-- the signature and every Stripe identifier are left exactly as they were, and
-- the row is never deleted. A cancelled attempt is a record of a charge that
-- was prepared and deliberately not taken, which is true and worth keeping.
create or replace function public.retire_ready_card_attempts(
  p_studio_id uuid,
  p_appointment_id uuid,
  p_practitioner_id uuid
)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_count integer;
begin
  with target as (
    select a.id
      from public.payment_charge_attempts a
      left join public.sessions s
        on s.id = a.session_id
       and s.studio_id = a.studio_id
     where a.studio_id = p_studio_id
       and a.charge_reason = 'session_payment'
       and a.status = 'ready'
       and coalesce(a.appointment_id, s.appointment_id) = p_appointment_id
  )
  update public.payment_charge_attempts t
     set status = 'cancelled',
         cancelled_at = now(),
         cancelled_by_practitioner_id = p_practitioner_id,
         cancelled_reason = 'Retired: the visit was settled outside Hone.'
    from target
   where t.id = target.id
     -- Re-asserted in the UPDATE itself, so a row that advanced to
     -- pending_stripe between the CTE and the write is not retired.
     and t.status = 'ready';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- INTERNAL — IS THERE HONE-VERIFIED CARD MONEY ON THIS APPOINTMENT?
-- ---------------------------------------------------------------------------
-- THE MODE IS A DEPLOYMENT FACT, AND THE DATABASE HAS NEVER KNOWN IT. Livemode
-- comes from the STRIPE_SECRET_KEY prefix (lib/stripe/server.ts
-- inferStripeLivemode) and is STAMPED onto every attempt row by prepare; there
-- is no per-studio column or function that could tell us here. So the caller
-- passes it, exactly as every other mode-scoped read in the product does.
--
-- BUT THE CALLER IS NOT TRUSTED IN THE DANGEROUS DIRECTION. A caller that lied
-- about the mode could otherwise unblock a REAL succeeded live charge and
-- collect the same visit twice. The rule is therefore asymmetric:
--
--   * livemode = true card money ALWAYS blocks, whatever the caller says.
--     Real money is real money.
--   * livemode = false (test) card money blocks ONLY when the caller says it
--     is itself running in test mode. That keeps the exclusion provable in the
--     e2e-payment lane, while stopping abandoned pre-launch TEST history from
--     permanently blocking cash records in a LIVE deployment — the same
--     failure 0105 and the batched display loader already guard against.
--
-- A lie can therefore only make the check STRICTER for the liar. It can never
-- unblock real money.
--
-- 'succeeded' AND NOT FULLY REFUNDED is what counts as money Hone holds. After
-- a FULL refund the money went back, so recording that the client then paid
-- cash is TRUE and must be permitted — the refund fact itself is never touched.
--
-- FULL MEANS FULL, MEASURED IN CENTS, NOT INFERRED FROM refund_status.
-- `refund_status = 'succeeded'` says a refund SUCCEEDED, not that all of the
-- money went back. Today's helper is full-refund-only (0078: "full refund only
-- (helper sets refund_amount_cents = amount_cents)"), but the schema's CHECK is
-- `refund_amount_cents <= amount_cents` — it deliberately leaves room for
-- partial refunds, and 0078 says so in as many words. Testing the status alone
-- would mean the FIRST partial refund silently releases the settlement block on
-- an appointment where the studio still holds most of the money, and the client
-- could then be recorded as having paid it again in cash. So the amount is
-- compared explicitly, and a partial refund keeps blocking.
create or replace function public.appointment_has_live_card_money(
  p_studio_id uuid,
  p_appointment_id uuid,
  p_livemode boolean
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
      from public.payment_charge_attempts a
      left join public.sessions s
        on s.id = a.session_id
       and s.studio_id = a.studio_id
     where a.studio_id = p_studio_id
       and a.charge_reason = 'session_payment'
       and (a.stripe_livemode = true or p_livemode = false)
       and coalesce(a.appointment_id, s.appointment_id) = p_appointment_id
       and (
         -- `ready` is still card money to this predicate. The settlement
         -- commands retire a ready attempt BEFORE calling it, so by the time
         -- this runs a ready row means one that could not be retired — and the
         -- card claim path, which never retires anything, must still be blocked
         -- by it.
         a.status in ('ready', 'pending_stripe')
         or (a.status = 'succeeded'
             and not (
               a.refund_status = 'succeeded'
               and coalesce(a.refund_amount_cents, 0) >= a.amount_cents
             ))
       )
  );
$$;

-- ---------------------------------------------------------------------------
-- INTERNAL — IS THERE A LIVE ATTESTATION THAT BLOCKS A CARD CHARGE?
-- ---------------------------------------------------------------------------
-- `still_owes` DELIBERATELY DOES NOT BLOCK. "The client still owes" followed by
-- "the client paid by card" is the ordinary progression of a debt, and blocking
-- it would make every unpaid visit require an owner correction before anyone
-- could pay. The other four DO block: charging a card for a visit already
-- recorded as paid in cash, or as waived, is the double-collection this
-- release exists to prevent.
--
-- The `still_owes` row is NOT retired by the later card success. It stays live
-- and immutable, and the AUTHORITATIVE disposition is derived by ranking
-- Hone-verified terminal money above any attestation — the same precedence
-- lib/billing/appointment-payment-state.ts already applies when it lets a
-- succeeded charge outrank a $0 price. Retiring it automatically would mean a
-- background actor performing an owner-only correction.
create or replace function public.appointment_has_blocking_settlement(
  p_studio_id uuid,
  p_appointment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
      from public.appointment_settlements t
     where t.studio_id = p_studio_id
       and t.appointment_id = p_appointment_id
       and t.superseded_at is null
       and t.method in (
         'paid_cash',
         'paid_e_transfer',
         'paid_other_external',
         'waived'
       )
  );
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 1 — RECORD AN INITIAL NON-CARD DISPOSITION
-- ---------------------------------------------------------------------------
-- AUTHORITY IS THE EXISTING CHECKOUT BOUNDARY, RE-DERIVED HERE.
--
-- No new role model. The product rule is "whoever may run Checkout on this
-- appointment may record how it was actually settled", and Checkout's boundary
-- is: an ACTIVE practitioner of the NAMED studio, any role
-- (getCurrentPractitionerWithStudio -> resolveActivePractitionerMembership).
-- public.session_actor_practitioner(p_studio_id) is that same predicate
-- expressed in SQL — practitioners WHERE studio_id = <named> AND user_id =
-- auth.uid() AND active — so the two cannot drift apart.
--
-- THE STUDIO IS NAMED BY THE CALLER AND PROVEN HERE. A missing value is an
-- unresolvable actor context, not a licence to pick one (0181).
--
-- WAIVED IS REFUSED UNCONDITIONALLY. A waiver changes what the practice is
-- ENTITLED TO, not merely how the client paid, so it is owner-only and lives
-- in its own command. Refusing it here rather than branching keeps the
-- authority boundary a FUNCTION boundary — visible in pg_proc and in an ACL
-- dump, not buried in an `if` that a later edit can widen by accident.
create or replace function public.record_appointment_settlement(
  p_studio_id           uuid,
  p_appointment_id      uuid,
  p_method              text,
  p_amount_cents        integer,
  p_note                text,
  p_livemode            boolean
)
returns table (result text, settlement_id uuid, recorded_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_practitioner uuid;
  v_note         text := nullif(btrim(coalesce(p_note, '')), '');
  v_status       text;
  v_id           uuid;
  v_at           timestamptz;
begin
  if p_studio_id is null or p_appointment_id is null then
    return query select 'invalid_input'::text, null::uuid, null::timestamptz;
    return;
  end if;

  -- The closed vocabulary MINUS waived. Stated positively so a future value
  -- added to the CHECK does not silently become practitioner-recordable.
  if p_method is null or p_method not in (
       'paid_cash', 'paid_e_transfer', 'paid_other_external', 'still_owes'
     ) then
    if p_method = 'waived' then
      return query select 'owner_only'::text, null::uuid, null::timestamptz;
      return;
    end if;
    return query select 'invalid_input'::text, null::uuid, null::timestamptz;
    return;
  end if;

  if p_amount_cents is null
     or p_amount_cents < 0
     or p_amount_cents > 200000
     or (v_note is not null and length(v_note) > 500) then
    return query select 'invalid_input'::text, null::uuid, null::timestamptz;
    return;
  end if;

  -- THE TRUST BOUNDARY. Raises for a non-member / inactive caller with a
  -- mapped safe message, exactly as every other 0167/0181 command does.
  v_practitioner := public.session_actor_practitioner(p_studio_id);

  -- The appointment is scoped by BOTH id and studio, so a forged or borrowed
  -- id from another tenant is NOT FOUND rather than FORBIDDEN: the caller
  -- learns nothing about whether it exists elsewhere.
  select a.status into v_status
    from public.appointments a
   where a.id = p_appointment_id
     and a.studio_id = p_studio_id;
  if not found then
    return query select 'not_found'::text, null::uuid, null::timestamptz;
    return;
  end if;

  -- A disposition is a fact about a visit that HAPPENED. Recording one against
  -- a cancelled or no-show appointment would put revenue against a visit the
  -- calendar says did not occur; those have their own fee reasons in the
  -- charge ledger.
  if v_status is distinct from 'completed' then
    return query select 'not_completed'::text, null::uuid, null::timestamptz;
    return;
  end if;

  -- SERIALIZE THE DECISION BEFORE LOOKING AT IT. Taken AFTER authority is
  -- proven, so an unauthenticated or cross-tenant caller can never make the
  -- database take a lock on its behalf. Released automatically at commit.
  perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(p_appointment_id));

  -- CHOOSING A NON-CARD OUTCOME RETIRES A PREPARED-BUT-UNCHARGED ATTEMPT.
  -- Same lock, same transaction, and BEFORE card money is assessed — so the
  -- practitioner does not have to find a cancellation screen that does not
  -- exist before she can write down that the client paid cash. Only `ready` is
  -- touched; pending_stripe and succeeded are left alone and still refuse
  -- below.
  perform public.retire_ready_card_attempts(
    p_studio_id, p_appointment_id, v_practitioner);

  -- CARD TRUTH OUTRANKS ATTESTATION, IN BOTH TIME DIRECTIONS. Evaluated under
  -- the lock and from PERSISTED state.
  if public.appointment_has_live_card_money(p_studio_id, p_appointment_id, coalesce(p_livemode, true)) then
    return query select 'card_payment_exists'::text, null::uuid, null::timestamptz;
    return;
  end if;

  insert into public.appointment_settlements (
    studio_id, appointment_id, method, amount_cents,
    quoted_amount_cents, recorded_by_practitioner_id, note
  )
  values (
    p_studio_id, p_appointment_id, p_method, p_amount_cents,
    -- DERIVED, never supplied. See appointment_quoted_amount_cents.
    public.appointment_quoted_amount_cents(p_studio_id, p_appointment_id),
    v_practitioner, v_note
  )
  on conflict (studio_id, appointment_id) where superseded_at is null
  do nothing
  returning id, appointment_settlements.recorded_at into v_id, v_at;

  if v_id is not null then
    return query select 'recorded'::text, v_id, v_at;
    return;
  end if;

  -- The insert conflicted, so a live settlement already exists. REPLAY AND
  -- DOUBLE-SUBMIT LAND HERE: the caller gets the SAME business result and the
  -- id of the record that actually holds the truth, never a second row and
  -- never a raised unique violation.
  select t.id, t.recorded_at into v_id, v_at
    from public.appointment_settlements t
   where t.studio_id = p_studio_id
     and t.appointment_id = p_appointment_id
     and t.superseded_at is null
   limit 1;

  return query select 'already_settled'::text, v_id, v_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 2 — WAIVE THE FEE (OWNER ONLY)
-- ---------------------------------------------------------------------------
-- A waiver is not a payment method. It is the practice deciding it is no
-- longer entitled to money it was owed, which is an ownership decision, so the
-- gate is public.is_studio_owner — the SAME helper the refund action's
-- owner gate uses in application code, and the same one 0185 uses.
--
-- A non-owner receives a DETERMINISTIC 'not_owner' result code, not an
-- exception: deterministic, testable, and it leaks nothing about the row.
create or replace function public.waive_appointment_fee(
  p_studio_id           uuid,
  p_appointment_id      uuid,
  p_amount_cents        integer,
  p_note                text,
  p_livemode            boolean
)
returns table (result text, settlement_id uuid, recorded_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_practitioner uuid;
  v_note         text := nullif(btrim(coalesce(p_note, '')), '');
  v_status       text;
  v_id           uuid;
  v_at           timestamptz;
begin
  if p_studio_id is null or p_appointment_id is null then
    return query select 'invalid_input'::text, null::uuid, null::timestamptz;
    return;
  end if;

  if p_amount_cents is null
     or p_amount_cents < 0
     or p_amount_cents > 200000
     or (v_note is not null and length(v_note) > 500) then
    return query select 'invalid_input'::text, null::uuid, null::timestamptz;
    return;
  end if;

  -- Membership first (so a stranger cannot distinguish "not a member" from
  -- "not an owner" by timing), then ownership.
  v_practitioner := public.session_actor_practitioner(p_studio_id);

  if not public.is_studio_owner(p_studio_id) then
    return query select 'not_owner'::text, null::uuid, null::timestamptz;
    return;
  end if;

  select a.status into v_status
    from public.appointments a
   where a.id = p_appointment_id
     and a.studio_id = p_studio_id;
  if not found then
    return query select 'not_found'::text, null::uuid, null::timestamptz;
    return;
  end if;

  if v_status is distinct from 'completed' then
    return query select 'not_completed'::text, null::uuid, null::timestamptz;
    return;
  end if;

  perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(p_appointment_id));

  -- A waiver is equally a decision not to use the prepared attempt.
  perform public.retire_ready_card_attempts(
    p_studio_id, p_appointment_id, v_practitioner);

  if public.appointment_has_live_card_money(p_studio_id, p_appointment_id, coalesce(p_livemode, true)) then
    -- Money Hone actually holds cannot be waived away. Refund it first; the
    -- refund is the reversal instrument, and it lives in the card ledger.
    return query select 'card_payment_exists'::text, null::uuid, null::timestamptz;
    return;
  end if;

  insert into public.appointment_settlements (
    studio_id, appointment_id, method, amount_cents,
    quoted_amount_cents, recorded_by_practitioner_id, note
  )
  values (
    p_studio_id, p_appointment_id, 'waived', p_amount_cents,
    public.appointment_quoted_amount_cents(p_studio_id, p_appointment_id),
    v_practitioner, v_note
  )
  on conflict (studio_id, appointment_id) where superseded_at is null
  do nothing
  returning id, appointment_settlements.recorded_at into v_id, v_at;

  if v_id is not null then
    return query select 'recorded'::text, v_id, v_at;
    return;
  end if;

  select t.id, t.recorded_at into v_id, v_at
    from public.appointment_settlements t
   where t.studio_id = p_studio_id
     and t.appointment_id = p_appointment_id
     and t.superseded_at is null
   limit 1;

  return query select 'already_settled'::text, v_id, v_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 3 — CORRECT A SETTLEMENT BY SUPERSEDING IT (OWNER ONLY)
-- ---------------------------------------------------------------------------
-- ONE TRANSACTION, ONE LOCK, TWO WRITES, NEVER A WINDOW.
--
-- Retiring the old row and inserting its replacement happen together. Doing
-- them as two calls would expose an interval in which the appointment has
-- ZERO live settlements (a reader sees UNKNOWN for a visit that is actually
-- settled) or, on the reverse ordering, TWO (which the single-truth index
-- refuses, leaving the correction half-applied).
--
-- OWNER ONLY, INCLUDING THE PRACTITIONER'S OWN RECORD. Deliberate: the value
-- of an attestation is that the person who made it cannot quietly revise it.
-- Correction is an ownership act.
--
-- p_expected_settlement_id IS AN OPTIMISTIC TARGET, NOT A SELECTOR. The owner
-- corrects the record she was LOOKING AT. If it has already been superseded by
-- someone else, this returns 'stale_target' rather than silently correcting
-- whatever happens to be live now.
create or replace function public.supersede_appointment_settlement(
  p_studio_id              uuid,
  p_expected_settlement_id uuid,
  p_method                 text,
  p_amount_cents           integer,
  p_reason                 text,
  p_note                   text,
  p_livemode               boolean
)
returns table (
  result text,
  settlement_id uuid,
  superseded_settlement_id uuid,
  recorded_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_practitioner   uuid;
  v_reason         text := nullif(btrim(coalesce(p_reason, '')), '');
  v_note           text := nullif(btrim(coalesce(p_note, '')), '');
  v_old            public.appointment_settlements%rowtype;
  v_appointment_id uuid;
  v_id             uuid;
  v_at             timestamptz;
begin
  if p_studio_id is null or p_expected_settlement_id is null then
    return query select 'invalid_input'::text, null::uuid, null::uuid, null::timestamptz;
    return;
  end if;

  -- The full vocabulary is available to a correction, waived included: the
  -- command is already owner-gated, which is the authority a waiver requires.
  if p_method is null or p_method not in (
       'paid_cash', 'paid_e_transfer', 'paid_other_external', 'waived', 'still_owes'
     ) then
    return query select 'invalid_input'::text, null::uuid, null::uuid, null::timestamptz;
    return;
  end if;

  -- A CORRECTION MUST SAY WHY. Enforced here as well as by CHECK so the caller
  -- gets a closed result code instead of a constraint violation.
  if v_reason is null
     or length(v_reason) > 500
     or p_amount_cents is null
     or p_amount_cents < 0
     or p_amount_cents > 200000
     or (v_note is not null and length(v_note) > 500) then
    return query select 'invalid_input'::text, null::uuid, null::uuid, null::timestamptz;
    return;
  end if;

  v_practitioner := public.session_actor_practitioner(p_studio_id);

  if not public.is_studio_owner(p_studio_id) then
    return query select 'not_owner'::text, null::uuid, null::uuid, null::timestamptz;
    return;
  end if;

  -- Scoped by BOTH id and studio: a cross-studio settlement id is NOT FOUND.
  -- Read WITHOUT a row lock first, purely to learn the appointment the lock
  -- key is derived from. Advisory first, row second — the global ordering.
  select t.appointment_id into v_appointment_id
    from public.appointment_settlements t
   where t.id = p_expected_settlement_id
     and t.studio_id = p_studio_id;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::timestamptz;
    return;
  end if;

  perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(v_appointment_id));

  select * into v_old
    from public.appointment_settlements t
   where t.id = p_expected_settlement_id
     and t.studio_id = p_studio_id
   for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::timestamptz;
    return;
  end if;

  -- Somebody else corrected this record between the owner opening the screen
  -- and submitting. Report it; do not silently correct a different record.
  if v_old.superseded_at is not null then
    return query select 'stale_target'::text, null::uuid, v_old.id, null::timestamptz;
    return;
  end if;

  -- A correction cannot conjure external money for a visit Hone was actually
  -- paid for. Refund the card charge first if the card fact is the wrong one;
  -- the card fact is never mutated from here.
  perform public.retire_ready_card_attempts(
    p_studio_id, v_old.appointment_id, v_practitioner);

  if p_method <> 'still_owes'
     and public.appointment_has_live_card_money(p_studio_id, v_old.appointment_id, coalesce(p_livemode, true)) then
    return query select 'card_payment_exists'::text, null::uuid, v_old.id, null::timestamptz;
    return;
  end if;

  -- RETIRE FIRST, THEN INSERT. The single-truth partial unique index counts
  -- LIVE rows and is checked immediately, so inserting the replacement while
  -- the original is still live raises a duplicate-key error every time. The
  -- successor id is therefore minted up front, the original is retired
  -- pointing AT it, and the replacement is inserted with that id — legal only
  -- because appointment_settlements_superseded_by_fk is deferred to commit.
  v_id := gen_random_uuid();

  update public.appointment_settlements t
     set superseded_at = now(),
         superseded_by_settlement_id = v_id
   where t.id = v_old.id
     and t.superseded_at is null;

  insert into public.appointment_settlements (
    id, studio_id, appointment_id, method, amount_cents,
    quoted_amount_cents, recorded_by_practitioner_id, note,
    supersedes_id, supersede_reason
  )
  values (
    v_id, p_studio_id, v_old.appointment_id, p_method, p_amount_cents,
    public.appointment_quoted_amount_cents(p_studio_id, v_old.appointment_id),
    v_practitioner, v_note,
    v_old.id, v_reason
  )
  returning appointment_settlements.recorded_at into v_at;

  return query select 'corrected'::text, v_id, v_old.id, v_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- THE OTHER DIRECTION — CARD CHARGING MUST RESPECT AN ATTESTATION
-- ---------------------------------------------------------------------------
-- REPLACES public.claim_session_payment_charge_attempt (0075 -> 0083 -> 0101).
--
-- THE SIGNATURE IS UNCHANGED, so `create or replace` preserves the existing
-- ACL; the grants are nonetheless restated at the foot of this file so the
-- final state is ASSERTED rather than inherited.
--
-- THE BODY IS THE 0101 BODY WITH EXACTLY ONE ADDITION, placed before any row
-- lock is taken:
--
--   1. resolve the appointment for this attempt WITHOUT locking;
--   2. take the shared advisory key;
--   3. refuse if a live blocking attestation exists;
--
-- then the original 0101 logic runs unchanged.
--
-- AN ATTEMPT WITH NO RESOLVABLE APPOINTMENT NEEDS NO EXCLUSION and takes no
-- lock: settlement is appointment-anchored, so such an attempt has no
-- counterpart it could collide with. That closes the case by structure rather
-- than by exception.
--
-- BACKWARD COMPATIBLE WITH THE CURRENTLY DEPLOYED APPLICATION. Against an
-- empty appointment_settlements the addition is an uncontended lock plus a
-- lookup that finds nothing, so applying 0187 before the runtime ships is a
-- no-op for the card path. That is what makes migration-first ordering safe.
create or replace function public.claim_session_payment_charge_attempt(
  p_attempt_id        uuid,
  p_practitioner_id   uuid,
  p_idempotency_key   text
) returns table (
  result                              text,
  attempt_id                          uuid,
  studio_id                           uuid,
  client_id                           uuid,
  session_id                          uuid,
  appointment_id                      uuid,
  charge_reason                       text,
  amount_cents                        integer,
  currency                            text,
  client_payment_method_id            uuid,
  card_authorization_signature_id     uuid,
  stripe_account_id                   text,
  stripe_customer_id                  text,
  stripe_payment_method_id            text,
  stripe_payment_intent_id            text,
  stripe_idempotency_key              text,
  status_before_claim                 text,
  updated_at                          timestamptz
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.payment_charge_attempts%rowtype;
  v_role text;
  v_appointment_id uuid;
begin
  if p_attempt_id is null then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid,
      null::uuid, null::uuid, null::text, null::integer, null::text, null::uuid,
      null::uuid, null::text, null::text, null::text, null::text, null::text,
      null::text, null::timestamptz;
    return;
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid,
      null::uuid, null::uuid, null::text, null::integer, null::text, null::uuid,
      null::uuid, null::text, null::text, null::text, null::text, null::text,
      null::text, null::timestamptz;
    return;
  end if;

  -- 0187. NON-LOCKING resolution of the appointment, so the advisory key can be
  -- computed BEFORE the `for update` below. Advisory first, row second.
  select coalesce(a.appointment_id, s.appointment_id)
    into v_appointment_id
    from public.payment_charge_attempts a
    left join public.sessions s
      on s.id = a.session_id
     and s.studio_id = a.studio_id
   where a.id = p_attempt_id;

  if v_appointment_id is not null then
    perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(v_appointment_id));

    -- 0187. THE OTHER HALF OF THE MUTUAL EXCLUSION. A visit already recorded as
    -- paid in cash, by e-transfer, another way, or waived must not also be
    -- charged. `still_owes` deliberately does not block — see
    -- appointment_has_blocking_settlement.
    if public.appointment_has_blocking_settlement(
         (select a.studio_id from public.payment_charge_attempts a where a.id = p_attempt_id),
         v_appointment_id) then
      return query select 'settled_externally'::text, p_attempt_id, null::uuid,
        null::uuid, null::uuid, v_appointment_id, null::text, null::integer,
        null::text, null::uuid, null::uuid, null::text, null::text, null::text,
        null::text, null::text, null::text, null::timestamptz;
      return;
    end if;
  end if;

  select * into v_row
    from public.payment_charge_attempts pca
   where pca.id = p_attempt_id
   for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid,
      null::uuid, null::uuid, null::text, null::integer, null::text, null::uuid,
      null::uuid, null::text, null::text, null::text, null::text, null::text,
      null::text, null::timestamptz;
    return;
  end if;
  -- Reason guard (0083): the three canonical charge reasons. Any
  -- other reason refuses; fee rows claim through the same audited
  -- path as session payments.
  if v_row.charge_reason not in ('session_payment', 'no_show_fee', 'late_cancellation_fee') then
    return query select 'not_ready'::text, v_row.id, v_row.studio_id,
      v_row.client_id, v_row.session_id, v_row.appointment_id,
      v_row.charge_reason, v_row.amount_cents, v_row.currency,
      v_row.client_payment_method_id, v_row.card_authorization_signature_id,
      v_row.stripe_account_id, v_row.stripe_customer_id,
      v_row.stripe_payment_method_id, v_row.stripe_payment_intent_id,
      v_row.stripe_idempotency_key, v_row.status, v_row.updated_at;
    return;
  end if;

  -- PR #322: the live-mode refusal (`if v_row.stripe_livemode <> false then
  -- return not_ready`) that was here (0075/0083) is REMOVED so the RPC can
  -- claim live rows once they exist. Live charging is still blocked at runtime
  -- (executor live_mode_blocked + prepare-insert writes livemode=false) and env
  -- (STRIPE_ALLOW_LIVE_MODE unset). No live row is created until PR #323/#324.

  -- Practitioner must be active in the row's studio. The application
  -- already verifies the session practitioner belongs to a studio,
  -- but we re-check here so the RPC is safe even if a future caller
  -- forgets to pre-check.
  select pr.role into v_role
    from public.practitioners pr
   where pr.id = p_practitioner_id
     and pr.studio_id = v_row.studio_id
     and pr.active = true;
  if not found then
    return query select 'not_authorized'::text, v_row.id, v_row.studio_id,
      v_row.client_id, v_row.session_id, v_row.appointment_id,
      v_row.charge_reason, v_row.amount_cents, v_row.currency,
      v_row.client_payment_method_id, v_row.card_authorization_signature_id,
      v_row.stripe_account_id, v_row.stripe_customer_id,
      v_row.stripe_payment_method_id, v_row.stripe_payment_intent_id,
      v_row.stripe_idempotency_key, v_row.status, v_row.updated_at;
    return;
  end if;

  -- Already-succeeded short circuit. The caller surfaces the success
  -- without touching Stripe.
  if v_row.status = 'succeeded' then
    return query select 'already_succeeded'::text, v_row.id, v_row.studio_id,
      v_row.client_id, v_row.session_id, v_row.appointment_id,
      v_row.charge_reason, v_row.amount_cents, v_row.currency,
      v_row.client_payment_method_id, v_row.card_authorization_signature_id,
      v_row.stripe_account_id, v_row.stripe_customer_id,
      v_row.stripe_payment_method_id, v_row.stripe_payment_intent_id,
      v_row.stripe_idempotency_key, v_row.status, v_row.updated_at;
    return;
  end if;

  -- Already-pending: caller runs the reconciliation path. We return
  -- the existing PI id + idempotency key so the action does not need
  -- a separate SELECT.
  if v_row.status = 'pending_stripe' then
    return query select 'already_pending'::text, v_row.id, v_row.studio_id,
      v_row.client_id, v_row.session_id, v_row.appointment_id,
      v_row.charge_reason, v_row.amount_cents, v_row.currency,
      v_row.client_payment_method_id, v_row.card_authorization_signature_id,
      v_row.stripe_account_id, v_row.stripe_customer_id,
      v_row.stripe_payment_method_id, v_row.stripe_payment_intent_id,
      v_row.stripe_idempotency_key, v_row.status, v_row.updated_at;
    return;
  end if;

  -- Any other non-'ready' status (blocked / cancelled / failed) is
  -- not retryable in this PR. Failed retries are a future design.
  if v_row.status <> 'ready' then
    return query select 'not_ready'::text, v_row.id, v_row.studio_id,
      v_row.client_id, v_row.session_id, v_row.appointment_id,
      v_row.charge_reason, v_row.amount_cents, v_row.currency,
      v_row.client_payment_method_id, v_row.card_authorization_signature_id,
      v_row.stripe_account_id, v_row.stripe_customer_id,
      v_row.stripe_payment_method_id, v_row.stripe_payment_intent_id,
      v_row.stripe_idempotency_key, v_row.status, v_row.updated_at;
    return;
  end if;

  -- 'ready' with a non-null stripe_payment_intent_id should be
  -- structurally impossible (we never set the PI id without also
  -- transitioning to pending_stripe), but if it ever happens we
  -- refuse rather than overwrite.
  if v_row.stripe_payment_intent_id is not null then
    return query select 'not_ready'::text, v_row.id, v_row.studio_id,
      v_row.client_id, v_row.session_id, v_row.appointment_id,
      v_row.charge_reason, v_row.amount_cents, v_row.currency,
      v_row.client_payment_method_id, v_row.card_authorization_signature_id,
      v_row.stripe_account_id, v_row.stripe_customer_id,
      v_row.stripe_payment_method_id, v_row.stripe_payment_intent_id,
      v_row.stripe_idempotency_key, v_row.status, v_row.updated_at;
    return;
  end if;

  -- Claim. The conditional UPDATE on status='ready' is the second
  -- (belt + braces) protection on top of the row lock above; the
  -- partial unique on stripe_idempotency_key adds a third in case
  -- two simultaneous claims somehow both pass the FOR UPDATE.
  update public.payment_charge_attempts
     set status                 = 'pending_stripe',
         stripe_idempotency_key = p_idempotency_key,
         updated_at             = now()
   where id     = p_attempt_id
     and status = 'ready';

  -- Re-read the row so we return the updated_at the caller can use
  -- for the "recent claim" reconciliation window.
  select * into v_row
    from public.payment_charge_attempts pca
   where pca.id = p_attempt_id;

  return query select 'claimed'::text, v_row.id, v_row.studio_id,
    v_row.client_id, v_row.session_id, v_row.appointment_id,
    v_row.charge_reason, v_row.amount_cents, v_row.currency,
    v_row.client_payment_method_id, v_row.card_authorization_signature_id,
    v_row.stripe_account_id, v_row.stripe_customer_id,
    v_row.stripe_payment_method_id, v_row.stripe_payment_intent_id,
    v_row.stripe_idempotency_key, 'ready'::text, v_row.updated_at;
end;
$$;

-- ===========================================================================
-- PRIVILEGES
-- ===========================================================================
-- REVOKE ALL, THEN GRANT BACK EXACTLY WHAT IS INTENDED.
--
-- Never a by-name denylist. 0183 stated its contract as an allowlist and
-- enforced it as `revoke delete, truncate`, so Supabase's ALTER DEFAULT
-- PRIVILEGES left SELECT, INSERT, REFERENCES, TRIGGER, MAINTAIN and UPDATE in
-- place — and MAINTAIN is a PostgreSQL 17 privilege no list written for 0183
-- could have contained. 0184 repaired it with exactly this shape. Same root
-- cause as 0129 (anon missed) and 0164 (service_role missed).
revoke all on public.appointment_settlements from public;
revoke all on public.appointment_settlements from anon;
revoke all on public.appointment_settlements from authenticated;
revoke all on public.appointment_settlements from service_role;

-- SELECT AND NOTHING ELSE, to authenticated only, and still filtered by the
-- member RLS policy above. No role anywhere holds INSERT, UPDATE, DELETE or
-- TRUNCATE on this table: every write in the system goes through one of the
-- three SECURITY DEFINER commands, so "who may write financial truth" is
-- answered by three function bodies rather than by a table grant.
grant select on public.appointment_settlements to authenticated;

-- ---------------------------------------------------------------------------
-- COMMANDS. Revoke from ALL FOUR by name, then grant to exactly one.
-- ---------------------------------------------------------------------------
-- `authenticated`, not `service_role`: these commands re-derive authority from
-- auth.uid() and would be meaningless called by a role that has none. That is
-- the opposite of 0185's choice and deliberately so — its commands serve a
-- PUBLIC visitor with no session, these serve a signed-in practitioner.
revoke execute on function public.record_appointment_settlement(uuid, uuid, text, integer, text, boolean) from public;
revoke execute on function public.record_appointment_settlement(uuid, uuid, text, integer, text, boolean) from anon;
revoke execute on function public.record_appointment_settlement(uuid, uuid, text, integer, text, boolean) from authenticated;
revoke execute on function public.record_appointment_settlement(uuid, uuid, text, integer, text, boolean) from service_role;
grant execute on function public.record_appointment_settlement(uuid, uuid, text, integer, text, boolean) to authenticated;

revoke execute on function public.waive_appointment_fee(uuid, uuid, integer, text, boolean) from public;
revoke execute on function public.waive_appointment_fee(uuid, uuid, integer, text, boolean) from anon;
revoke execute on function public.waive_appointment_fee(uuid, uuid, integer, text, boolean) from authenticated;
revoke execute on function public.waive_appointment_fee(uuid, uuid, integer, text, boolean) from service_role;
grant execute on function public.waive_appointment_fee(uuid, uuid, integer, text, boolean) to authenticated;

revoke execute on function public.supersede_appointment_settlement(uuid, uuid, text, integer, text, text, boolean) from public;
revoke execute on function public.supersede_appointment_settlement(uuid, uuid, text, integer, text, text, boolean) from anon;
revoke execute on function public.supersede_appointment_settlement(uuid, uuid, text, integer, text, text, boolean) from authenticated;
revoke execute on function public.supersede_appointment_settlement(uuid, uuid, text, integer, text, text, boolean) from service_role;
grant execute on function public.supersede_appointment_settlement(uuid, uuid, text, integer, text, text, boolean) to authenticated;

-- INTERNAL HELPERS. Called only from inside the commands above (and, for the
-- lock key, from the claim command). Nobody calls them directly, so nobody
-- holds EXECUTE.
revoke all privileges on function public.appointment_settlement_lock_key(uuid) from public;
revoke all privileges on function public.appointment_settlement_lock_key(uuid) from anon;
revoke all privileges on function public.appointment_settlement_lock_key(uuid) from authenticated;
revoke all privileges on function public.appointment_settlement_lock_key(uuid) from service_role;

revoke all privileges on function public.appointment_has_live_card_money(uuid, uuid, boolean) from public;
revoke all privileges on function public.appointment_has_live_card_money(uuid, uuid, boolean) from anon;
revoke all privileges on function public.appointment_has_live_card_money(uuid, uuid, boolean) from authenticated;
revoke all privileges on function public.appointment_has_live_card_money(uuid, uuid, boolean) from service_role;

-- THE TWO DERIVATION HELPERS. Called only from inside the settlement commands
-- above. They are NOT new mutation surfaces: neither is granted to anybody, so
-- `authenticated` cannot invoke the retirement directly (which would be a way
-- to cancel a prepared charge with no settlement recorded), and neither can it
-- probe another studio's prices through the snapshot helper.
revoke all privileges on function public.appointment_quoted_amount_cents(uuid, uuid) from public;
revoke all privileges on function public.appointment_quoted_amount_cents(uuid, uuid) from anon;
revoke all privileges on function public.appointment_quoted_amount_cents(uuid, uuid) from authenticated;
revoke all privileges on function public.appointment_quoted_amount_cents(uuid, uuid) from service_role;

revoke all privileges on function public.retire_ready_card_attempts(uuid, uuid, uuid) from public;
revoke all privileges on function public.retire_ready_card_attempts(uuid, uuid, uuid) from anon;
revoke all privileges on function public.retire_ready_card_attempts(uuid, uuid, uuid) from authenticated;
revoke all privileges on function public.retire_ready_card_attempts(uuid, uuid, uuid) from service_role;

revoke all privileges on function public.appointment_has_blocking_settlement(uuid, uuid) from public;
revoke all privileges on function public.appointment_has_blocking_settlement(uuid, uuid) from anon;
revoke all privileges on function public.appointment_has_blocking_settlement(uuid, uuid) from authenticated;
revoke all privileges on function public.appointment_has_blocking_settlement(uuid, uuid) from service_role;

-- TRIGGER FUNCTIONS. Fired by the table, never invoked. Same 0184 shape.
revoke all privileges on function public.appointment_settlements_server_timestamps() from public;
revoke all privileges on function public.appointment_settlements_server_timestamps() from anon;
revoke all privileges on function public.appointment_settlements_server_timestamps() from authenticated;
revoke all privileges on function public.appointment_settlements_server_timestamps() from service_role;

revoke all privileges on function public.appointment_settlements_append_only() from public;
revoke all privileges on function public.appointment_settlements_append_only() from anon;
revoke all privileges on function public.appointment_settlements_append_only() from authenticated;
revoke all privileges on function public.appointment_settlements_append_only() from service_role;

revoke all privileges on function public.appointment_settlements_no_delete() from public;
revoke all privileges on function public.appointment_settlements_no_delete() from anon;
revoke all privileges on function public.appointment_settlements_no_delete() from authenticated;
revoke all privileges on function public.appointment_settlements_no_delete() from service_role;

-- THE REPLACED FUNCTION. `create or replace` preserves the existing ACL, so
-- these lines change nothing today. They are here so the FINAL privilege state
-- of a function this migration rewrote is ASSERTED by this file rather than
-- inherited from 0101 and assumed.
revoke execute on function public.claim_session_payment_charge_attempt(uuid, uuid, text) from public;
revoke execute on function public.claim_session_payment_charge_attempt(uuid, uuid, text) from anon;
revoke execute on function public.claim_session_payment_charge_attempt(uuid, uuid, text) from authenticated;
grant execute on function public.claim_session_payment_charge_attempt(uuid, uuid, text) to service_role;

-- ===========================================================================
-- DOCUMENTATION
-- ===========================================================================
comment on table public.appointment_settlements is
  'PAY-SETTLE / 0187. Practitioner-ATTESTED disposition of a completed appointment: paid_cash, paid_e_transfer, paid_other_external, waived, still_owes. This is NOT a payment ledger and NOT a Stripe record. Money Hone verified lives in payment_charge_attempts and nowhere else; there is deliberately no card/hone method here, so an attestation can never be read, summed or receipted as a Stripe charge. Append-only: rows are never updated into a different outcome and never deleted; a correction inserts a new row and retires the old one via supersedes_id/superseded_at. Exactly one live row per appointment, enforced by a partial unique index that is simultaneously the double-collection, replay and correction law. UNKNOWN is the ABSENCE of a live row and is never a value: every historical appointment has none, and this migration backfills nothing.';

comment on column public.appointment_settlements.method is
  'Closed vocabulary: paid_cash | paid_e_transfer | paid_other_external | waived | still_owes. THERE IS NO card OR hone MEMBER, and adding one would collapse Stripe-verified truth into practitioner attestation. Pinned by a positive allowlist in tests/migrations/0187-appointment-settlement.test.ts.';

comment on column public.appointment_settlements.amount_cents is
  'What the amount MEANS is fixed by method: paid_* is the amount COLLECTED externally, waived is the amount FORGIVEN, still_owes is the amount OUTSTANDING. One column rather than three nullable ones so the row cannot be internally inconsistent. Same 0..200000 ceiling as payment_charge_attempts.amount_cents.';

comment on column public.appointment_settlements.quoted_amount_cents is
  'The authoritative service price AT THE TIME OF RECORDING, DERIVED BY THE DATABASE via appointment_quoted_amount_cents and never accepted from a caller: the settlement commands are granted to authenticated, so a parameter here could be forged straight through PostgREST into the column FIN-01A divides by. Snapshotted because the menu price is mutable: without it, repricing a service silently rewrites what past visits were worth and FIN-01A drifts away from what Checkout displayed. Null when the price could not be resolved, which is a fact worth keeping rather than a zero worth inventing.';

comment on column public.appointment_settlements.recorded_at is
  'Server time, forced by a BEFORE INSERT trigger rather than defaulted, because a caller able to supply it could date a cash record into a closed financial period.';

comment on column public.appointment_settlements.supersedes_id is
  'Set only on a CORRECTING row, and then supersede_reason is required. The corrected row keeps its original method, amount, actor and timestamp forever; correction is an insert, never an update.';

comment on function public.appointment_settlement_lock_key(uuid) is
  'The ONE appointment-scoped advisory-lock key shared by record_appointment_settlement, waive_appointment_fee, supersede_appointment_settlement and claim_session_payment_charge_attempt. Making settlement and card charging mutually exclusive requires all four to serialize on the SAME key; defining it once here is what makes that checkable rather than a convention. Advisory rather than FOR UPDATE because a first settlement has no row to lock, and FOR UPDATE over an empty window locks nothing (the false guarantee 0181 documented). Lock ordering is global: advisory first, row second.';

comment on function public.appointment_has_live_card_money(uuid, uuid, boolean) is
  'True when this appointment carries card money Hone is holding: a session_payment attempt that is ready, pending_stripe, or succeeded and not fully refunded. Livemode is a DEPLOYMENT fact the database cannot know, so the caller passes it — but asymmetrically: livemode=true money ALWAYS blocks whatever the caller claims, and test-mode money blocks only when the caller says it is itself in test mode. A caller that lies can only make the check stricter for itself; it can never unblock real money. After a FULL refund this is false, because the money went back and recording an external payment afterwards is then true.';

comment on function public.appointment_has_blocking_settlement(uuid, uuid) is
  'True when a live attestation forbids charging a card for this appointment: paid_cash, paid_e_transfer, paid_other_external or waived. still_owes deliberately does NOT block, because "still owes" followed by "paid by card" is the ordinary progression of a debt; the still_owes row is not retired by the later charge, and the authoritative disposition is derived by ranking Hone-verified money above attestation.';

comment on function public.appointment_quoted_amount_cents(uuid, uuid) is
  'The service-value snapshot for an appointment, DERIVED HERE so no caller can choose it. Reproduces resolveAuthoritativeSessionPaymentAmount step for step: current client_pricing matched by normalized service NAME beats the menu price; only rows effective on or before the STUDIO-LOCAL date qualify; newest effective_from wins; equally-current rows that disagree resolve to NULL rather than by row order; a positive menu price otherwise wins; an explicit menu 0 is an authoritative zero; a missing service, NULL price or ambiguity is NULL. A zero or negative CUSTOM price is read as no custom price recorded, never as charge nothing. Pinned against the TypeScript resolver by a parity matrix. Granted to nobody.';

comment on function public.retire_ready_card_attempts(uuid, uuid, uuid) is
  'Retires session_payment attempts whose status is EXACTLY ready for one appointment, through the existing 0073 cancellation lifecycle (cancelled + cancelled_at + cancelled_by_practitioner_id + cancelled_reason). No new status is invented, no row is deleted, and no amount, card, signature or Stripe column is touched. Called by the settlement commands under the shared appointment advisory lock, in the same transaction, BEFORE card money is assessed: choosing cash / e-transfer / another way / still-owes / a waiver IS the decision not to use the prepared charge, and there is no other cancellation path for a session-payment attempt in the product. pending_stripe (a charge in flight), succeeded (money moved) and every terminal status are never retired and continue to refuse settlement. Granted to nobody: it is not a standalone way to cancel a prepared charge.';

comment on function public.record_appointment_settlement(uuid, uuid, text, integer, text, boolean) is
  'Records an INITIAL non-card disposition for a completed appointment. Authority is the EXISTING Checkout boundary re-derived in SQL: session_actor_practitioner(p_studio_id), i.e. an active practitioner of the NAMED studio, any role. Refuses waived unconditionally (owner_only) because a waiver changes entitlement, not payment method. Serializes on the shared appointment advisory key and refuses when Hone already holds card money for the visit. Replay and double-submit return already_settled with the id of the record that actually holds the truth, never a second row. Returns recorded | already_settled | card_payment_exists | not_completed | not_found | owner_only | invalid_input. authenticated only.';

comment on function public.waive_appointment_fee(uuid, uuid, integer, text, boolean) is
  'Records a WAIVED fee. OWNER ONLY, enforced here by is_studio_owner: a waiver changes what the practice is entitled to rather than how the client paid, so it is an ownership decision. A non-owner receives a deterministic not_owner result code, never an exception. Money Hone actually holds cannot be waived away (card_payment_exists) — a refund is the reversal instrument and it lives in the card ledger. Returns recorded | already_settled | card_payment_exists | not_completed | not_found | not_owner | invalid_input. authenticated only.';

comment on function public.supersede_appointment_settlement(uuid, uuid, text, integer, text, text, boolean) is
  'Corrects a settlement by SUPERSEDING it: retires the target and inserts its replacement in ONE transaction under ONE lock, so the appointment never has zero or two live settlements. OWNER ONLY, including over a practitioner''s own record — the value of an attestation is that its author cannot quietly revise it. supersede_reason is required. p_expected_settlement_id is an optimistic target: if it was already superseded the call returns stale_target rather than correcting whatever happens to be live now. Returns corrected | stale_target | card_payment_exists | not_found | not_owner | invalid_input. authenticated only.';

comment on function public.claim_session_payment_charge_attempt(uuid, uuid, text) is
  'Atomically claims a prepared charge attempt for Stripe execution. Carried forward from 0101 with ONE addition (0187): before any row lock it resolves the attempt''s appointment with a non-locking read, takes the SHARED appointment advisory key, and refuses with settled_externally when a live blocking attestation exists. That is the card-side half of the settlement mutual exclusion; the settlement side refuses when this side already holds money. An attempt with no resolvable appointment takes no lock and is unaffected, because settlement is appointment-anchored and has nothing to collide with. Lock ordering is advisory first, row second. service_role only.';

commit;
