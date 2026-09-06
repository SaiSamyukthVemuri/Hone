-- WAIT-03B B1.5b — proof-gate proofs. These test the MUTATION, not the oracle.
-- The reviewed suite's P8 asserted validate_() refuses a bearer, which proves
-- only that the oracle refuses. Every gate case below attempts the actual
-- mutating command and asserts the ROW DID NOT CHANGE.
\set ON_ERROR_STOP off
\pset pager off
create schema if not exists t;
create or replace function t.ok(label text, cond boolean) returns void language plpgsql as $$
begin raise notice '% %', case when cond then 'PASS' else '*** FAIL' end, label; end $$;
create table if not exists t.fx(k text primary key, v text);
create or replace function t.g(k text) returns text language sql stable as $$ select v from t.fx where t.fx.k=$1 $$;

-- ============ FIXTURE: TWO STUDIOS, both with live invitations AND capabilities
do $$
declare v_u uuid; v_ub uuid; v_s uuid; v_s2 uuid; v_p uuid; v_p2 uuid; v_svc uuid; v_svc2 uuid;
        r record; run text := substr(replace(gen_random_uuid()::text,'-',''),1,8);
        e1 uuid; e2 uuid; e3 uuid; eb uuid; ch text;
begin
  delete from t.fx where true;
  insert into auth.users (id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
    values (gen_random_uuid(),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
            'g-'||run||'@syn.test','x',now(),now(),now()) returning id into v_u;
  insert into auth.users (id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
    values (gen_random_uuid(),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
            'gb-'||run||'@syn.test','x',now(),now(),now()) returning id into v_ub;
  insert into public.studios (name,slug,timezone,owner_email)
    values ('G A','g-a-'||run,'America/Toronto','g-'||run||'@syn.test') returning id into v_s;
  insert into public.studios (name,slug,timezone,owner_email)
    values ('G B','g-b-'||run,'America/Toronto','gb-'||run||'@syn.test') returning id into v_s2;
  insert into public.practitioners (studio_id,user_id,email,display_name,role,active)
    values (v_s,v_u,'g-'||run||'@syn.test','GA','owner',true) returning id into v_p;
  -- studio B gets a REAL practitioner with a REAL user, so it can actually issue.
  insert into public.practitioners (studio_id,user_id,email,display_name,role,active)
    values (v_s2,v_ub,'gb-'||run||'@syn.test','GB','owner',true) returning id into v_p2;
  insert into public.services (studio_id,name,default_duration_minutes,price_cents)
    values (v_s,'GA Svc',60,10000) returning id into v_svc;
  insert into public.services (studio_id,name,default_duration_minutes,price_cents)
    values (v_s2,'GB Svc',60,10000) returning id into v_svc2;
  insert into public.studio_waitlist_admission_rounds (studio_id,allowance) values (v_s,10)
    on conflict (studio_id) do update set allowance=10;
  insert into public.studio_waitlist_admission_rounds (studio_id,allowance) values (v_s2,10)
    on conflict (studio_id) do update set allowance=10;

  select * into r from public.join_new_client_waitlist(v_s,'A1','a1-'||run||'@syn.test',null); e1:=r.entry_id;
  perform public.claim_new_client_waitlist_entry(v_s,e1,v_u);
  select * into r from public.join_new_client_waitlist(v_s,'A2','a2-'||run||'@syn.test',null); e2:=r.entry_id;
  perform public.claim_new_client_waitlist_entry(v_s,e2,v_u);
  select * into r from public.join_new_client_waitlist(v_s,'A3','a3-'||run||'@syn.test',null); e3:=r.entry_id;
  perform public.claim_new_client_waitlist_entry(v_s,e3,v_u);
  select * into r from public.join_new_client_waitlist(v_s2,'B1','b1-'||run||'@syn.test',null); eb:=r.entry_id;
  perform public.claim_new_client_waitlist_entry(v_s2,eb,v_ub);

  insert into t.fx values ('s',v_s::text),('s2',v_s2::text),('u',v_u::text),('ub',v_ub::text),
    ('svc',v_svc::text),('svc2',v_svc2::text),('e1',e1::text),('e2',e2::text),('e3',e3::text),('eb',eb::text),('run',run);

  select * into r from public.issue_scoped_new_client_waitlist_invitation(v_s,e1,v_u,v_svc,current_date,current_date+13,null,72);
  insert into t.fx values ('tokA',r.raw_token),('invA',r.invitation_id::text);
  select * into r from public.issue_scoped_new_client_waitlist_invitation(v_s,e2,v_u,v_svc,current_date,current_date+13,null,72);
  insert into t.fx values ('tokA2',r.raw_token),('invA2',r.invitation_id::text);
  select * into r from public.issue_scoped_new_client_waitlist_invitation(v_s2,eb,v_ub,v_svc2,current_date,current_date+13,null,72);
  insert into t.fx values ('tokB',r.raw_token),('invB',r.invitation_id::text);
  select * into r from public.issue_scoped_new_client_waitlist_invitation(v_s,e3,v_u,v_svc,current_date,current_date+13,null,72);
  insert into t.fx values ('tokC',r.raw_token),('invC',r.invitation_id::text);

  -- Give A2 and B their OWN live capabilities, so cross-tests hit the HASH
  -- COMPARE branch rather than the trivial "no capability" early return.
  select raw_challenge into ch from public.begin_waitlist_invitation_proof(t.g('tokA2'),15);
  select * into r from public.complete_waitlist_invitation_proof(t.g('tokA2'),ch,20);
  insert into t.fx values ('capA2',r.raw_capability);
  select raw_challenge into ch from public.begin_waitlist_invitation_proof(t.g('tokB'),15);
  select * into r from public.complete_waitlist_invitation_proof(t.g('tokB'),ch,20);
  insert into t.fx values ('capB',r.raw_capability);
end $$;

-- ============ G1. THE P0 FIX: bearer alone cannot MUTATE ============
do $$
declare r record; before_redeemed timestamptz; before_declined timestamptz;
begin
  select redeemed_at, declined_at into before_redeemed, before_declined
    from public.new_client_waitlist_invitations where id=t.g('invA')::uuid;

  -- invA has NO capability. Attempt the real mutations with a bearer token.
  select * into r from public.redeem_new_client_waitlist_invitation_verified(t.g('tokA'), repeat('a',64));
  perform t.ok('G1a bearer-only REDEEM is refused', r.result='proof_required');
  perform t.ok('G1b the invitation row was NOT redeemed',
    (select redeemed_at from public.new_client_waitlist_invitations where id=t.g('invA')::uuid)
      is not distinct from before_redeemed);

  select * into r from public.decline_new_client_waitlist_invitation(t.g('tokA'), repeat('a',64));
  perform t.ok('G1c bearer-only DECLINE is refused', r.result='proof_required');
  perform t.ok('G1d the invitation row was NOT declined',
    (select declined_at from public.new_client_waitlist_invitations where id=t.g('invA')::uuid)
      is not distinct from before_declined);
end $$;

-- the ungated applied command must be unreachable
select t.ok('G1e the UNGATED redeem_(text) is executable by NO role',
  has_function_privilege('service_role','public.redeem_new_client_waitlist_invitation(text)','EXECUTE')=false
  and has_function_privilege('authenticated','public.redeem_new_client_waitlist_invitation(text)','EXECUTE')=false
  and has_function_privilege('anon','public.redeem_new_client_waitlist_invitation(text)','EXECUTE')=false);
select t.ok('G1f no bare-token decline signature survives',
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='decline_new_client_waitlist_invitation'
      and pg_get_function_identity_arguments(p.oid)='text') = 0);

-- ============ G2. Valid proof DOES permit the mutation ============
do $$
declare r record; ch text;
begin
  select raw_challenge into ch from public.begin_waitlist_invitation_proof(t.g('tokA'),15);
  select * into r from public.complete_waitlist_invitation_proof(t.g('tokA'),ch,20);
  insert into t.fx values ('capA',r.raw_capability) on conflict (k) do update set v=excluded.v;
  select * into r from public.redeem_new_client_waitlist_invitation_verified(t.g('tokA'), t.g('capA'));
  perform t.ok('G2a a VALID capability permits redemption', r.result='redeemed');
  perform t.ok('G2b the row is now redeemed',
    (select redeemed_at is not null from public.new_client_waitlist_invitations where id=t.g('invA')::uuid));
  perform t.ok('G2c the capability is consumed by use',
    (select proof_capability_hash is null from public.new_client_waitlist_invitations where id=t.g('invA')::uuid));
end $$;

-- ============ G3. P2-3/P2-4 fixed: REAL cross-studio, on the hash branch ====
do $$
declare r record;
begin
  -- capB is a LIVE capability for studio B; tokA2 is a LIVE invitation in
  -- studio A that ALSO holds its own live capability. This reaches the hash
  -- comparison, not an early "no capability" return.
  select * into r from public.redeem_new_client_waitlist_invitation_verified(t.g('tokA2'), t.g('capB'));
  perform t.ok('G3a a studio-B capability cannot redeem a studio-A invitation',
    r.result='proof_invalid');
  select * into r from public.decline_new_client_waitlist_invitation(t.g('tokB'), t.g('capA2'));
  perform t.ok('G3b a studio-A capability cannot decline a studio-B invitation',
    r.result='proof_invalid');
  perform t.ok('G3c neither row mutated',
    (select redeemed_at is null from public.new_client_waitlist_invitations where id=t.g('invA2')::uuid)
    and (select declined_at is null from public.new_client_waitlist_invitations where id=t.g('invB')::uuid));
end $$;

-- ============ G4. P1-2: the frozen recipient hash is READ -- and the path it
-- defends is already closed upstream ======================================
do $$
declare r record; ch text; blocked boolean := false;
begin
  -- G4a. The threat P1-2 describes (retarget an invitation by editing the
  -- entry's contact) is not reachable in this release AT ALL: entry contact is
  -- immutable. Prove that upstream defence instead of assuming it.
  begin
    update public.new_client_waitlist_entries
       set email = 'retargeted-'||t.g('run')||'@syn.test' where id = t.g('e2')::uuid;
  exception when others then blocked := true;
  end;
  perform t.ok('G4a entry contact is immutable, so retargeting is unreachable upstream', blocked);

  -- G4b. The comparison must still be live and falsifiable. Diverge the FROZEN
  -- PROOF COLUMN -- B1.5 prototype state, which the 0188 append-only trigger
  -- does not enumerate -- rather than bypassing any production constraint.
  select raw_challenge into ch from public.begin_waitlist_invitation_proof(t.g('tokA2'),15);
  update public.new_client_waitlist_invitations
     set proof_challenge_sent_to_hash =
         encode(extensions.digest('someone-else-'||t.g('run')||'@syn.test','sha256'),'hex')
   where id = t.g('invA2')::uuid;
  select * into r from public.complete_waitlist_invitation_proof(t.g('tokA2'),ch,20);
  perform t.ok('G4b a challenge cannot verify once the frozen recipient diverges',
    r.result='recipient_changed');
end $$;

-- ============ G5. P1-3: complete_ bounds its TTL like begin_ ============
do $$
declare r record; ch text;
begin
  select raw_challenge into ch from public.begin_waitlist_invitation_proof(t.g('tokB'),15);
  select * into r from public.complete_waitlist_invitation_proof(t.g('tokB'),ch,525600);
  perform t.ok('G5a an absurd TTL is refused as typed input, not minted',
    r.result='invalid_input');
  select * into r from public.complete_waitlist_invitation_proof(t.g('tokB'),ch,null);
  perform t.ok('G5b a NULL TTL returns invalid_input, not a raw 23514',
    r.result='invalid_input');
  select * into r from public.complete_waitlist_invitation_proof(t.g('tokB'),ch,20);
  perform t.ok('G5c a bounded TTL still verifies', r.result='verified');
end $$;

-- ============ G6. P2-2 fixed: falsifiable, and scoped to what B1.5b owns ===
-- The reviewed suite asserted `X or true`. The first replacement over-asserted
-- in the other direction: it claimed anon holds no clinical SELECT at all,
-- which is FALSE here for reasons that predate this slice (see G6d).
-- B1.5b grants nothing to any browser role -- it only revokes -- so the honest
-- assertion is that no browser role can reach the proof gate or its state.
select t.ok('G6a no browser role can execute the proof commands',
  has_function_privilege('anon','public.complete_waitlist_invitation_proof(text,text,integer)','EXECUTE')=false
  and has_function_privilege('authenticated','public.complete_waitlist_invitation_proof(text,text,integer)','EXECUTE')=false
  and has_function_privilege('anon','public.redeem_new_client_waitlist_invitation_verified(text,text)','EXECUTE')=false
  and has_function_privilege('authenticated','public.redeem_new_client_waitlist_invitation_verified(text,text)','EXECUTE')=false
  and has_function_privilege('anon','public.decline_new_client_waitlist_invitation(text,text)','EXECUTE')=false
  and has_function_privilege('authenticated','public.decline_new_client_waitlist_invitation(text,text)','EXECUTE')=false);

select t.ok('G6b no browser role can read the stored proof state',
  has_table_privilege('anon','public.new_client_waitlist_invitations','SELECT')=false
  and has_table_privilege('authenticated','public.new_client_waitlist_invitations','SELECT')=false);

select t.ok('G6c the ungated applied redeem is unreachable from every role',
  has_function_privilege('anon','public.redeem_new_client_waitlist_invitation(text)','EXECUTE')=false
  and has_function_privilege('authenticated','public.redeem_new_client_waitlist_invitation(text)','EXECUTE')=false
  and has_function_privilege('service_role','public.redeem_new_client_waitlist_invitation(text)','EXECUTE')=false);

-- G6d. OBSERVED, NOT ASSERTED. anon holds SELECT on clinical tables in this
-- stack. That is inherited from the applied chain -- B1.5/B1.5b contain zero
-- grants to anon or authenticated -- and RLS carries the boundary there. It is
-- recorded so the delta review sees it; it is NOT this slice's to fix.
do $$
begin
  raise notice 'OBSERVED (inherited, not introduced by B1.5b): anon SELECT clients=% sessions=%',
    has_table_privilege('anon','public.clients','SELECT'),
    has_table_privilege('anon','public.sessions','SELECT');
end $$;

-- ============ G7. Capability expiry proven through the bounded proof
-- lifecycle and authoritative DB time -- no expiry column is edited =========
-- Invitation WALL-CLOCK expiry is deliberately NOT tested here: 0188 freezes
-- expires_at (append-only trigger), its CHECK forbids expires_at <= issued_at,
-- and issue takes p_ttl_HOURS -- so no expired invitation can be materialised
-- through public authority inside a test run. Recorded as a proof limitation
-- rather than bypassed.
do $$
declare r record; ch text; cap text;
begin
  select raw_challenge into ch from public.begin_waitlist_invitation_proof(t.g('tokC'),15);
  select * into r from public.complete_waitlist_invitation_proof(t.g('tokC'),ch,1);
  perform t.ok('G7a a 1-minute capability -- the minimum legal TTL -- mints', r.result='verified');
  cap := r.raw_capability;
  perform pg_sleep(61);
  select * into r from public.redeem_new_client_waitlist_invitation_verified(t.g('tokC'), cap);
  perform t.ok('G7b an elapsed capability no longer permits the mutation', r.result='proof_expired');
  perform t.ok('G7c and the invitation is still unredeemed',
    (select redeemed_at is null from public.new_client_waitlist_invitations where id=t.g('invC')::uuid));
end $$;
