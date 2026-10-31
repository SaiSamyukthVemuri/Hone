-- 0254: PERM-HON44 role enforcement in the database (Sam decision 12, 2026-10-25).
-- Reserved to PERM-HON44 (Team). MERGE IS HELD behind 0213-0250; this file
-- assumes the 0246 chain. Hosted apply stays held.
--
-- The APP half is a separate migration-free PR (owner-only gates in the server
-- actions). This is the DATABASE half, so a raw PostgREST call by a studio member
-- meets the same refusals the app does:
--
--   1. Financial READS are owner-only: payment_charge_attempts,
--      manual_fee_charge_attempts and appointment_settlements. Their
--      "member read" policies called is_studio_member(), which is role-blind.
--   2. Price WRITES are owner-only: set_session_price (session price) and the
--      client_pricing insert/update/delete policies. Reading client prices stays
--      member-wide (a practitioner quotes from them).
--   3. Recording a settlement is owner-only: record_appointment_settlement now
--      answers a non-owner with the closed code 'owner_only' (the waived path
--      already did). Waive and supersede were owner-only.
--   4. Pinned cautions: DELETE is owner-only (policy); EDIT is a command,
--      edit_client_pinned_note, that lets a practitioner edit only a caution they
--      created and the owner edit any. It replaces the service-role UPDATE the
--      app used, which no policy could constrain.
--   5. AUDIT: price changes (session and client), pinned-caution edit and delete.
--      Written by SECURITY DEFINER code, so it keeps working after 0242 revokes
--      member INSERT on audit_logs. Amounts are NOT recorded: audit_logs is
--      readable by every member.
--
-- The two function replacements below are the chain's own definitions (0167 and
-- 0187) with the owner check (and the audit row) added. CREATE OR REPLACE keeps
-- their grants; the closing assertions re-prove them.
--
-- DELIBERATELY NOT DONE, stated so nobody reads silence as a decision:
--   * services.price_cents stays readable by every member. A practitioner
--     quotes and books from the service price list, and a column privilege cannot
--     tell an owner from a practitioner (both are role authenticated). A member can
--     therefore still derive a booked-value figure from appointments x services
--     through the API; hiding that needs an owner-only price view plus a
--     price-free read for booking, a product decision.
--   * client_payment_methods keeps its current read policy (the app reads it
--     with the service role only).
--   * Staff invitations, the receptionist role and hosted apply are held.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Financial reads: owner-only.
-- ---------------------------------------------------------------------------
drop policy if exists "payment_charge_attempts_member_read" on public.payment_charge_attempts;
drop policy if exists "payment_charge_attempts_owner_read" on public.payment_charge_attempts;
create policy "payment_charge_attempts_owner_read"
  on public.payment_charge_attempts for select to authenticated
  using (public.is_studio_owner(studio_id));

drop policy if exists "manual_fee_charge_attempts_member_read" on public.manual_fee_charge_attempts;
drop policy if exists "manual_fee_charge_attempts_owner_read" on public.manual_fee_charge_attempts;
create policy "manual_fee_charge_attempts_owner_read"
  on public.manual_fee_charge_attempts for select to authenticated
  using (public.is_studio_owner(studio_id));

drop policy if exists "appointment_settlements_member_select" on public.appointment_settlements;
drop policy if exists "appointment_settlements_owner_select" on public.appointment_settlements;
create policy "appointment_settlements_owner_select"
  on public.appointment_settlements for select to authenticated
  using (public.is_studio_owner(studio_id));

-- ---------------------------------------------------------------------------
-- 2. Client price writes: owner-only (read stays member-wide).
-- ---------------------------------------------------------------------------
drop policy if exists "client_pricing: members insert" on public.client_pricing;
drop policy if exists "client_pricing: members update" on public.client_pricing;
drop policy if exists "client_pricing: members delete" on public.client_pricing;
drop policy if exists "client_pricing: owner insert" on public.client_pricing;
drop policy if exists "client_pricing: owner update" on public.client_pricing;
drop policy if exists "client_pricing: owner delete" on public.client_pricing;
create policy "client_pricing: owner insert"
  on public.client_pricing for insert to authenticated
  with check (public.is_studio_owner(studio_id));
create policy "client_pricing: owner update"
  on public.client_pricing for update to authenticated
  using (public.is_studio_owner(studio_id))
  with check (public.is_studio_owner(studio_id));
create policy "client_pricing: owner delete"
  on public.client_pricing for delete to authenticated
  using (public.is_studio_owner(studio_id));

-- ---------------------------------------------------------------------------
-- 3. Session price and settlement recording: the chain's commands, owner-checked.
-- ---------------------------------------------------------------------------
create or replace function public.set_session_price(
  p_session_id  uuid,
  p_client_id   uuid,
  p_price_cents integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id uuid;
  v_actor     uuid;
  v_before    integer;
begin
  v_studio_id := public.assert_session_writable(p_session_id, p_client_id);

  -- HON-44 (Sam decision 12): price changes are OWNER-ONLY, decided here from
  -- auth.uid() through is_studio_owner, never from anything the caller sends.
  if not public.is_studio_owner(v_studio_id) then
    raise exception 'Only the studio owner can change prices.' using errcode = 'insufficient_privilege';
  end if;
  v_actor := public.session_actor_practitioner(v_studio_id);

  if p_price_cents is not null and p_price_cents < 0 then
    raise exception 'Price must be a non-negative number.' using errcode = 'check_violation';
  end if;

  select s.price_paid_cents into v_before
    from public.sessions s
   where s.id = p_session_id and s.studio_id = v_studio_id;

  update public.sessions s
     set price_paid_cents = p_price_cents
   where s.id = p_session_id
     and s.studio_id = v_studio_id;

  -- Audited WITHOUT the amounts: audit_logs is readable by every member, and a
  -- practitioner must not learn a price from the trail of a price they cannot see.
  insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
  values (v_studio_id, v_actor, 'session_price_set', 'session', p_session_id,
          pg_catalog.jsonb_build_object(
            'client_id', p_client_id,
            'cleared', p_price_cents is null,
            'changed', v_before is distinct from p_price_cents));
end;
$$;

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
  v_quoted       integer;
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

  -- HON-44 (Sam decision 12): recording what a client paid is a financial act and
  -- is OWNER-ONLY. Decided before the appointment is looked at, so a
  -- non-owner learns nothing about it. Same closed code the waived path uses.
  if not public.is_studio_owner(p_studio_id) then
    return query select 'owner_only'::text, null::uuid, null::timestamptz;
    return;
  end if;

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

  -- ---------------------------------------------------------------------
  -- SIDE-EFFECT ORDERING. EVERY REFUSAL IS DECIDED BEFORE ANYTHING IS WRITTEN.
  --
  -- The first draft retired the prepared card attempt and only then asked
  -- whether the settlement could be recorded. A refusal below is a plain
  -- `return query` — a NORMAL RETURN, which COMMITS — so a practitioner could
  -- be told `card_payment_exists` or `already_settled` while her prepared
  -- charge had already been silently cancelled. Reachable in ordinary use:
  -- payment_charge_attempts_active_session_payment_uniq is scoped to
  -- (session_id, stripe_livemode), so one appointment can legitimately carry a
  -- ready attempt on one session and a pending_stripe or succeeded attempt on
  -- another, or across two modes.
  --
  -- So retirement is now the LAST thing before the insert, and every refusal
  -- happens above it. A refused settlement mutates ZERO payment-charge rows.
  -- If the insert itself raises, the transaction rolls back and the retirement
  -- goes with it.
  -- ---------------------------------------------------------------------
  -- 1. IS THIS VISIT ALREADY SETTLED? Asked directly rather than inferred from
  --    a unique-index conflict after the fact, because by then the retirement
  --    would already have happened.
  select t.id, t.recorded_at into v_id, v_at
    from public.appointment_settlements t
   where t.studio_id = p_studio_id
     and t.appointment_id = p_appointment_id
     and t.superseded_at is null
   limit 1;
  if v_id is not null then
    return query select 'already_settled'::text, v_id, v_at;
    return;
  end if;

  -- 2. CARD MONEY THAT CANNOT BE RETIRED. pending_stripe is in flight;
  --    succeeded-and-retained is money Hone holds; a ready row carrying
  --    execution evidence is not safely "merely prepared".
  if public.appointment_has_live_card_money(p_studio_id, p_appointment_id, coalesce(p_livemode, true)) then
    return query select 'card_payment_exists'::text, null::uuid, null::timestamptz;
    return;
  end if;

  -- 3. THE SERVICE-VALUE SNAPSHOT, derived ONCE into a local. Called a second
  --    time it could return a different number than the one validated, because
  --    pricing is ordinary mutable data.
  v_quoted := public.appointment_quoted_amount_cents(p_studio_id, p_appointment_id);
  if v_quoted is not null and (v_quoted < 0 or v_quoted > 200000) then
    -- A RESOLVED price outside this column's domain. NOT clamped, because
    -- 200000 would be a fabricated service value in the number FIN-01A divides
    -- by; NOT nulled, because NULL means "could not be resolved" and this price
    -- resolved perfectly well. A closed refusal instead, so the table CHECK is
    -- never the control flow and no raw database error reaches a practitioner.
    return query select 'invalid_input'::text, null::uuid, null::timestamptz;
    return;
  end if;

  -- 4. ONLY NOW. Choosing a non-card outcome is the decision not to use the
  --    prepared charge, and by this point the settlement WILL be written.
  perform public.retire_ready_card_attempts(
    p_studio_id, p_appointment_id, v_practitioner);

  insert into public.appointment_settlements (
    studio_id, appointment_id, method, amount_cents,
    quoted_amount_cents, recorded_by_practitioner_id, note
  )
  values (
    p_studio_id, p_appointment_id, p_method, p_amount_cents,
    -- The value validated above, not a second call: pricing is mutable, and a
    -- re-derivation could store a number that was never checked.
    v_quoted,
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
-- 4. Pinned cautions: owner-only delete, author-or-owner edit command.
-- ---------------------------------------------------------------------------
drop policy if exists "client_pinned_notes_studio_member_delete" on public.client_pinned_notes;
drop policy if exists "client_pinned_notes_owner_delete" on public.client_pinned_notes;
create policy "client_pinned_notes_owner_delete"
  on public.client_pinned_notes for delete to authenticated
  using (public.is_studio_owner(studio_id));

create function public.edit_client_pinned_note(
  p_studio_id     uuid,
  p_client_id     uuid,
  p_note_id       uuid,
  p_original_text text,
  p_text          text
) returns boolean
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_actor uuid;
  v_role  text;
  v_rows  integer;
begin
  if p_studio_id is null or p_client_id is null or p_note_id is null
     or p_original_text is null or p_text is null then
    return false;
  end if;
  if pg_catalog.length(p_text) < 1 or pg_catalog.length(p_text) > 200 then
    return false;
  end if;

  -- The caller is derived from auth.uid() and the NAMED studio, never supplied.
  -- No row, an inactive row, or no session all answer false, the same answer a
  -- missing or stale note gets, so nothing about who wrote a caution is disclosed.
  select p.id, p.role into v_actor, v_role
    from public.practitioners p
   where p.user_id = auth.uid()
     and p.studio_id = p_studio_id
     and p.active is true;
  if v_actor is null then
    return false;
  end if;

  update public.client_pinned_notes n
     set text = p_text
   where n.id = p_note_id
     and n.studio_id = p_studio_id
     and n.client_id = p_client_id
     and n.text = p_original_text
     and (v_role = 'owner' or n.created_by_practitioner_id = v_actor);
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return false;
  end if;

  insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_studio_id, v_actor, 'pinned_note_edited', 'client_pinned_note', p_note_id,
          pg_catalog.jsonb_build_object('client_id', p_client_id));
  return true;
end;
$$;

revoke all on function public.edit_client_pinned_note(uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.edit_client_pinned_note(uuid, uuid, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Audit triggers for caution deletion and client price changes. A row is
--    written only for a signed-in member's own action: a system job, a service
--    role call and a studio cascade have no auth.uid() and no audit row, and
--    the studio-exists guard keeps a cascade from tripping the audit foreign key.
-- ---------------------------------------------------------------------------
create function public.audit_pinned_note_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  if auth.uid() is null then
    return old;
  end if;
  select p.id into v_actor
    from public.practitioners p
   where p.user_id = auth.uid() and p.studio_id = old.studio_id and p.active is true;
  if v_actor is not null
     and exists (select 1 from public.studios s where s.id = old.studio_id) then
    insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
    values (old.studio_id, v_actor, 'pinned_note_deleted', 'client_pinned_note', old.id,
            pg_catalog.jsonb_build_object('client_id', old.client_id));
  end if;
  return old;
end;
$$;

revoke all on function public.audit_pinned_note_delete() from public, anon, authenticated, service_role;

drop trigger if exists client_pinned_notes_audit_delete_trg on public.client_pinned_notes;
create trigger client_pinned_notes_audit_delete_trg
  after delete on public.client_pinned_notes
  for each row execute function public.audit_pinned_note_delete();

create function public.audit_client_pricing_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid;
  v_studio uuid := case when tg_op = 'DELETE' then old.studio_id else new.studio_id end;
  v_client uuid := case when tg_op = 'DELETE' then old.client_id else new.client_id end;
  v_entity uuid := case when tg_op = 'DELETE' then old.id else new.id end;
begin
  if auth.uid() is null then
    return null;
  end if;
  select p.id into v_actor
    from public.practitioners p
   where p.user_id = auth.uid() and p.studio_id = v_studio and p.active is true;
  if v_actor is not null
     and exists (select 1 from public.studios s where s.id = v_studio) then
    insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
    values (v_studio, v_actor,
            case when tg_op = 'DELETE' then 'client_price_removed' else 'client_price_set' end,
            'client_pricing', v_entity,
            pg_catalog.jsonb_build_object('client_id', v_client, 'operation', pg_catalog.lower(tg_op)));
  end if;
  return null;
end;
$$;

revoke all on function public.audit_client_pricing_change() from public, anon, authenticated, service_role;

drop trigger if exists client_pricing_audit_trg on public.client_pricing;
create trigger client_pricing_audit_trg
  after insert or update or delete on public.client_pricing
  for each row execute function public.audit_client_pricing_change();

-- ---------------------------------------------------------------------------
-- 6. Assertions. Any failure aborts the whole transaction.
-- ---------------------------------------------------------------------------
do $$
declare
  v_table pg_catalog.text;
  v_rel pg_catalog.regclass;
  v_pol record;
  v_expr pg_catalog.text;
  v_sig pg_catalog.text;
begin
  -- (a) Every policy that can READ the three financial tables is owner-gated.
  foreach v_table in array array['payment_charge_attempts', 'manual_fee_charge_attempts', 'appointment_settlements'] loop
    v_rel := pg_catalog.to_regclass('public.' || v_table);
    if v_rel is null then raise exception '0254: public.% is missing', v_table; end if;
    for v_pol in select pol.polname, pol.polcmd, pol.polpermissive,
                        coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') as q
                   from pg_catalog.pg_policy pol
                  where pol.polrelid = v_rel and pol.polcmd in ('r', '*')
    loop
      v_expr := pg_catalog.lower(v_pol.q);
      if v_expr !~ 'is_studio_owner\(' or v_expr ~ 'is_studio_member\(' then
        raise exception '0254: policy % on public.% can read for a non-owner', v_pol.polname, v_table;
      end if;
    end loop;
    if not exists (select 1 from pg_catalog.pg_policy pol where pol.polrelid = v_rel and pol.polcmd = 'r') then
      raise exception '0254: public.% lost its owner read policy', v_table;
    end if;
  end loop;

  -- (b) Every WRITE-capable policy on client_pricing and the DELETE path on
  --     pinned cautions is owner-gated; no member-wide write remains.
  for v_pol in select c.relname, pol.polname,
                      lower(coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
                            coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '')) as e
                 from pg_catalog.pg_policy pol
                 join pg_catalog.pg_class c on c.oid = pol.polrelid
                where c.relnamespace = 'public'::pg_catalog.regnamespace
                  and ((c.relname = 'client_pricing' and pol.polcmd in ('a', 'w', 'd', '*'))
                    or (c.relname = 'client_pinned_notes' and pol.polcmd in ('d', '*')))
  loop
    if v_pol.e !~ 'is_studio_owner\(' then
      raise exception '0254: policy % on public.% is not owner-gated', v_pol.polname, v_pol.relname;
    end if;
  end loop;

  -- (c) Function privileges. The replaced commands keep authenticated and gain
  --     nothing; the new command is authenticated-only; the trigger functions
  --     are executable by nobody.
  foreach v_sig in array array[
    'public.set_session_price(uuid, uuid, integer)',
    'public.record_appointment_settlement(uuid, uuid, text, integer, text, boolean)',
    'public.edit_client_pinned_note(uuid, uuid, uuid, text, text)'
  ] loop
    if not pg_catalog.has_function_privilege('authenticated', pg_catalog.to_regprocedure(v_sig), 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', pg_catalog.to_regprocedure(v_sig), 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', pg_catalog.to_regprocedure(v_sig), 'EXECUTE') then
      raise exception '0254: unexpected EXECUTE privileges on %', v_sig;
    end if;
    if exists (
      select 1 from pg_catalog.pg_proc p,
        lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
       where p.oid = pg_catalog.to_regprocedure(v_sig) and a.privilege_type = 'EXECUTE' and a.grantee = 0
    ) then
      raise exception '0254: PUBLIC can execute %', v_sig;
    end if;
  end loop;

  foreach v_sig in array array['public.audit_pinned_note_delete()', 'public.audit_client_pricing_change()'] loop
    if pg_catalog.has_function_privilege('anon', pg_catalog.to_regprocedure(v_sig), 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', pg_catalog.to_regprocedure(v_sig), 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', pg_catalog.to_regprocedure(v_sig), 'EXECUTE') then
      raise exception '0254: trigger function % is executable by a runtime role', v_sig;
    end if;
  end loop;

  -- (d) The three definer functions pin their search_path.
  foreach v_sig in array array[
    'public.set_session_price(uuid, uuid, integer)',
    'public.record_appointment_settlement(uuid, uuid, text, integer, text, boolean)',
    'public.edit_client_pinned_note(uuid, uuid, uuid, text, text)',
    'public.audit_pinned_note_delete()',
    'public.audit_client_pricing_change()'
  ] loop
    if not exists (
      select 1 from pg_catalog.pg_proc p
       where p.oid = pg_catalog.to_regprocedure(v_sig) and p.prosecdef
         and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
    ) then
      raise exception '0254: % is not a definer function with a pinned search_path', v_sig;
    end if;
  end loop;
end;
$$;

commit;
