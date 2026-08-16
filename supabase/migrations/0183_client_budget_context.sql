-- ===========================================================================
-- CLIENT BUDGET CONTEXT — 0183
-- ===========================================================================
--
-- THE DEFECT. Budget lived on `treatment_plans.budget_notes` (0034), so it was
-- scoped to a PLAN. A client with three plans therefore had three budget
-- answers and no rule saying which one was current. Every way of papering over
-- that in the application is a hidden synchronisation bug: "first active plan
-- wins" and "latest plan wins" both silently change the answer when an
-- unrelated plan is created or closed, and "write the value to every plan"
-- turns one edit into N writes that drift apart the moment one fails.
--
-- Budget is not plan data. It is CLIENT context the practitioner carries into
-- planning, which is why Chloe asked for it beside Consultation and Skin/Hair
-- rather than inside a plan.
--
-- THE RECORD. Exactly one row per client, enforced by making client_id the
-- PRIMARY KEY rather than by convention. "Which budget is current?" has no
-- answer to get wrong because there is only ever one row.
--
--   budget_level IS NULL      -> no broad level recorded (a legitimate state,
--                                NOT a fourth level)
--   budget_level IS NOT NULL  -> one of exactly three practitioner-selected
--                                values
--   budget_notes = ''         -> no free text recorded
--
-- The level and the free text are INDEPENDENT: either may be present without
-- the other. No CHECK couples them, because a practitioner who has only been
-- told "money is tight" should be able to record that without inventing prose,
-- and one who has written three sentences should not be forced to pick a chip.
--
-- WHAT THIS IS NOT. This is practitioner-authored planning documentation. It
-- is NOT an affordability score, a financial-risk rating, income, socioeconomic
-- status, or payment eligibility. Nothing in the application reads it to change
-- a price, a final charge, a discount, a Stripe object, booking availability,
-- appointment duration or treatment-plan cadence, and it is never exposed on
-- public booking, the client portal, email, SMS or receipts.
--
-- MUTABLE, NOT APPEND-ONLY. Deliberately unlike `client_clinical_notes`
-- (0126), which is an append-only dated clinical narrative where a correction
-- is a new superseding row. "The client's current budget" is a single fact
-- that gets corrected, not a history that accumulates, so it is overwritten in
-- place. That is also why budget does NOT become a third
-- `client_clinical_notes.kind`: it would inherit append-only revision
-- semantics that are wrong for it, and its `body` NOT NULL + non-empty CHECK
-- would make a level-only record impossible to store.
--
-- ADDITIVE ONLY. This migration creates one new table and nothing else. It
-- does NOT drop, null, rewrite or read `treatment_plans.budget_notes`; there
-- is NO backfill, by explicit product decision. A historical plan note is
-- plan-specific, may sit on a closed and obsolete plan, may disagree with
-- another plan's note, and was written under a different semantic contract —
-- copying it would silently promote historical plan context to current client
-- context. Legacy values stay where they are, stay readable read-only on the
-- plan, and stay in treatment_plans.csv. Zero existing business rows are
-- touched by this file.
--
-- Re-runnable: create-if-not-exists / drop-if-exists throughout.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- TABLE
-- ---------------------------------------------------------------------------
-- No surrogate id: client_id is the primary key, which is what makes "one
-- client = at most one CURRENT budget context" a structural guarantee instead
-- of an application rule.
--
-- studio_id is denormalized for RLS. TWO independent mechanisms keep it
-- honest, because either one alone has a gap:
--
--   1. The COMPOSITE FOREIGN KEY (client_id, studio_id) -> clients (id,
--      studio_id). This is the tenant-consistency pattern already used by
--      client_clinical_notes (0126), manual fees (0064), payment charge
--      attempts (0073) and appointments (0151). It makes a row whose
--      studio_id disagrees with its client's studio STRUCTURALLY
--      unrepresentable — not merely unreachable through the application.
--   2. The BEFORE INSERT OR UPDATE trigger below, which derives studio_id
--      from the parent client and overwrites whatever the caller sent, so
--      the composite FK is never even reached with a wrong value.
--
-- Mechanism 1 matters because a practitioner with memberships in TWO studios
-- satisfies is_studio_member() for both, so an RLS predicate alone cannot
-- stop them stranding a row under the wrong studio via direct DML. That is
-- not hypothetical here: dual membership is exactly the configuration that
-- produced the 0181 production incident.
create table if not exists public.client_budget_context (
  client_id uuid primary key,
  studio_id uuid not null
    references public.studios(id) on delete cascade,
  budget_level text,
  budget_notes text not null default '',
  -- ACTOR column. Studio-scoped by composite FK, following the 0179 actor-FK
  -- doctrine: "who did this" is attribution, and a simple FK to
  -- practitioners(id) would let a budget edit be attributed to a practitioner
  -- from ANOTHER studio. The nine simple practitioner FKs 0179 deliberately
  -- left behind are all non-actor (assignee, resource, recipient, domain
  -- subject, clinical performer provenance); this is not one of them.
  --
  -- ON DELETE RESTRICT, not SET NULL, for two reasons: it is what every other
  -- 0179-upgraded actor column does (attribution is durable, so removing the
  -- practitioner is refused rather than silently erasing who wrote it), and a
  -- composite SET NULL would try to null studio_id too, which is NOT NULL.
  --
  -- NOT NULL, deliberately. There is no legitimate unattributed writer of this
  -- table: it is created empty and never backfilled, service_role holds no
  -- privileges, clearing a budget is an UPDATE rather than a DELETE, and every
  -- application write runs through one practitioner-authenticated server
  -- action. Leaving it nullable would have left a hole the RLS policies below
  -- close anyway — under MATCH SIMPLE a NULL actor satisfies the composite FK
  -- unconditionally, so "erase who recorded this" would have been a legal
  -- write. NOT NULL removes the case instead of policing it.
  updated_by_practitioner_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_budget_context_client_studio_fkey
    foreign key (client_id, studio_id)
    references public.clients (id, studio_id) on delete cascade,
  constraint client_budget_context_updated_by_same_studio_fk
    foreign key (updated_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict
);

-- The canonical vocabulary. These three values are the SAME list as
-- lib/budget/levels.ts, and tests/db/client-budget-context.db.test.ts proves
-- the two cannot drift: a value the application would send but the constraint
-- would reject (or vice versa) fails the suite.
--
-- NULL is allowed and means "no broad level recorded". It is not a fourth
-- level and the application never renders it as a chip.
alter table public.client_budget_context
  drop constraint if exists client_budget_context_level_check;
alter table public.client_budget_context
  add constraint client_budget_context_level_check
  check (
    budget_level is null
    or budget_level in (
      'no_stated_limit',
      'somewhat_limited',
      'severely_limited'
    )
  );

-- Same 20000-character ceiling as client_personal_notes (0035), so the two
-- practitioner free-text surfaces do not have two different limits.
alter table public.client_budget_context
  drop constraint if exists client_budget_context_notes_length_check;
alter table public.client_budget_context
  add constraint client_budget_context_notes_length_check
  check (length(budget_notes) <= 20000);

-- RLS reads filter on studio_id; client_id is already the PK.
create index if not exists client_budget_context_studio_idx
  on public.client_budget_context (studio_id);

-- ---------------------------------------------------------------------------
-- TRIGGERS
-- ---------------------------------------------------------------------------
-- Reuses the existing public.set_updated_at() helper (0015).
drop trigger if exists client_budget_context_set_updated_at
  on public.client_budget_context;
create trigger client_budget_context_set_updated_at
  before update on public.client_budget_context
  for each row execute function public.set_updated_at();

-- Studio-id consistency. Same idea as client_personal_notes_set_studio_id
-- (0035), but fired on EVERY insert and update rather than only on `update of
-- client_id`. The narrower form leaves a real hole: an UPDATE that touches
-- only studio_id never fires it, so a practitioner who belongs to two studios
-- passes is_studio_member() on both sides and can strand a row under the
-- wrong studio. The composite FK above would reject that write anyway; this
-- trigger means it is silently corrected before it is ever attempted.
create or replace function public.client_budget_context_set_studio_id()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  select studio_id into new.studio_id
  from public.clients
  where id = new.client_id;

  if new.studio_id is null then
    raise exception 'client_budget_context.client_id % does not reference an existing clients row',
      new.client_id;
  end if;

  return new;
end;
$$;

drop trigger if exists client_budget_context_set_studio_id
  on public.client_budget_context;
create trigger client_budget_context_set_studio_id
  before insert or update
  on public.client_budget_context
  for each row execute function public.client_budget_context_set_studio_id();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Studio members read and write their own studio's budget context. No DELETE
-- policy: clearing a client's budget context is an UPDATE to NULL / '', not a
-- row removal, so rows only disappear via the parent client/studio CASCADE.
alter table public.client_budget_context enable row level security;

drop policy if exists "client_budget_context_member_select"
  on public.client_budget_context;
create policy "client_budget_context_member_select"
  on public.client_budget_context for select to authenticated
  -- Qualified for consistency with the write policies below. There is no
  -- joined subquery here so the bare name is unambiguous today, but 0126's
  -- tautology started as an unqualified reference that was safe until a
  -- subquery was added around it.
  using (public.is_studio_member(client_budget_context.studio_id));

-- ACTOR-DERIVED WRITE AUTHORITY.
--
-- Studio membership alone is NOT sufficient to write. A member issuing
-- PostgREST requests directly could otherwise set updated_by_practitioner_id
-- to any colleague in their studio, making "last updated by" caller-authored
-- rather than durable evidence. The database therefore VERIFIES the actor
-- instead of trusting the application to have derived it: the row's updater
-- must be the ACTIVE practitioner belonging to the signed-in caller, in the
-- row's own studio.
--
-- Every column reference is FULLY QUALIFIED with client_budget_context. This
-- is not stylistic. 0126 wrote the equivalent clause as `p.studio_id =
-- studio_id`, and because `practitioners` also has a studio_id column
-- PostgreSQL resolved the bare name to the INNER one — degrading the check to
-- the tautology `p.studio_id = p.studio_id`, which 0127 had to fix in
-- production. This file uses 0127's corrected form from the start.
--
-- The BEFORE trigger above has already overwritten studio_id from the parent
-- client by the time WITH CHECK is evaluated (BEFORE ROW triggers run first),
-- so these predicates see the SERVER-DERIVED studio, never a caller-supplied
-- one. For a practitioner holding memberships in two studios, that means the
-- actor must be their practitioner row IN THE CLIENT'S studio specifically.
drop policy if exists "client_budget_context_member_insert"
  on public.client_budget_context;
create policy "client_budget_context_member_insert"
  on public.client_budget_context for insert to authenticated
  with check (
    public.is_studio_member(client_budget_context.studio_id)
    and exists (
      select 1 from public.practitioners p
      where p.id = client_budget_context.updated_by_practitioner_id
        and p.studio_id = client_budget_context.studio_id
        and p.user_id = (select auth.uid())
        and p.active
    )
  );

-- USING gates which existing row may be targeted; WITH CHECK gates the result.
-- Both are required: USING alone would let a member move a row into another
-- studio, and WITH CHECK alone would let them target a foreign row.
--
-- A member may edit any budget row in their own studio (USING), but whatever
-- results must be attributed to THEM (WITH CHECK) — you cannot edit a
-- colleague's record and leave their name on it.
drop policy if exists "client_budget_context_member_update"
  on public.client_budget_context;
create policy "client_budget_context_member_update"
  on public.client_budget_context for update to authenticated
  using (public.is_studio_member(client_budget_context.studio_id))
  with check (
    public.is_studio_member(client_budget_context.studio_id)
    and exists (
      select 1 from public.practitioners p
      where p.id = client_budget_context.updated_by_practitioner_id
        and p.studio_id = client_budget_context.studio_id
        and p.user_id = (select auth.uid())
        and p.active
    )
  );

-- ---------------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------------
-- Supabase's ALTER DEFAULT PRIVILEGES grants to anon, authenticated AND
-- service_role at create time, so every role that must not have access is
-- revoked EXPLICITLY BY NAME. This was missed once in 0129 (anon) and again in
-- 0164 (service_role); it is not left to a default.
--
-- authenticated: SELECT/INSERT/UPDATE, all RLS-gated. DELETE and TRUNCATE
-- revoked — there is no delete route by design.
grant select, insert, update on public.client_budget_context to authenticated;
revoke delete, truncate on public.client_budget_context from authenticated;

-- anon (public booking, unauthenticated, portal-adjacent surfaces): NOTHING.
-- Budget context must never be reachable from a client-facing surface.
revoke all on public.client_budget_context from anon;

-- service_role: NOTHING. No server path uses an admin client for this table;
-- the only writer is the user-scoped, RLS-enforced server action.
revoke all on public.client_budget_context from service_role;

comment on table public.client_budget_context is
  'CURRENT practitioner-recorded budget context for a client (one row per client, mutable in place). Practitioner-held planning documentation only: not a clinical note, not an affordability score, not income or payment data, and never surfaced to clients. Supersedes the plan-scoped treatment_plans.budget_notes (0034), which is retained read-only and was deliberately NOT backfilled.';

comment on column public.client_budget_context.updated_by_practitioner_id is
  'The practitioner who last wrote this row. VERIFIED at the database boundary, not merely supplied: the insert/update policies require this to be the ACTIVE practitioner whose user_id = auth.uid() in the row''s own (trigger-derived) studio, so a member can neither attribute an edit to a colleague nor erase attribution. NOT NULL — there is no legitimate unattributed writer.';

comment on column public.client_budget_context.budget_level is
  'Broad practitioner-selected level: no_stated_limit | somewhat_limited | severely_limited. NULL means no broad level was recorded, which is a legitimate state and not a fourth level. Mirrors lib/budget/levels.ts.';

commit;
