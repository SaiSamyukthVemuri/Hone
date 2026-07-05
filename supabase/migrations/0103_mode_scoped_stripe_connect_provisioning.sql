-- 0103: Mode-scoped Stripe Connect provisioning (emergency live-payment fix).
--
-- ROOT CAUSE (production, first live-enablement attempt): a studio can hold
-- only ONE studio_payment_settings row because studio_id is the PRIMARY KEY,
-- and create_or_claim_stripe_account_provisioning hard-refuses a cross-mode
-- claim:
--   "studio ... is already bound to mode f, refusing to provision mode t"
-- Willow's row is the TEST-mode connected account, so the LIVE runtime could
-- not provision a live account; the app then fell back to the stored TEST
-- acct_... with the LIVE key and Stripe rejected it (account_invalid).
--
-- FIX: one settings row PER (studio, mode):
--   * test row:        stripe_livemode = false
--   * live row:        stripe_livemode = true
--   * placeholder row: stripe_livemode = null  (dormant studio-wide flags —
--     today only require_card_on_file, per the Option A decision; it carries
--     no Stripe binding: the account/mode pair CHECK keeps account null)
--
-- What changes:
--   1. Surrogate PK `id uuid`; studio_id stops being the PK (that was the
--      one-row-per-studio invariant).
--   2. UNIQUE NULLS NOT DISTINCT (studio_id, stripe_livemode) — one row per
--      (studio, mode), at most one null-mode placeholder. (Prod is PG 17;
--      NULLS NOT DISTINCT needs PG >= 15. The local CI chain applies this
--      file from scratch, so an unsupported image fails loudly there.)
--   3. The five settings RPCs become mode-scoped (bodies below are the 0032
--      versions — the only definitions — edited minimally):
--        * create_or_claim_stripe_account_provisioning: same-mode binding
--          short-circuits; DIFFERENT-mode binding no longer blocks (the
--          cross-mode refusal is removed); in-flight attempts are matched
--          per mode.
--        * complete_stripe_account_provisioning: settings lock + upsert are
--          per (studio_id, stripe_livemode); never touches the other mode's
--          row; still refuses to swap an established same-mode binding.
--        * sync_studio_account_status: locks/updates the CURRENT-mode row
--          only; live account data can never overwrite the test row (and
--          vice versa).
--        * get_studio_payment_settings_display: gains p_stripe_livemode and
--          returns the current-mode row only; zero rows = "not connected"
--          (the settings page already renders that safely). The old 1-arg
--          overload is DROPPED. require_card_on_file is read from the
--          null-mode placeholder row (Option A), falling back to the mode
--          row's value for pre-0103 rows.
--        * set_studio_require_card_on_file: upserts the null-mode
--          placeholder row (Option A); its enable-guard accepts ANY
--          connected+enabled+charges mode row.
--
-- What does NOT change:
--   * studio_payment_settings_account_mode_unique (studio_id,
--     stripe_account_id, stripe_livemode) — the FK target for the six
--     downstream payment tables (client_payment_methods,
--     client_stripe_customers, appointment_payments,
--     pending_booking_payment_sessions, stripe_charge_attempts,
--     stripe_customer_provisioning_attempts). Verified in production: every
--     FK references this 3-column tuple, none reference the PK — the PK swap
--     is FK-safe.
--   * studio_payment_settings_account_mode_pair_check — a row either has
--     BOTH account+mode or NEITHER; still exactly right (mode rows always
--     carry an account; the placeholder carries neither).
--   * Existing rows: preserved untouched (both prod rows are test-mode with
--     require_card_on_file=false — verified read-only pre-migration; no
--     value backfill is needed).
--   * RLS posture (enabled, no policies — all access is via these
--     security-definer RPCs / service_role), grants (restated verbatim),
--     charge/refund/webhook payment behavior, payment_charge_attempts and
--     every other payment table.
--
-- Live payments remain OFF: this migration only lets a live binding ROW
-- exist; a charge still requires the full operator checklist (docs/16
-- §17.15): live env + live onboarding + enabled account + supervised run.

-- ---------------------------------------------------------------------------
-- 1. Surrogate PK. Guarded so the migration is re-runnable: the swap only
--    happens while the PK is still (studio_id).
-- ---------------------------------------------------------------------------
alter table public.studio_payment_settings
  add column if not exists id uuid not null default gen_random_uuid();

do $$
declare
  v_pk_cols text[];
begin
  select array_agg(a.attname::text order by k.ord)
    into v_pk_cols
  from pg_constraint c
  cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
  join pg_attribute a
    on a.attrelid = c.conrelid and a.attnum = k.attnum
  where c.conrelid = 'public.studio_payment_settings'::regclass
    and c.contype = 'p';

  if v_pk_cols = array['studio_id'] then
    alter table public.studio_payment_settings
      drop constraint studio_payment_settings_pkey;
    alter table public.studio_payment_settings
      add constraint studio_payment_settings_pkey primary key (id);
  end if;
end $$;

comment on column public.studio_payment_settings.id is
  '0103: surrogate PK. studio_id stopped being the PK so a studio can hold one settings row per Stripe mode (test/live) plus one null-mode placeholder for dormant studio-wide flags.';

-- ---------------------------------------------------------------------------
-- 2. One row per (studio, mode). NULLS NOT DISTINCT makes the null-mode
--    placeholder unique too (at most one per studio) and lets the
--    require_card upsert target this constraint directly.
-- ---------------------------------------------------------------------------
alter table public.studio_payment_settings
  drop constraint if exists studio_payment_settings_studio_mode_uniq;
alter table public.studio_payment_settings
  add constraint studio_payment_settings_studio_mode_uniq
  unique nulls not distinct (studio_id, stripe_livemode);

comment on constraint studio_payment_settings_studio_mode_uniq
  on public.studio_payment_settings is
  '0103: one settings row per (studio, mode); NULLS NOT DISTINCT caps the null-mode placeholder at one per studio. Replaces the pre-0103 one-row-per-studio PK invariant.';

-- ---------------------------------------------------------------------------
-- 2b. Mode-scope the provisioning-attempts active-uniqueness (adversarial
--     review BLOCKER). The 0032 index was UNIQUE (studio_id) WHERE status IN
--     ('pending','processing','succeeded') — per STUDIO. A studio with a
--     SUCCEEDED test attempt (Willow's exact state) would make the new
--     mode-scoped claim fall through to a fresh live-attempt INSERT and die
--     with a raw 23505 — the very scenario this migration fixes. Rescoped to
--     one ACTIVE attempt per (studio, mode); the same predicate still
--     serializes concurrent same-mode claims (the second INSERT blocks on the
--     first's speculative insertion, exactly as pre-0103). NULLS NOT DISTINCT
--     also caps legacy null-mode rows (production has none — verified).
-- ---------------------------------------------------------------------------
drop index if exists public.stripe_account_provisioning_active_uniq;
create unique index stripe_account_provisioning_active_uniq
  on public.stripe_account_provisioning_attempts (studio_id, stripe_livemode)
  nulls not distinct
  where status in ('pending', 'processing', 'succeeded');

-- ---------------------------------------------------------------------------
-- 3a. create_or_claim_stripe_account_provisioning — mode-scoped.
--     0032 body with two edits: (1) the settings short-circuit matches the
--     SAME mode only and the cross-mode hard refusal is removed; (2) the
--     in-flight attempt lookup matches the SAME mode only (so a test attempt
--     can never be returned to, nor block, a live claim), which also makes
--     the old in-flight cross-mode refusal unreachable (removed).
-- ---------------------------------------------------------------------------
create or replace function public.create_or_claim_stripe_account_provisioning(
  p_studio_id        uuid,
  p_stripe_livemode  boolean
) returns table (
  attempt_id                    uuid,
  out_status                    text,
  out_stripe_account_id         text,
  out_stripe_livemode           boolean,
  out_idempotency_key           text,
  out_processing_claim_token    uuid,
  should_execute_stripe_call    boolean,
  already_provisioned           boolean
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_existing public.stripe_account_provisioning_attempts%rowtype;
  v_settings_account text;
  v_settings_mode boolean;
  v_new_id uuid;
  v_new_claim uuid;
  v_new_key text;
begin
  if p_stripe_livemode is null then
    raise exception 'p_stripe_livemode must be non-null' using errcode = '22023';
  end if;

  -- 0103: already-bound is now PER MODE. A binding for the REQUESTED mode
  -- short-circuits (reuse). A binding for the other mode is ignored — the
  -- pre-0103 cross-mode refusal ("already bound to mode f, refusing to
  -- provision mode t") is what blocked live provisioning for studios with a
  -- test account.
  select sps.stripe_account_id, sps.stripe_livemode
    into v_settings_account, v_settings_mode
  from public.studio_payment_settings sps
  where sps.studio_id = p_studio_id
    and sps.stripe_livemode = p_stripe_livemode
    and sps.stripe_account_id is not null;
  if found then
    return query
      select null::uuid, 'succeeded'::text, v_settings_account, v_settings_mode,
             null::text, null::uuid, false, true;
    return;
  end if;

  -- Find the most recent non-terminal attempt FOR THIS MODE under FOR UPDATE
  -- so concurrent same-mode callers serialize through the claim decision.
  -- 0103: mode-scoped — an attempt opened for the other mode neither blocks
  -- nor is returned (pre-0103 raised on that mismatch). Legacy rows with a
  -- null stripe_livemode are ignored (v2 always stamps the mode at insert;
  -- production has none).
  select * into v_existing
  from public.stripe_account_provisioning_attempts spa
  where spa.studio_id = p_studio_id
    and spa.stripe_livemode = p_stripe_livemode
    and spa.status in ('pending', 'processing', 'succeeded')
  order by spa.created_at desc
  limit 1
  for update;

  if found then
    -- succeeded or actively processing: no new Stripe call.
    if v_existing.status in ('succeeded', 'processing') then
      return query
        select v_existing.id, v_existing.status, v_existing.stripe_account_id,
               v_existing.stripe_livemode, v_existing.idempotency_key,
               v_existing.processing_claim_token, false, false;
      return;
    end if;
    -- Fresh claim within 5-minute lease window: another worker
    -- is already running accounts.create; we wait, do not race.
    if v_existing.processing_claim_token is not null
       and v_existing.processing_started_at > now() - interval '5 minutes' then
      return query
        select v_existing.id, v_existing.status, v_existing.stripe_account_id,
               v_existing.stripe_livemode, v_existing.idempotency_key,
               v_existing.processing_claim_token, false, false;
      return;
    end if;
    -- Stale claim: take it over. Reuse the SAME idempotency_key so
    -- Stripe's idempotency layer collapses our retry with the prior
    -- accounts.create request, even if the previous worker had
    -- already managed to create the account on Stripe's side.
    v_new_claim := gen_random_uuid();
    update public.stripe_account_provisioning_attempts spa
       set processing_claim_token = v_new_claim,
           processing_started_at = now(),
           updated_at = now()
     where spa.id = v_existing.id;
    return query
      select v_existing.id, v_existing.status, v_existing.stripe_account_id,
             v_existing.stripe_livemode, v_existing.idempotency_key,
             v_new_claim, true, false;
    return;
  end if;

  -- No prior attempt for this mode: create a fresh pending one and hand the
  -- caller a brand-new idempotency_key + claim token. Mode is stamped on the
  -- row so the mode-scoped lookups above stay exact.
  v_new_id := gen_random_uuid();
  v_new_claim := gen_random_uuid();
  v_new_key := 'acct_' || p_studio_id::text || '_' || gen_random_uuid()::text;

  insert into public.stripe_account_provisioning_attempts (
    id, studio_id, stripe_livemode, status, idempotency_key,
    processing_started_at, processing_claim_token,
    created_at, updated_at
  ) values (
    v_new_id, p_studio_id, p_stripe_livemode, 'pending', v_new_key,
    now(), v_new_claim, now(), now()
  );

  return query
    select v_new_id, 'pending'::text, null::text, p_stripe_livemode,
           v_new_key, v_new_claim, true, false;
end;
$$;

revoke execute on function public.create_or_claim_stripe_account_provisioning(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.create_or_claim_stripe_account_provisioning(uuid, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3b. complete_stripe_account_provisioning — mode-scoped.
--     0032 body with two edits: (1) the settings lock/validate targets the
--     SAME-mode row (the other mode's binding is irrelevant and must not
--     block completion); (2) the upsert conflicts on
--     (studio_id, stripe_livemode) instead of (studio_id), so completing one
--     mode can never overwrite the other mode's row. The refuse-to-swap
--     guard (established same-mode binding must equal the Stripe result) is
--     preserved verbatim.
-- ---------------------------------------------------------------------------
create or replace function public.complete_stripe_account_provisioning(
  p_attempt_id          uuid,
  p_claim_token         uuid,
  p_stripe_account_id   text,
  p_stripe_livemode     boolean
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio_id uuid;
  v_attempt_mode boolean;
  v_existing_settings public.studio_payment_settings%rowtype;
begin
  -- Reject blank-string Stripe Account IDs in addition to NULL (a blank
  -- string would corrupt the studio's configured binding).
  if nullif(trim(coalesce(p_stripe_account_id, '')), '') is null
     or p_stripe_livemode is null then
    raise exception 'p_stripe_account_id and p_stripe_livemode must be supplied (non-blank)'
      using errcode = '22023';
  end if;

  select spa.studio_id, spa.stripe_livemode
    into v_studio_id, v_attempt_mode
  from public.stripe_account_provisioning_attempts spa
  where spa.id = p_attempt_id
    and spa.processing_claim_token is not distinct from p_claim_token
    and spa.status in ('pending', 'processing')
  for update;
  if not found then
    raise exception 'account provisioning claim mismatch or terminal'
      using errcode = 'P0002';
  end if;

  -- The attempt's stamped mode must match the completion's mode.
  if v_attempt_mode is not null
     and v_attempt_mode is distinct from p_stripe_livemode then
    raise exception 'attempt % was opened for mode %, cannot be completed as mode %', p_attempt_id, v_attempt_mode, p_stripe_livemode
      using errcode = 'P0002';
  end if;

  -- 0103: lock the (possible) existing SAME-MODE settings row. If a binding
  -- already exists for this mode and disagrees with the Stripe result, ABORT
  -- and roll back — we never silently swap an established binding. The other
  -- mode's row is deliberately not consulted.
  select * into v_existing_settings
  from public.studio_payment_settings sps
  where sps.studio_id = v_studio_id
    and sps.stripe_livemode = p_stripe_livemode
  for update;
  if found
     and v_existing_settings.stripe_account_id is not null then
    if v_existing_settings.stripe_account_id is distinct from p_stripe_account_id then
      raise exception
        'studio % already bound to (%, livemode=%); refusing to complete provisioning as (%, livemode=%)',
        v_studio_id,
        v_existing_settings.stripe_account_id, v_existing_settings.stripe_livemode,
        p_stripe_account_id, p_stripe_livemode
        using errcode = 'P0002';
    end if;
  end if;

  -- Safe to flip the attempt to succeeded now.
  update public.stripe_account_provisioning_attempts spa
     set status                 = 'succeeded',
         stripe_account_id      = p_stripe_account_id,
         stripe_livemode        = p_stripe_livemode,
         processing_claim_token = null,
         terminal_at            = now(),
         updated_at             = now()
   where spa.id = p_attempt_id;

  -- Establish or confirm the CURRENT-MODE binding. Conflict target is the
  -- 0103 per-(studio, mode) unique, so this insert can only ever touch this
  -- mode's row; the partial WHERE preserves the refuse-to-swap posture (an
  -- equal binding was validated above and no-ops here).
  insert into public.studio_payment_settings
    (studio_id, stripe_account_id, stripe_livemode, created_at, updated_at)
  values (v_studio_id, p_stripe_account_id, p_stripe_livemode, now(), now())
  on conflict on constraint studio_payment_settings_studio_mode_uniq do update set
    stripe_account_id = excluded.stripe_account_id,
    stripe_livemode   = excluded.stripe_livemode,
    updated_at        = now()
    where public.studio_payment_settings.stripe_account_id is null;
end;
$$;

revoke execute on function public.complete_stripe_account_provisioning(uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.complete_stripe_account_provisioning(uuid, uuid, text, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3c. sync_studio_account_status — mode-scoped.
--     0032 body with the null guards hoisted above the row lookup and the
--     lookup + UPDATE scoped to the CURRENT-mode row, so live account data
--     can never overwrite the test row (and vice versa). The account-match
--     hard refusal is preserved verbatim.
-- ---------------------------------------------------------------------------
create or replace function public.sync_studio_account_status(
  p_studio_id                       uuid,
  p_stripe_account_id               text,
  p_stripe_livemode                 boolean,
  p_status                          text,
  p_charges_enabled                 boolean,
  p_payouts_enabled                 boolean,
  p_onboarding_completed_at         timestamptz
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_existing public.studio_payment_settings%rowtype;
begin
  if p_status is not null
     and p_status not in ('pending','restricted','enabled','rejected') then
    raise exception 'invalid stripe_account_status: %', p_status
      using errcode = '22023';
  end if;

  -- Null guards FIRST (0103: hoisted above the lookup — a null mode must
  -- never match the null-mode placeholder row).
  if p_stripe_account_id is null then
    raise exception 'stripe_account_id mismatch for studio %', p_studio_id
      using errcode = 'P0002';
  end if;
  if p_stripe_livemode is null then
    raise exception 'stripe_livemode mismatch for studio %', p_studio_id
      using errcode = 'P0002';
  end if;

  -- 0103: lock the CURRENT-mode row only.
  select * into v_existing
  from public.studio_payment_settings sps
  where sps.studio_id = p_studio_id
    and sps.stripe_livemode = p_stripe_livemode
  for update;

  -- Hard refusal: this RPC will never create a binding. If the studio has
  -- not been onboarded FOR THIS MODE, the only legitimate route to a binding
  -- is via complete_stripe_account_provisioning.
  if not found then
    raise exception 'studio % has no Stripe binding for livemode=%; sync_studio_account_status will not create one', p_studio_id, p_stripe_livemode
      using errcode = 'P0002';
  end if;

  -- Hard refusal: caller's claimed account MUST match the stored binding for
  -- this mode exactly (mode equality is structural via the scoped lookup).
  if v_existing.stripe_account_id is distinct from p_stripe_account_id then
    raise exception 'stripe_account_id mismatch for studio %', p_studio_id
      using errcode = 'P0002';
  end if;

  -- Status fields only, on the current-mode row only. We intentionally do
  -- NOT write stripe_account_id / stripe_livemode here.
  update public.studio_payment_settings sps
     set stripe_account_status            = p_status,
         stripe_charges_enabled           = coalesce(p_charges_enabled, false),
         stripe_payouts_enabled           = coalesce(p_payouts_enabled, false),
         stripe_onboarding_completed_at   = coalesce(p_onboarding_completed_at,
                                                     sps.stripe_onboarding_completed_at),
         updated_at                       = now()
   where sps.studio_id = p_studio_id
     and sps.stripe_livemode = p_stripe_livemode;
end;
$$;

revoke execute on function public.sync_studio_account_status(uuid, text, boolean, text, boolean, boolean, timestamptz)
  from public, anon, authenticated;
grant execute on function public.sync_studio_account_status(uuid, text, boolean, text, boolean, boolean, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3d. get_studio_payment_settings_display — gains p_stripe_livemode and
--     returns the CURRENT-mode row only. Zero rows = "not connected" (the
--     settings page maps a missing row to the not-connected state and
--     renders the Connect prompt). The old 1-arg overload is dropped so a
--     stale caller cannot silently read the wrong mode's row.
--     require_card_on_file is served from the null-mode placeholder row
--     (Option A), falling back to the mode row's own value for pre-0103
--     rows that still carry the flag.
-- ---------------------------------------------------------------------------
drop function if exists public.get_studio_payment_settings_display(uuid);

create or replace function public.get_studio_payment_settings_display(
  p_studio_id       uuid,
  p_stripe_livemode boolean
) returns table (
  account_status              text,
  charges_enabled             boolean,
  payouts_enabled             boolean,
  onboarding_completed_at     timestamptz,
  require_card_on_file        boolean,
  livemode                    boolean
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if not public.is_studio_owner(p_studio_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_stripe_livemode is null then
    raise exception 'p_stripe_livemode must be non-null' using errcode = '22023';
  end if;
  return query
    select sps.stripe_account_status, sps.stripe_charges_enabled,
           sps.stripe_payouts_enabled, sps.stripe_onboarding_completed_at,
           coalesce(
             (select ph.require_card_on_file
                from public.studio_payment_settings ph
               where ph.studio_id = p_studio_id
                 and ph.stripe_livemode is null),
             sps.require_card_on_file
           ) as require_card_on_file,
           sps.stripe_livemode
      from public.studio_payment_settings sps
     where sps.studio_id = p_studio_id
       and sps.stripe_livemode = p_stripe_livemode;
end;
$$;

revoke execute on function public.get_studio_payment_settings_display(uuid, boolean)
  from public, anon;
grant execute on function public.get_studio_payment_settings_display(uuid, boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3e. set_studio_require_card_on_file — Option A: the flag lives on the
--     null-mode placeholder row. The enable-guard accepts ANY mode row that
--     is connected + enabled + charges-enabled (Stripe onboarding must be
--     complete before the flag can be turned on). DELIBERATE cross-mode
--     posture (reviewed): under Option A the flag is studio-wide, so
--     enabling it with only one mode onboarded is a per-studio operator
--     decision; the flag currently has ZERO runtime call sites
--     (check-stripe-gates pins this RPC to 0 occurrences) and the dead
--     card-required RPCs that read it are dropped below, so the only
--     remaining reader is the display RPC's placeholder coalesce. The
--     upsert targets (studio_id, stripe_livemode=null) via the 0103
--     NULLS NOT DISTINCT unique, so it can never touch a test/live row.
-- ---------------------------------------------------------------------------
create or replace function public.set_studio_require_card_on_file(
  p_studio_id       uuid,
  p_practitioner_id uuid,
  p_value           boolean
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if not exists (
    select 1 from public.practitioners p
     where p.id = p_practitioner_id and p.studio_id = p_studio_id
       and p.role = 'owner' and p.active = true
  ) then
    raise exception 'only the studio owner can change require_card_on_file'
      using errcode = '42501';
  end if;

  if p_value = true then
    if not exists (
      select 1
        from public.studio_payment_settings sps
       where sps.studio_id = p_studio_id
         and sps.stripe_account_id is not null
         and sps.stripe_livemode is not null
         and sps.stripe_account_status = 'enabled'
         and coalesce(sps.stripe_charges_enabled, false) = true
    ) then
      raise exception 'Stripe Connect onboarding must be complete and charges enabled before requiring card on file'
        using errcode = 'P0002';
    end if;
  end if;

  -- Option A placeholder upsert: stripe_livemode is left NULL (with a NULL
  -- stripe_account_id the account/mode pair CHECK is satisfied), so this row
  -- is invisible to every mode-scoped Stripe lookup and can never collide
  -- with the test/live binding rows.
  insert into public.studio_payment_settings (studio_id, require_card_on_file, created_at, updated_at)
  values (p_studio_id, p_value, now(), now())
  on conflict on constraint studio_payment_settings_studio_mode_uniq do update set
    require_card_on_file = excluded.require_card_on_file,
    updated_at = now();
end;
$$;

revoke execute on function public.set_studio_require_card_on_file(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.set_studio_require_card_on_file(uuid, uuid, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. Drop the two remaining DEAD card-required-booking RPCs (adversarial
--    review finding). Both still carried the pre-0103 one-row-per-studio
--    assumption (`select * into v_settings ... where studio_id = ...` with no
--    mode filter) — with 2-3 rows per studio their non-STRICT SELECT INTO
--    would pick an arbitrary row and fail nondeterministically. Rather than
--    copy ~400 lines of body for a 2-line scoping edit, they are dropped:
--      * ZERO call sites anywhere in app/, lib/, components/, scripts/, or
--        tests/ (verified by repo-wide grep) — the card-required booking flow
--        was designed in 0032 but never wired; check-stripe-gates pins
--        set_studio_require_card_on_file (its switch) to 0 runtime calls.
--      * service_role-only grants — nothing outside the app can invoke them.
--      * Their sibling finalize_card_required_public_booking was already
--        dropped as dead in migration 0091 (the explicit precedent).
--    A future revival of card-required booking must be rebuilt mode-aware.
--    Dropping unreachable functions changes no runtime behavior.
-- ---------------------------------------------------------------------------
drop function if exists public.start_card_required_booking_session(
  uuid, uuid, uuid, uuid, boolean, timestamptz, timestamptz, integer,
  text, boolean, text, text
);
drop function if exists public.create_or_claim_charge_attempt(
  uuid, uuid, uuid, integer
);

-- ---------------------------------------------------------------------------
-- Verification SQL (operator runs after deploy):
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.studio_payment_settings'::regclass
--   order by conname;
--   -- expect: studio_payment_settings_pkey PRIMARY KEY (id);
--   --         studio_payment_settings_studio_mode_uniq
--   --           UNIQUE NULLS NOT DISTINCT (studio_id, stripe_livemode);
--   --         studio_payment_settings_account_mode_unique unchanged;
--   --         studio_payment_settings_account_mode_pair_check unchanged;
--   --         6 incoming FKs unchanged (query with confrelid to confirm).
--
--   select count(*) from public.studio_payment_settings;         -- 2 (unchanged)
--   select stripe_livemode, count(*)
--   from public.studio_payment_settings group by 1;              -- false: 2
--
--   select proname, pg_get_function_identity_arguments(oid)
--   from pg_proc
--   where proname = 'get_studio_payment_settings_display';
--   -- expect exactly ONE row: (p_studio_id uuid, p_stripe_livemode boolean).
--
--   -- The old cross-mode refusal is gone (code-only check):
--   select prosrc like '%already bound to mode%' as has_old_refusal
--   from pg_proc where proname = 'create_or_claim_stripe_account_provisioning';
--   -- expect: false.
-- ---------------------------------------------------------------------------
