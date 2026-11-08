-- 0325 — waitlist decline answers, withdrawal requests and the owner follow-up (HON-7 V1). DRAFT: not applied, not reviewed.
--
-- WHAT THIS DOES. An invited person who declines now gives two short answers, the entry goes back to Waiting in its
-- original place, and the studio owner is told (bell row + one held outbox row per verified owner). A person can also say
-- "I no longer need an appointment". Either opens a FOLLOW-UP the owner works through. Frozen contract:
-- hone-handoffs/2026-10-18/willow/0325-draft/CONTRACT.md.
--
-- TABLES (all RLS-on, no policy, no anon/authenticated access; reached only through the commands below):
--   waitlist_followups              ids, kind, status, dates. No client text.
--   waitlist_decline_answers        the ONLY table holding the person's words; erasable.
--   waitlist_decline_owner_emails   the owner-email outbox: ids/status/counts only.
--   waitlist_erase_records          ids and dates only; never restored with the answers.
--
-- ADMIT (the pending_owner_review hold) is appended LAST in this file, built from the final 0324 bytes.
--
-- Lock order everywhere: entry FOR UPDATE, then invitation/follow-up. That is 0192 decline's own order, so these commands
-- take no studios or round lock and cannot close a cycle with 0313/0324 (studios -> round -> entry -> invitation).

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.waitlist_followups (
  id             uuid primary key default gen_random_uuid(),
  studio_id      uuid not null references public.studios(id) on delete cascade,
  entry_id       uuid not null,
  invitation_id  uuid,
  kind           text not null,
  status         text not null default 'open',
  opened_at      timestamptz not null default now(),
  closed_at      timestamptz,
  closed_by_practitioner_id uuid,
  appointment_id uuid references public.appointments(id) on delete restrict,
  constraint waitlist_followups_kind_check check (kind in ('decline','withdrawal')),
  constraint waitlist_followups_status_check check (
    (kind = 'decline'    and status in ('open','handled','booked','removed')) or
    (kind = 'withdrawal' and status in ('open','kept','booked','removed'))),
  constraint waitlist_followups_closed_check check ((status = 'open') = (closed_at is null)),
  constraint waitlist_followups_appointment_check check (appointment_id is null or status = 'booked'),
  constraint waitlist_followups_entry_same_studio_fk
    foreign key (entry_id, studio_id) references public.new_client_waitlist_entries (id, studio_id) on delete cascade,
  -- NO ACTION, not RESTRICT: identical refusal, but checked at statement end so a studio cascade can still remove both.
  constraint waitlist_followups_invitation_fk
    foreign key (invitation_id) references public.new_client_waitlist_invitations (id) on delete no action,
  constraint waitlist_followups_closer_fk
    foreign key (closed_by_practitioner_id, studio_id) references public.practitioners (id, studio_id) on delete no action,
  constraint waitlist_followups_appointment_key unique (appointment_id)
);
-- A decline follow-up is one per invitation; one OPEN follow-up per entry and kind.
create unique index if not exists waitlist_followups_decline_invitation_key
  on public.waitlist_followups (invitation_id) where kind = 'decline';
create unique index if not exists waitlist_followups_one_open_per_kind
  on public.waitlist_followups (entry_id, kind) where status = 'open';
create index if not exists waitlist_followups_studio_open_idx
  on public.waitlist_followups (studio_id, opened_at, id) where status = 'open';
create index if not exists waitlist_followups_invitation_idx
  on public.waitlist_followups (invitation_id) where invitation_id is not null;

create table if not exists public.waitlist_decline_answers (
  followup_id  uuid primary key references public.waitlist_followups(id) on delete cascade,
  studio_id    uuid not null references public.studios(id) on delete cascade,
  why_not_work text,
  better_times text,
  submitted_at timestamptz not null default now(),
  erased_at    timestamptz,
  erased_by_practitioner_id uuid,
  -- D1: NO length check here; the command validates and returns the value-free invalid_input.
  constraint waitlist_decline_answers_erased_check check (
    (erased_at is null and why_not_work is not null and better_times is not null) or
    (erased_at is not null and why_not_work is null and better_times is null)),
  constraint waitlist_decline_answers_eraser_fk
    foreign key (erased_by_practitioner_id, studio_id) references public.practitioners (id, studio_id) on delete no action
);

create table if not exists public.waitlist_erase_records (
  id          uuid primary key default gen_random_uuid(),
  studio_id   uuid not null references public.studios(id) on delete cascade,
  followup_id uuid not null,
  kind        text not null,
  erased_at   timestamptz not null default now(),
  erased_by_practitioner_id uuid,
  reason      text not null,
  constraint waitlist_erase_records_kind_check check (kind in ('decline','withdrawal')),
  constraint waitlist_erase_records_reason_check check (reason in ('owner_erase','removed','retention')),
  -- followup_id is deliberately NOT a foreign key: this log must outlive and never be restored with the answers.
  constraint waitlist_erase_records_followup_reason_key unique (followup_id, reason)
);

create table if not exists public.waitlist_decline_owner_emails (
  id                        uuid primary key default gen_random_uuid(),
  studio_id                 uuid not null references public.studios(id) on delete cascade,
  invitation_id             uuid not null,
  recipient_practitioner_id uuid not null,
  template_key              text not null default 'waitlist_decline_owner',
  status                    text not null default 'held',
  attempt_count             integer not null default 0,
  claimed_at                timestamptz,
  last_error_code           text,
  provider_message_id       text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  sent_at                   timestamptz,
  constraint waitlist_decline_owner_emails_template_check check (template_key = 'waitlist_decline_owner'),
  constraint waitlist_decline_owner_emails_status_check check (status in ('held','sending','sent','failed','cancelled')),
  constraint waitlist_decline_owner_emails_attempt_check check (attempt_count >= 0),
  constraint waitlist_decline_owner_emails_error_check check (last_error_code is null or last_error_code in
    ('provider_rejected','provider_unavailable','timeout','not_owner','unverified','no_recipient','unknown')),
  constraint waitlist_decline_owner_emails_sent_check check (sent_at is null or status = 'sent'),
  constraint waitlist_decline_owner_emails_pair_key unique (invitation_id, recipient_practitioner_id),
  constraint waitlist_decline_owner_emails_invitation_fk
    foreign key (invitation_id) references public.new_client_waitlist_invitations (id) on delete no action,
  constraint waitlist_decline_owner_emails_recipient_fk
    foreign key (recipient_practitioner_id, studio_id) references public.practitioners (id, studio_id) on delete no action
);
create index if not exists waitlist_decline_owner_emails_held_idx
  on public.waitlist_decline_owner_emails (created_at) where status = 'held';
create index if not exists waitlist_decline_owner_emails_retry_idx
  on public.waitlist_decline_owner_emails (created_at) where status in ('failed','sending') and attempt_count < 3;
create index if not exists waitlist_decline_owner_emails_studio_idx
  on public.waitlist_decline_owner_emails (studio_id);

alter table public.waitlist_followups            enable row level security;
alter table public.waitlist_decline_answers      enable row level security;
alter table public.waitlist_erase_records        enable row level security;
alter table public.waitlist_decline_owner_emails enable row level security;
revoke all on public.waitlist_followups            from public, anon, authenticated, service_role;
revoke all on public.waitlist_decline_answers      from public, anon, authenticated, service_role;
revoke all on public.waitlist_erase_records        from public, anon, authenticated, service_role;
revoke all on public.waitlist_decline_owner_emails from public, anon, authenticated, service_role;
-- The sender claims and settles outbox rows; it never inserts (the decline function does) or deletes.
grant select, update on public.waitlist_decline_owner_emails to service_role;

comment on table public.waitlist_decline_answers is
  'The ONLY table holding a waitlist person''s own words (decline answers). Erasable by owner, by Remove and by retention. Never selected outside the owner-gated read command.';
comment on table public.waitlist_erase_records is
  'Ids and dates only. Lives apart from the answers and is never restored with them: after any restore, replay the erasures listed here.';

-- ---------------------------------------------------------------------------
-- 2. waiting -> converted: admitted NARROWLY, only inside link_waitlist_followup_appointment
-- ---------------------------------------------------------------------------
-- No migration gives `waiting` an edge to `converted`. The one new edge is keyed to a transaction-local setting that only the
-- link function sets (and unsets) around its single UPDATE. The body is 0208's (the latest definition) reproduced in full
-- with exactly two inserted regions: that edge, and its evidence allowance in v_allowed.
create or replace function public.new_client_waitlist_entries_transition_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_legal   boolean;
  v_allowed text[];
  v_bad     text[] := '{}';
begin
  if new.id is distinct from old.id
     or new.studio_id is distinct from old.studio_id
     or new.joined_at is distinct from old.joined_at
     or new.source is distinct from old.source then
    raise exception
      'new_client_waitlist_entries: id, studio_id, joined_at and source are immutable'
      using errcode = 'check_violation';
  end if;

  -- NAME AND EMAIL STAY ABSOLUTELY IMMUTABLE. The email is where every future
  -- invitation goes, and there is still no correction command for either.
  if new.name is distinct from old.name
     or new.email is distinct from old.email then
    raise exception
      'new_client_waitlist_entries: name and email are immutable; there is no correction command yet'
      using errcode = 'check_violation';
  end if;

  -- THE MOBILE IS ONE-WAY, AND THIS IS THE CLAUSE THE SLICE TURNS ON.
  -- Absent may become present exactly once, which is what lets a legacy
  -- completion collect a candidate. Present may never become a DIFFERENT number
  -- and may never become absent. `ProfileCompletionPatch` already makes
  -- replacement unsayable in TypeScript; this makes it unwritable in the
  -- database, so a later command cannot reintroduce it by accident.
  if old.phone is not null and new.phone is distinct from old.phone then
    raise exception
      'new_client_waitlist_entries: a stored mobile may not be replaced or cleared'
      using errcode = 'check_violation';
  end if;

  -- AN OPT-OUT IS TERMINAL. Nothing clears it, re-times it, or re-attributes
  -- it. A later consent cannot resurrect sendability.
  if old.sms_opted_out_at is not null
     and (new.sms_opted_out_at    is distinct from old.sms_opted_out_at
          or new.sms_opt_out_source is distinct from old.sms_opt_out_source) then
    raise exception
      'new_client_waitlist_entries: an opt-out is terminal and its evidence is immutable'
      using errcode = 'check_violation';
  end if;

  -- CONSENT EVIDENCE IS WRITE-ONCE (0208). It records an act at a time by a
  -- named route, so it may be ADDED once and never changed, re-attributed,
  -- re-timed or removed. Withdrawal is not an edit: it is `sms_opted_out_at`,
  -- terminal above. This makes "preserve existing consent evidence" a property
  -- of the table rather than of every command remembering it.
  if old.sms_consent_at is not null
     and (new.sms_consent_at                          is distinct from old.sms_consent_at
          or new.sms_consent_source                   is distinct from old.sms_consent_source
          or new.sms_consent_text_version             is distinct from old.sms_consent_text_version
          or new.sms_consent_recorded_by_practitioner_id
                                                      is distinct from old.sms_consent_recorded_by_practitioner_id
          or new.sms_consent_scope                    is distinct from old.sms_consent_scope
          or new.sms_consent_evidence_ref             is distinct from old.sms_consent_evidence_ref
          or new.sms_consent_given_on                 is distinct from old.sms_consent_given_on) then
    raise exception
      'new_client_waitlist_entries: consent evidence is write-once; it may be added, never changed or removed'
      using errcode = 'check_violation';
  end if;

  -- VERIFICATION NOW HAS EXACTLY ONE WRITER, AND THIS IS THE CLAUSE 0202 SAID
  -- WOULD BE AMENDED. It is amended, not removed.
  --
  -- The permit is a row-scoped transaction-local GUC set by
  -- `mark_waitlist_mobile_verified` immediately before its UPDATE, following the
  -- pattern 0120 established for finalized clinical records. Three properties
  -- make it a narrow authority rather than general write access:
  --
  --   1. ROW-SCOPED. A permit for entry A grants nothing over entry B, even in
  --      the same transaction.
  --   2. STRUCTURALLY UNREACHABLE FROM A REST CLIENT. PostgREST gives each
  --      request its own transaction and no way to compose `set_config` with a
  --      write, so only a DEFINER body can hold both. No role holds DML on this
  --      table anyway (0185 revoked ALL from every role including service_role).
  --   3. ONE DIRECTION ONLY. NULL may become an instant. A verified instant may
  --      never move and may never return to NULL: possession proved once is not
  --      un-proved by a later write, and a re-verification that could re-stamp
  --      would let the timestamp drift away from the proof it records.
  if new.mobile_verified_at is distinct from old.mobile_verified_at then
    if old.mobile_verified_at is not null then
      raise exception
        'new_client_waitlist_entries: mobile_verified_at is immutable once proved'
        using errcode = 'check_violation';
    end if;
    if new.mobile_verified_at is null then
      raise exception
        'new_client_waitlist_entries: mobile_verified_at may not be cleared'
        using errcode = 'check_violation';
    end if;
    if coalesce(current_setting('hone.mobile_verified_entry_id', true), '')
       is distinct from new.id::text then
      raise exception
        'new_client_waitlist_entries: mobile_verified_at has exactly one writer, and this is not it'
        using errcode = 'check_violation';
    end if;
  end if;

  if new.status is distinct from old.status then
    v_legal := (old.status, new.status) in (
      ('waiting',  'claimed'),
      ('waiting',  'removed'),
      ('claimed',  'invited'),
      ('claimed',  'released'),
      ('invited',  'converted'),
      ('invited',  'expired'),
      ('invited',  'released'),
      ('expired',  'released'),
      ('expired',  'waiting'),
      ('expired',  'removed'),
      ('released', 'waiting'),
      ('released', 'removed')
    )
    -- 0325: the ONE new edge, keyed to a transaction-local setting only link_waitlist_followup_appointment sets.
    or (old.status = 'waiting' and new.status = 'converted'
        and coalesce(pg_catalog.current_setting('hone.waitlist_manual_link', true), '') = 'on');

    if not v_legal then
      raise exception
        'new_client_waitlist_entries: illegal lifecycle transition % -> % (a claimed or invited entry must be released or expired before removal)',
        old.status, new.status
        using errcode = 'check_violation';
    end if;

    -- ONLY the evidence this transition owns may move.
    v_allowed := case old.status || '->' || new.status
      when 'waiting->claimed'   then array['claimed_at', 'claimed_by_practitioner_id']
      when 'waiting->removed'   then array['removed_at', 'removed_by_practitioner_id']
      when 'claimed->invited'   then array['invited_at']
      when 'claimed->released'  then array['released_at']
      when 'invited->converted' then array['converted_at', 'converted_client_id']
      when 'waiting->converted' then array['claimed_at', 'claimed_by_practitioner_id', 'invited_at',
                                           'converted_at', 'converted_client_id']
      when 'invited->expired'   then array['expired_at']
      when 'invited->released'  then array['released_at']
      when 'expired->released'  then array['released_at']
      when 'expired->removed'   then array['removed_at', 'removed_by_practitioner_id']
      when 'released->removed'  then array['removed_at', 'removed_by_practitioner_id']
      when 'expired->waiting'   then array['claimed_at', 'claimed_by_practitioner_id',
                                           'invited_at', 'expired_at', 'released_at']
      when 'released->waiting'  then array['claimed_at', 'claimed_by_practitioner_id',
                                           'invited_at', 'expired_at', 'released_at']
      else array[]::text[]
    end;

    if not ('claimed_at' = any (v_allowed))
       and new.claimed_at is distinct from old.claimed_at then
      v_bad := v_bad || 'claimed_at'::text;
    end if;
    if not ('claimed_by_practitioner_id' = any (v_allowed))
       and new.claimed_by_practitioner_id is distinct from old.claimed_by_practitioner_id then
      v_bad := v_bad || 'claimed_by_practitioner_id'::text;
    end if;
    if not ('invited_at' = any (v_allowed))
       and new.invited_at is distinct from old.invited_at then
      v_bad := v_bad || 'invited_at'::text;
    end if;
    if not ('expired_at' = any (v_allowed))
       and new.expired_at is distinct from old.expired_at then
      v_bad := v_bad || 'expired_at'::text;
    end if;
    if not ('released_at' = any (v_allowed))
       and new.released_at is distinct from old.released_at then
      v_bad := v_bad || 'released_at'::text;
    end if;
    if not ('converted_at' = any (v_allowed))
       and new.converted_at is distinct from old.converted_at then
      v_bad := v_bad || 'converted_at'::text;
    end if;
    if not ('converted_client_id' = any (v_allowed))
       and new.converted_client_id is distinct from old.converted_client_id then
      v_bad := v_bad || 'converted_client_id'::text;
    end if;
    if not ('removed_at' = any (v_allowed))
       and new.removed_at is distinct from old.removed_at then
      v_bad := v_bad || 'removed_at'::text;
    end if;
    if not ('removed_by_practitioner_id' = any (v_allowed))
       and new.removed_by_practitioner_id is distinct from old.removed_by_practitioner_id then
      v_bad := v_bad || 'removed_by_practitioner_id'::text;
    end if;

    if array_length(v_bad, 1) is not null then
      raise exception
        'new_client_waitlist_entries: transition % -> % may not change %; that evidence belongs to an earlier transition',
        old.status, new.status, array_to_string(v_bad, ', ')
        using errcode = 'check_violation';
    end if;
  else
    -- Status unchanged: the record is frozen. Nothing may be re-attributed,
    -- re-timed, or quietly reverted to NULL.
    if new.claimed_at is distinct from old.claimed_at
       or new.claimed_by_practitioner_id is distinct from old.claimed_by_practitioner_id
       or new.invited_at is distinct from old.invited_at
       or new.expired_at is distinct from old.expired_at
       or new.released_at is distinct from old.released_at
       or new.converted_at is distinct from old.converted_at
       or new.converted_client_id is distinct from old.converted_client_id
       or new.removed_at is distinct from old.removed_at
       or new.removed_by_practitioner_id is distinct from old.removed_by_practitioner_id then
      raise exception
        'new_client_waitlist_entries: lifecycle evidence changes only in the statement that performs a legal transition'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. svc: decline with the two required answers
-- ---------------------------------------------------------------------------
create or replace function public.decline_waitlist_invitation_with_answers(
  p_raw_token      text,
  p_raw_capability text,
  p_why_not_work   text,
  p_better_times   text
)
returns table (result text, invitation_id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  r        record;
  v_inv    uuid;
  v_entry  uuid;
  v_studio uuid;
  v_status text;
  v_now    timestamptz;
  v_why    text;
  v_times  text;
  v_fu     uuid;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$'
     or p_raw_capability is null or p_raw_capability !~ '^[a-f0-9]{64}$' then
    return query select 'invalid_input'::text, null::uuid; return;
  end if;

  v_why   := pg_catalog.btrim(coalesce(p_why_not_work, ''));
  v_times := pg_catalog.btrim(coalesce(p_better_times, ''));
  if pg_catalog.char_length(v_why)   not between 1 and 1000
     or pg_catalog.char_length(v_times) not between 1 and 1000
     or v_why   ~ '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'
     or v_times ~ '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' then
    return query select 'invalid_input'::text, null::uuid; return;
  end if;

  select i.id, i.entry_id, i.studio_id into v_inv, v_entry, v_studio
    from public.new_client_waitlist_invitations i
   where i.token_hash = pg_catalog.encode(extensions.digest(p_raw_token, 'sha256'), 'hex');
  if v_inv is null then return query select 'invalid_token'::text, null::uuid; return; end if;

  -- ENTRY FIRST, THEN INVITATION (0192 decline's order).
  select e.status into v_status
    from public.new_client_waitlist_entries e
   where e.id = v_entry and e.studio_id = v_studio
   for update;

  select * into r from public.new_client_waitlist_invitations i
   where i.id = v_inv
   for update;
  if r.id is null then return query select 'invalid_token'::text, null::uuid; return; end if;

  -- A repeat of the same decline is neutral and writes nothing.
  if exists (select 1 from public.waitlist_followups f where f.invitation_id = v_inv and f.kind = 'decline') then
    return query select 'already_declined'::text, null::uuid; return;
  end if;

  v_now := pg_catalog.clock_timestamp();

  if r.redeemed_at is not null or r.expired_at is not null
     or r.released_at is not null or r.declined_at is not null
     or r.expires_at <= v_now or v_status is distinct from 'invited' then
    return query select 'not_live'::text, null::uuid; return;
  end if;
  if r.proof_capability_hash is null then return query select 'proof_required'::text, null::uuid; return; end if;
  if r.proof_capability_expires_at <= v_now then return query select 'proof_expired'::text, null::uuid; return; end if;
  if r.proof_capability_hash <> pg_catalog.encode(extensions.digest(p_raw_capability, 'sha256'), 'hex') then
    return query select 'proof_invalid'::text, null::uuid; return;
  end if;

  update public.new_client_waitlist_invitations
     set declined_at = v_now,
         proof_capability_hash = null, proof_capability_expires_at = null
   where id = r.id;

  -- invited -> released -> waiting: the SAME row, so joined_at and id (immutable) keep the original place.
  update public.new_client_waitlist_entries
     set status = 'released', released_at = v_now
   where id = v_entry and studio_id = v_studio and status = 'invited';
  update public.new_client_waitlist_entries
     set status = 'waiting',
         claimed_at = null, claimed_by_practitioner_id = null,
         invited_at = null, expired_at = null, released_at = null
   where id = v_entry and studio_id = v_studio and status = 'released';

  insert into public.waitlist_followups (studio_id, entry_id, invitation_id, kind, opened_at)
  values (v_studio, v_entry, v_inv, 'decline', v_now)
  returning id into v_fu;
  insert into public.waitlist_decline_answers (followup_id, studio_id, why_not_work, better_times, submitted_at)
  values (v_fu, v_studio, v_why, v_times, v_now);

  -- The bell row: literals only. No name, email or answer text ever reaches any column.
  insert into public.practitioner_notifications (studio_id, practitioner_id, event_type, title, body, href, dedupe_key)
  values (v_studio, null, 'waitlist_offer_declined', 'A waitlist response needs your attention', '',
          '/settings/waitlist#follow-up', 'waitlist-decline:' || v_inv::text)
  on conflict (studio_id, dedupe_key) where dedupe_key is not null do nothing;

  -- One held outbox row per VERIFIED owner. The sender re-checks the recipient at send time.
  insert into public.waitlist_decline_owner_emails (studio_id, invitation_id, recipient_practitioner_id)
  select v_studio, v_inv, p.id
    from public.practitioners p
    join auth.users u on u.id = p.user_id
   where p.studio_id = v_studio and p.role = 'owner' and p.active = true
     and u.email_confirmed_at is not null
  on conflict on constraint waitlist_decline_owner_emails_pair_key do nothing;

  return query select 'declined'::text, v_inv;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. svc: withdrawal request
-- ---------------------------------------------------------------------------
create or replace function public.request_waitlist_withdrawal(
  p_raw_token      text,
  p_raw_capability text
)
returns table (result text)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  r        record;
  v_inv    uuid;
  v_entry  uuid;
  v_studio uuid;
  v_status text;
  v_now    timestamptz;
  v_fu     uuid;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$'
     or p_raw_capability is null or p_raw_capability !~ '^[a-f0-9]{64}$' then
    return query select 'proof_invalid'::text; return;
  end if;

  select i.id, i.entry_id, i.studio_id into v_inv, v_entry, v_studio
    from public.new_client_waitlist_invitations i
   where i.token_hash = pg_catalog.encode(extensions.digest(p_raw_token, 'sha256'), 'hex');
  -- Unknown token: the same neutral answer as every other no-op.
  if v_inv is null then return query select 'recorded'::text; return; end if;

  select e.status into v_status
    from public.new_client_waitlist_entries e
   where e.id = v_entry and e.studio_id = v_studio
   for update;
  select * into r from public.new_client_waitlist_invitations i where i.id = v_inv for update;

  if v_status is null or v_status in ('removed','converted')
     or exists (select 1 from public.waitlist_followups f
                 where f.entry_id = v_entry and f.kind = 'withdrawal' and f.status = 'open') then
    return query select 'recorded'::text; return;
  end if;

  v_now := pg_catalog.clock_timestamp();
  if r.proof_capability_hash is null then return query select 'proof_required'::text; return; end if;
  if r.proof_capability_expires_at <= v_now then return query select 'proof_expired'::text; return; end if;
  if r.proof_capability_hash <> pg_catalog.encode(extensions.digest(p_raw_capability, 'sha256'), 'hex') then
    return query select 'proof_invalid'::text; return;
  end if;

  -- Close this invitation if it is still live, and release every other live invitation of the entry.
  update public.new_client_waitlist_invitations
     set declined_at = case when id = v_inv then v_now else declined_at end,
         released_at = case when id <> v_inv then v_now else released_at end,
         proof_capability_hash = null, proof_capability_expires_at = null
   where entry_id = v_entry and studio_id = v_studio
     and redeemed_at is null and expired_at is null and released_at is null and declined_at is null
     and expires_at > v_now;

  -- Back to Waiting in the same place (claimed/invited -> released -> waiting; expired -> waiting).
  update public.new_client_waitlist_entries
     set status = 'released', released_at = v_now
   where id = v_entry and studio_id = v_studio and status in ('claimed','invited');
  update public.new_client_waitlist_entries
     set status = 'waiting',
         claimed_at = null, claimed_by_practitioner_id = null,
         invited_at = null, expired_at = null, released_at = null
   where id = v_entry and studio_id = v_studio and status in ('released','expired');

  insert into public.waitlist_followups (studio_id, entry_id, invitation_id, kind, opened_at)
  values (v_studio, v_entry, v_inv, 'withdrawal', v_now)
  returning id into v_fu;

  insert into public.practitioner_notifications (studio_id, practitioner_id, event_type, title, body, href, dedupe_key)
  values (v_studio, null, 'waitlist_withdrawal_requested', 'A waitlist response needs your attention', '',
          '/settings/waitlist#follow-up', 'waitlist-withdrawal:' || v_fu::text)
  on conflict (studio_id, dedupe_key) where dedupe_key is not null do nothing;

  return query select 'recorded'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. owner: reads
-- ---------------------------------------------------------------------------
-- Answers a follow-up shows: its own (decline) or the entry's EARLIER decline answers (withdrawal).
create or replace function public.read_waitlist_followups(
  p_studio_id     uuid,
  p_actor_user_id uuid,
  p_invitation_id uuid default null
)
returns table (followup_id uuid, kind text, entry_id uuid, invitation_id uuid, client_name text, client_email text,
               opened_at timestamptz, status text, why_not_work text, better_times text,
               answers_erased_at timestamptz, submitted_at timestamptz, closed_at timestamptz, erase_by timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid; v_code text;
begin
  select o.practitioner_id, o.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) o;
  if v_code <> 'ok' then return; end if;

  return query
    select f.id, f.kind, f.entry_id, f.invitation_id, e.name, e.email,
           f.opened_at, f.status, a.why_not_work, a.better_times,
           a.erased_at, a.submitted_at, f.closed_at,
           case when a.followup_id is null or a.erased_at is not null then null
                else least(
                       case when f.closed_at is null then null else f.closed_at + interval '30 days' end,
                       a.submitted_at + interval '90 days')
           end
      from public.waitlist_followups f
      join public.new_client_waitlist_entries e on e.id = f.entry_id and e.studio_id = f.studio_id
      left join lateral (
        select a2.* from public.waitlist_decline_answers a2
          join public.waitlist_followups d on d.id = a2.followup_id
         where d.entry_id = f.entry_id and d.kind = 'decline'
           and (f.kind = 'decline' and d.id = f.id or f.kind = 'withdrawal')
         order by a2.submitted_at desc
         limit 1) a on true
     where f.studio_id = p_studio_id
       and (case when p_invitation_id is null then f.status = 'open' else f.invitation_id = p_invitation_id end)
     order by f.opened_at, f.id
     limit 500;
end;
$$;

create or replace function public.read_waitlist_followup_status(
  p_studio_id      uuid,
  p_actor_user_id  uuid,
  p_invitation_ids uuid[]
)
returns table (invitation_id uuid, status text)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid; v_code text;
begin
  select o.practitioner_id, o.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) o;
  if v_code <> 'ok' or p_invitation_ids is null then return; end if;
  -- REFUSED, not truncated: a silent truncation would read as "no follow-up". The message is value-free and says nothing about any id.
  if pg_catalog.cardinality(p_invitation_ids) > 500 then
    raise exception 'read_waitlist_followup_status: at most 500 invitation ids per call' using errcode = '22023';
  end if;
  -- One row per id that has a follow-up IN THIS STUDIO; any other id returns nothing, never an error.
  return query
    select distinct on (f.invitation_id) f.invitation_id, f.status
      from public.waitlist_followups f
     where f.studio_id = p_studio_id and f.invitation_id = any (p_invitation_ids)
     order by f.invitation_id, f.opened_at desc, f.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. owner: resolve, link, erase
-- ---------------------------------------------------------------------------
create or replace function public.mark_waitlist_decline_handled(
  p_studio_id uuid, p_actor_user_id uuid, p_followup_id uuid)
returns table (result text)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid; v_code text; v_entry uuid; v_status text;
begin
  select o.practitioner_id, o.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) o;
  if v_code <> 'ok' then return query select 'not_owner'::text; return; end if;
  select f.entry_id into v_entry from public.waitlist_followups f
   where f.id = p_followup_id and f.studio_id = p_studio_id and f.kind = 'decline';
  if v_entry is null then return query select 'not_found'::text; return; end if;
  perform 1 from public.new_client_waitlist_entries e where e.id = v_entry and e.studio_id = p_studio_id for update;
  select f.status into v_status from public.waitlist_followups f where f.id = p_followup_id for update;
  if v_status = 'handled' then return query select 'already_handled'::text; return; end if;
  if v_status <> 'open' then return query select 'already_closed'::text; return; end if;
  update public.waitlist_followups
     set status = 'handled', closed_at = pg_catalog.clock_timestamp(), closed_by_practitioner_id = v_actor
   where id = p_followup_id;
  return query select 'handled'::text;
end;
$$;

create or replace function public.keep_waitlist_withdrawal(
  p_studio_id uuid, p_actor_user_id uuid, p_followup_id uuid)
returns table (result text)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid; v_code text; v_entry uuid; v_status text;
begin
  select o.practitioner_id, o.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) o;
  if v_code <> 'ok' then return query select 'not_owner'::text; return; end if;
  select f.entry_id into v_entry from public.waitlist_followups f
   where f.id = p_followup_id and f.studio_id = p_studio_id and f.kind = 'withdrawal';
  if v_entry is null then return query select 'not_found'::text; return; end if;
  perform 1 from public.new_client_waitlist_entries e where e.id = v_entry and e.studio_id = p_studio_id for update;
  select f.status into v_status from public.waitlist_followups f where f.id = p_followup_id for update;
  if v_status <> 'open' then return query select 'already_resolved'::text; return; end if;
  update public.waitlist_followups
     set status = 'kept', closed_at = pg_catalog.clock_timestamp(), closed_by_practitioner_id = v_actor
   where id = p_followup_id;
  return query select 'kept'::text;
end;
$$;

create or replace function public.link_waitlist_followup_appointment(
  p_studio_id uuid, p_actor_user_id uuid, p_followup_id uuid, p_appointment_id uuid)
returns table (result text)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid; v_code text; v_entry uuid; v_fstatus text;
  v_estatus text; v_email text; v_apt record; v_now timestamptz;
begin
  select o.practitioner_id, o.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) o;
  if v_code <> 'ok' then return query select 'not_owner'::text; return; end if;
  if p_followup_id is null or p_appointment_id is null then return query select 'not_found'::text; return; end if;

  select f.entry_id into v_entry from public.waitlist_followups f
   where f.id = p_followup_id and f.studio_id = p_studio_id;
  if v_entry is null then return query select 'not_found'::text; return; end if;

  select e.status, e.email_normalized into v_estatus, v_email
    from public.new_client_waitlist_entries e
   where e.id = v_entry and e.studio_id = p_studio_id for update;
  select f.status into v_fstatus from public.waitlist_followups f where f.id = p_followup_id for update;

  if v_fstatus = 'booked' then return query select 'already_booked'::text; return; end if;
  if v_estatus is distinct from 'waiting' then return query select 'entry_not_waiting'::text; return; end if;
  if v_fstatus <> 'open' then return query select 'not_found'::text; return; end if;

  select a.id, a.status, a.client_id, lower(btrim(c.email)) as client_email into v_apt
    from public.appointments a
    left join public.clients c on c.id = a.client_id and c.studio_id = a.studio_id
   where a.id = p_appointment_id and a.studio_id = p_studio_id;
  if v_apt.id is null then return query select 'appointment_not_found'::text; return; end if;
  if v_apt.client_id is null or v_apt.client_email is distinct from v_email then
    return query select 'appointment_mismatch'::text; return;
  end if;
  if v_apt.status = 'cancelled' then return query select 'appointment_not_bookable'::text; return; end if;
  if exists (select 1 from public.waitlist_followups f where f.appointment_id = p_appointment_id) then
    return query select 'appointment_already_linked'::text; return;
  end if;

  v_now := pg_catalog.clock_timestamp();
  perform pg_catalog.set_config('hone.waitlist_manual_link', 'on', true);
  update public.new_client_waitlist_entries
     set status = 'converted', converted_at = v_now, converted_client_id = v_apt.client_id,
         claimed_at = v_now, claimed_by_practitioner_id = v_actor, invited_at = v_now
   where id = v_entry and studio_id = p_studio_id and status = 'waiting';
  perform pg_catalog.set_config('hone.waitlist_manual_link', 'off', true);

  update public.new_client_waitlist_invitations
     set released_at = v_now
   where entry_id = v_entry and studio_id = p_studio_id
     and redeemed_at is null and expired_at is null and released_at is null and declined_at is null;

  update public.waitlist_followups
     set status = 'booked', closed_at = v_now, closed_by_practitioner_id = v_actor, appointment_id = p_appointment_id
   where id = p_followup_id;
  -- Any other open follow-up of the entry is resolved by the same booking.
  update public.waitlist_followups
     set status = 'booked', closed_at = v_now, closed_by_practitioner_id = v_actor
   where entry_id = v_entry and studio_id = p_studio_id and status = 'open' and id <> p_followup_id;

  return query select 'booked'::text;
end;
$$;

create or replace function public.erase_waitlist_decline_answers(
  p_studio_id uuid, p_actor_user_id uuid, p_followup_id uuid)
returns table (result text)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid; v_code text; v_entry uuid; v_n int; v_total int; v_now timestamptz;
begin
  select o.practitioner_id, o.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) o;
  if v_code <> 'ok' then return query select 'not_owner'::text; return; end if;
  select f.entry_id into v_entry from public.waitlist_followups f
   where f.id = p_followup_id and f.studio_id = p_studio_id;
  if v_entry is null then return query select 'not_found'::text; return; end if;
  perform 1 from public.new_client_waitlist_entries e where e.id = v_entry and e.studio_id = p_studio_id for update;

  select count(*) into v_total
    from public.waitlist_decline_answers a join public.waitlist_followups d on d.id = a.followup_id
   where d.entry_id = v_entry and d.studio_id = p_studio_id;
  if v_total = 0 then return query select 'not_found'::text; return; end if;

  v_now := pg_catalog.clock_timestamp();
  with erased as (
    update public.waitlist_decline_answers a
       set why_not_work = null, better_times = null, erased_at = v_now, erased_by_practitioner_id = v_actor
      from public.waitlist_followups d
     where a.followup_id = d.id and d.entry_id = v_entry and d.studio_id = p_studio_id and a.erased_at is null
    returning a.followup_id, d.kind
  ), logged as (
    insert into public.waitlist_erase_records (studio_id, followup_id, kind, erased_at, erased_by_practitioner_id, reason)
    select p_studio_id, e.followup_id, e.kind, v_now, v_actor, 'owner_erase' from erased e
    on conflict (followup_id, reason) do nothing
    returning 1
  )
  select count(*) into v_n from erased;

  return query select case when v_n > 0 then 'erased' else 'already_erased' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Remove erases (C1): AFTER UPDATE trigger on entry status -> removed, same transaction
-- ---------------------------------------------------------------------------
create or replace function public.new_client_waitlist_entries_erase_on_remove()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if new.status = 'removed' and old.status is distinct from 'removed' then
    update public.waitlist_followups
       set status = 'removed', closed_at = v_now, closed_by_practitioner_id = new.removed_by_practitioner_id
     where entry_id = new.id and studio_id = new.studio_id and status = 'open';

    with erased as (
      update public.waitlist_decline_answers a
         set why_not_work = null, better_times = null, erased_at = v_now,
             erased_by_practitioner_id = new.removed_by_practitioner_id
        from public.waitlist_followups d
       where a.followup_id = d.id and d.entry_id = new.id and d.studio_id = new.studio_id and a.erased_at is null
      returning a.followup_id, d.kind
    )
    insert into public.waitlist_erase_records (studio_id, followup_id, kind, erased_at, erased_by_practitioner_id, reason)
    select new.studio_id, e.followup_id, e.kind, v_now, new.removed_by_practitioner_id, 'removed' from erased e
    on conflict (followup_id, reason) do nothing;
  end if;
  return null;
end;
$$;

drop trigger if exists new_client_waitlist_entries_erase_on_remove on public.new_client_waitlist_entries;
create trigger new_client_waitlist_entries_erase_on_remove
  after update of status on public.new_client_waitlist_entries
  for each row execute function public.new_client_waitlist_entries_erase_on_remove();

-- ---------------------------------------------------------------------------
-- 8. Grants, restated BY NAME for all three default grantees
-- ---------------------------------------------------------------------------
revoke all on function public.decline_waitlist_invitation_with_answers(text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.request_waitlist_withdrawal(text, text) from public, anon, authenticated, service_role;
revoke all on function public.read_waitlist_followups(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.read_waitlist_followup_status(uuid, uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.mark_waitlist_decline_handled(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.keep_waitlist_withdrawal(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.link_waitlist_followup_appointment(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.erase_waitlist_decline_answers(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.new_client_waitlist_entries_erase_on_remove() from public, anon, authenticated, service_role;
grant execute on function public.decline_waitlist_invitation_with_answers(text, text, text, text) to service_role;
grant execute on function public.request_waitlist_withdrawal(text, text) to service_role;
grant execute on function public.read_waitlist_followups(uuid, uuid, uuid) to service_role;
grant execute on function public.read_waitlist_followup_status(uuid, uuid, uuid[]) to service_role;
grant execute on function public.mark_waitlist_decline_handled(uuid, uuid, uuid) to service_role;
grant execute on function public.keep_waitlist_withdrawal(uuid, uuid, uuid) to service_role;
grant execute on function public.link_waitlist_followup_appointment(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.erase_waitlist_decline_answers(uuid, uuid, uuid) to service_role;

commit;
