-- ===========================================================================
-- NNNN: PER-NUMBER SMS CONSENT EVIDENCE AND PER-NUMBER OPT-OUT
-- ===========================================================================
--
-- WHAT THIS IS. Two append-only tables and one read helper.
--   * sms_number_consents: which NUMBER a consent was recorded for, written at
--     the moment consent is recorded, for clients and waitlist entries.
--   * sms_number_opt_outs: a STOP, keyed by the normalized number alone, so it
--     holds across studios and does not depend on any client or entry row.
--   * waitlist_sms_number_consented(entry, number): true when that entry
--     consented for that number and the number has not opted out.
--
-- WHAT THIS DOES NOT DO. It changes no existing gate. Appointment texts, the
-- reminder candidate selection and passesConsentGate are untouched, and no
-- existing function body is redefined: the evidence is written by AFTER
-- triggers, so every writer of a consent (booking, waitlist, operator SQL) is
-- covered without editing it. Existing client consents get no row, because
-- nothing in the database says which number they were given for.
--
-- WAITLIST ROWS CARRY FORWARD. A waitlist entry's number is set once and never
-- replaced, so an existing waitlist consent with a number is evidence for that
-- number. Those rows are written with source 'carried_forward_waitlist'.
--
-- OPT-OUT BACKFILL OVER-SUPPRESSES ON PURPOSE. Every number held by an
-- opted-out client or entry becomes an opt-out row; a wrong extra suppression
-- is the safe direction.
begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.sms_number_consents (
  id                 uuid primary key default gen_random_uuid(),
  studio_id          uuid not null references public.studios(id) on delete cascade,
  client_id          uuid references public.clients(id) on delete cascade,
  waitlist_entry_id  uuid references public.new_client_waitlist_entries(id) on delete cascade,
  phone_e164         text not null,
  consented_at       timestamptz not null,
  source             text not null,
  text_version       text,
  recorded_at        timestamptz not null default now(),
  constraint sms_number_consents_one_subject_ck
    check ((client_id is null) <> (waitlist_entry_id is null)),
  constraint sms_number_consents_phone_shape_ck
    check (phone_e164 ~ '^\+[0-9]{8,15}$'),
  constraint sms_number_consents_source_ck
    check (source ~ '^[a-z][a-z0-9_]{2,63}$')
);
create unique index sms_number_consents_client_number_uq
  on public.sms_number_consents (client_id, phone_e164) where client_id is not null;
create unique index sms_number_consents_entry_number_uq
  on public.sms_number_consents (waitlist_entry_id, phone_e164) where waitlist_entry_id is not null;

create table public.sms_number_opt_outs (
  phone_e164   text primary key,
  opted_out_at timestamptz not null,
  source       text not null,
  recorded_at  timestamptz not null default now(),
  constraint sms_number_opt_outs_phone_shape_ck
    check (phone_e164 ~ '^\+[0-9]{8,15}$'),
  constraint sms_number_opt_outs_source_ck
    check (source ~ '^[a-z][a-z0-9_]{2,63}$')
);

alter table public.sms_number_consents enable row level security;
alter table public.sms_number_opt_outs enable row level security;
revoke all on public.sms_number_consents from public, anon, authenticated, service_role;
revoke all on public.sms_number_opt_outs from public, anon, authenticated, service_role;

comment on table public.sms_number_consents is
  'Append-only evidence of the number an SMS consent was recorded for. No application role has any privilege; written by triggers and the migration, read by definer functions. Rows are never updated; they disappear only when the client or waitlist entry they belong to is deleted.';
comment on table public.sms_number_opt_outs is
  'Append-only STOP list keyed by normalized number, across all studios. No application role has any privilege. Rows are never updated or deleted.';

-- ---------------------------------------------------------------------------
-- 2. Append-only guards
-- ---------------------------------------------------------------------------
create function public.sms_number_evidence_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'check_violation';
end;
$$;
revoke execute on function public.sms_number_evidence_append_only() from public, anon, authenticated, service_role;

create trigger sms_number_consents_no_update
  before update on public.sms_number_consents
  for each row execute function public.sms_number_evidence_append_only();
create trigger sms_number_opt_outs_no_change
  before update or delete on public.sms_number_opt_outs
  for each row execute function public.sms_number_evidence_append_only();
-- TRUNCATE bypasses row triggers, so it is refused by its own statement-level guard.
create trigger sms_number_consents_no_truncate
  before truncate on public.sms_number_consents
  for each statement execute function public.sms_number_evidence_append_only();
create trigger sms_number_opt_outs_no_truncate
  before truncate on public.sms_number_opt_outs
  for each statement execute function public.sms_number_evidence_append_only();

-- ---------------------------------------------------------------------------
-- 3. Writers: AFTER triggers on the existing consent and opt-out columns
-- ---------------------------------------------------------------------------
create function public.sms_number_record_client_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number text := public.sms_normalized_phone(new.phone);
begin
  if v_number is not null
     and new.sms_consent_at is not null
     and (tg_op = 'INSERT' or old.sms_consent_at is null) then
    insert into public.sms_number_consents
      (studio_id, client_id, phone_e164, consented_at, source)
    values
      (new.studio_id, new.id, v_number, new.sms_consent_at,
       coalesce(nullif(new.sms_consent_source, ''), 'unknown'))
    on conflict do nothing;
  end if;
  if v_number is not null
     and new.sms_opted_out_at is not null
     and (tg_op = 'INSERT' or old.sms_opted_out_at is null) then
    insert into public.sms_number_opt_outs (phone_e164, opted_out_at, source)
    values (v_number, new.sms_opted_out_at,
            coalesce(nullif(new.sms_opt_out_source, ''), 'unknown'))
    on conflict do nothing;
  end if;
  return null;
end;
$$;

create function public.sms_number_record_entry_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number text := public.sms_normalized_phone(new.phone);
begin
  if v_number is not null
     and new.sms_consent_at is not null
     and (tg_op = 'INSERT' or old.sms_consent_at is null) then
    insert into public.sms_number_consents
      (studio_id, waitlist_entry_id, phone_e164, consented_at, source, text_version)
    values
      (new.studio_id, new.id, v_number, new.sms_consent_at,
       coalesce(nullif(new.sms_consent_source, ''), 'unknown'),
       new.sms_consent_text_version)
    on conflict do nothing;
  end if;
  if v_number is not null
     and new.sms_opted_out_at is not null
     and (tg_op = 'INSERT' or old.sms_opted_out_at is null) then
    insert into public.sms_number_opt_outs (phone_e164, opted_out_at, source)
    values (v_number, new.sms_opted_out_at,
            coalesce(nullif(new.sms_opt_out_source, ''), 'unknown'))
    on conflict do nothing;
  end if;
  return null;
end;
$$;
revoke execute on function public.sms_number_record_client_events() from public, anon, authenticated, service_role;
revoke execute on function public.sms_number_record_entry_events() from public, anon, authenticated, service_role;

create trigger clients_sms_number_events
  after insert or update of sms_consent_at, sms_opted_out_at, phone on public.clients
  for each row execute function public.sms_number_record_client_events();
create trigger new_client_waitlist_entries_sms_number_events
  after insert or update of sms_consent_at, sms_opted_out_at, phone on public.new_client_waitlist_entries
  for each row execute function public.sms_number_record_entry_events();

-- ---------------------------------------------------------------------------
-- 4. Commands
-- ---------------------------------------------------------------------------
-- A STOP for a number no client or entry holds still has to be remembered.
create function public.record_sms_number_opt_out(p_phone text, p_source text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_number text := public.sms_normalized_phone(p_phone);
begin
  if v_number is null or p_source is null or p_source !~ '^[a-z][a-z0-9_]{2,63}$' then
    return false;
  end if;
  insert into public.sms_number_opt_outs (phone_e164, opted_out_at, source)
  values (v_number, clock_timestamp(), p_source)
  on conflict do nothing;
  return true;
end;
$$;

create function public.waitlist_sms_number_consented(p_entry_id uuid, p_number text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_number text := public.sms_normalized_phone(p_number);
begin
  if p_entry_id is null or v_number is null then
    return false;
  end if;
  if exists (select 1 from public.sms_number_opt_outs o where o.phone_e164 = v_number) then
    return false;
  end if;
  return exists (
    select 1 from public.sms_number_consents c
     where c.waitlist_entry_id = p_entry_id
       and c.phone_e164 = v_number
  );
end;
$$;

revoke execute on function public.record_sms_number_opt_out(text, text) from public, anon, authenticated, service_role;
grant  execute on function public.record_sms_number_opt_out(text, text) to service_role;
revoke execute on function public.waitlist_sms_number_consented(uuid, text) from public, anon, authenticated, service_role;
grant  execute on function public.waitlist_sms_number_consented(uuid, text) to service_role;

comment on function public.record_sms_number_opt_out(text, text) is
  'Records a STOP for a normalized number, across all studios. Returns false for a number that cannot be addressed. Service role only.';
comment on function public.waitlist_sms_number_consented(uuid, text) is
  'True when the waitlist entry consented for exactly this normalized number and the number has no opt-out. A pure read; service role only.';

-- ---------------------------------------------------------------------------
-- 5. Backfill
-- ---------------------------------------------------------------------------
insert into public.sms_number_consents
  (studio_id, waitlist_entry_id, phone_e164, consented_at, source, text_version)
select e.studio_id, e.id, public.sms_normalized_phone(e.phone), e.sms_consent_at,
       'carried_forward_waitlist', e.sms_consent_text_version
  from public.new_client_waitlist_entries e
 where e.sms_consent_at is not null
   and public.sms_normalized_phone(e.phone) is not null
on conflict do nothing;

insert into public.sms_number_opt_outs (phone_e164, opted_out_at, source)
select n, min(at), 'carried_forward'
  from (
    select public.sms_normalized_phone(c.phone) as n, c.sms_opted_out_at as at
      from public.clients c where c.sms_opted_out_at is not null
    union all
    select public.sms_normalized_phone(e.phone), e.sms_opted_out_at
      from public.new_client_waitlist_entries e where e.sms_opted_out_at is not null
  ) s
 where n is not null
 group by n
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 6. A waitlist consent needs a number
-- ---------------------------------------------------------------------------
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_consent_needs_phone_ck
  check (sms_consent_at is null or phone is not null) not valid;
alter table public.new_client_waitlist_entries
  validate constraint new_client_waitlist_entries_consent_needs_phone_ck;

commit;
