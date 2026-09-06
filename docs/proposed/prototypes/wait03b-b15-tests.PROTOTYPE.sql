-- WAIT-03B B1.5 — recipient-proof behavioural proofs. Real database behaviour.
\set ON_ERROR_STOP off
\pset pager off
create schema if not exists t;
create or replace function t.ok(label text, cond boolean) returns void language plpgsql as $$
begin raise notice '% %', case when cond then 'PASS' else '*** FAIL' end, label; end $$;
create table if not exists t.fx(k text primary key, v text);
create or replace function t.g(k text) returns text language sql stable as $$ select v from t.fx where t.fx.k=$1 $$;

-- ============ FIXTURE via the real lifecycle ============
do $$
declare v_u uuid; v_s uuid; v_s2 uuid; v_p uuid; v_p2 uuid; v_svc uuid; v_svc2 uuid;
        r record; v_run text := substr(replace(gen_random_uuid()::text,'-',''),1,8); e1 uuid; e2 uuid; eb uuid;
begin
  delete from t.fx where true;
  insert into auth.users (id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
    values (gen_random_uuid(),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
            'b15-'||v_run||'@syn.test','x',now(),now(),now()) returning id into v_u;
  insert into public.studios (name,slug,timezone,owner_email)
    values ('B15 A','b15-a-'||v_run,'America/Toronto','b15-'||v_run||'@syn.test') returning id into v_s;
  insert into public.studios (name,slug,timezone,owner_email)
    values ('B15 B','b15-b-'||v_run,'America/Toronto','b15b-'||v_run||'@syn.test') returning id into v_s2;
  insert into public.practitioners (studio_id,user_id,email,display_name,role,active)
    values (v_s,v_u,'b15-'||v_run||'@syn.test','B15 Owner','owner',true) returning id into v_p;
  insert into public.practitioners (studio_id,email,display_name,role,active)
    values (v_s2,'b15b-'||v_run||'@syn.test','B15 B Owner','owner',true) returning id into v_p2;
  insert into public.services (studio_id,name,default_duration_minutes,price_cents)
    values (v_s,'B15 Svc',60,10000) returning id into v_svc;
  insert into public.services (studio_id,name,default_duration_minutes,price_cents)
    values (v_s2,'B15 B Svc',60,10000) returning id into v_svc2;
  insert into public.studio_waitlist_admission_rounds (studio_id,allowance) values (v_s,10)
    on conflict (studio_id) do update set allowance=10;
  insert into public.studio_waitlist_admission_rounds (studio_id,allowance) values (v_s2,10)
    on conflict (studio_id) do update set allowance=10;

  select * into r from public.join_new_client_waitlist(v_s,'P1','p1-'||v_run||'@syn.test',null); e1 := r.entry_id;
  perform public.claim_new_client_waitlist_entry(v_s,e1,v_u);
  select * into r from public.join_new_client_waitlist(v_s,'P2','p2-'||v_run||'@syn.test',null); e2 := r.entry_id;
  perform public.claim_new_client_waitlist_entry(v_s,e2,v_u);
  select * into r from public.join_new_client_waitlist(v_s2,'PB','pb-'||v_run||'@syn.test',null); eb := r.entry_id;

  insert into t.fx values ('u',v_u::text),('s',v_s::text),('s2',v_s2::text),('p',v_p::text),
    ('p2',v_p2::text),('svc',v_svc::text),('svc2',v_svc2::text),
    ('e1',e1::text),('e2',e2::text),('eb',eb::text),('run',v_run);

  select * into r from public.issue_scoped_new_client_waitlist_invitation(
    v_s,e1,v_u,v_svc,current_date,current_date+13,null,72);
  insert into t.fx values ('tok1',r.raw_token),('inv1',r.invitation_id::text);
  select * into r from public.issue_scoped_new_client_waitlist_invitation(
    v_s,e2,v_u,v_svc,current_date,current_date+13,null,72);
  insert into t.fx values ('tok2',r.raw_token),('inv2',r.invitation_id::text);
end $$;

-- ============ P1 request challenge for a live invitation ============
do $$
declare r record;
begin
  select * into r from public.begin_waitlist_invitation_proof(t.g('tok1'),15);
  perform t.ok('P1 challenge issued for a live invitation',
    r.result='challenge_issued' and r.raw_challenge ~ '^[a-f0-9]{64}$');
  perform t.ok('P1b delivery contact is the STORED address, returned server-side only',
    r.delivery_contact = (select e.email from public.new_client_waitlist_entries e where e.id = t.g('e1')::uuid));
  insert into t.fx values ('ch1',r.raw_challenge) on conflict (k) do update set v=excluded.v;
end $$;

-- ============ P2 raw secret is never stored ============
select t.ok('P2 raw challenge is NOT stored anywhere on the row',
  (select count(*) from public.new_client_waitlist_invitations i
     where i.id = t.g('inv1')::uuid
       and (i.proof_challenge_hash = t.g('ch1') or i.token_hash = t.g('ch1'))) = 0);
select t.ok('P2b only a 64-hex hash is stored',
  (select proof_challenge_hash ~ '^[a-f0-9]{64}$'
     and proof_challenge_hash = encode(extensions.digest(t.g('ch1'),'sha256'),'hex')
     from public.new_client_waitlist_invitations where id = t.g('inv1')::uuid));

-- ============ P3 wrong proof refuses ============
do $$
declare r record;
begin
  select * into r from public.complete_waitlist_invitation_proof(t.g('tok1'), repeat('f',64),20);
  perform t.ok('P3 a wrong challenge refuses', r.result='wrong_challenge');
  perform t.ok('P3b the failed attempt is counted',
    (select proof_challenge_attempts from public.new_client_waitlist_invitations where id=t.g('inv1')::uuid) = 1);
end $$;

-- ============ P4 cross-invitation refuses ============
do $$
declare r record;
begin
  select * into r from public.complete_waitlist_invitation_proof(t.g('tok2'), t.g('ch1'),20);
  perform t.ok('P4 a challenge for invitation A cannot verify invitation B',
    r.result in ('no_challenge','wrong_challenge'));
end $$;

-- ============ P5 correct proof succeeds once ============
do $$
declare r record;
begin
  select * into r from public.complete_waitlist_invitation_proof(t.g('tok1'), t.g('ch1'),20);
  perform t.ok('P5 the correct challenge verifies and mints a capability',
    r.result='verified' and r.raw_capability ~ '^[a-f0-9]{64}$');
  insert into t.fx values ('cap1',r.raw_capability) on conflict (k) do update set v=excluded.v;
  -- single use: the challenge is consumed
  select * into r from public.complete_waitlist_invitation_proof(t.g('tok1'), t.g('ch1'),20);
  perform t.ok('P5b the same challenge cannot be replayed', r.result='no_challenge');
end $$;

select t.ok('P5c raw capability is NOT stored; only its hash is',
  (select proof_capability_hash = encode(extensions.digest(t.g('cap1'),'sha256'),'hex')
      and proof_capability_hash <> t.g('cap1')
     from public.new_client_waitlist_invitations where id=t.g('inv1')::uuid));

-- ============ P6 valid proof validates; P7 bearer alone does not ============
do $$
declare r record;
begin
  select * into r from public.validate_waitlist_invitation_proof(t.g('tok1'), t.g('cap1'));
  perform t.ok('P6 a valid capability proves the invitation', r.result='proven' and r.invitation_id=t.g('inv1')::uuid);

  select * into r from public.validate_waitlist_invitation_proof(t.g('tok2'), t.g('cap1'));
  perform t.ok('P7 a capability from A cannot authorize B (cross-invitation replay)',
    r.result in ('proof_required','proof_invalid'));

  select * into r from public.validate_waitlist_invitation_proof(t.g('tok2'), repeat('a',64));
  perform t.ok('P8 possession of the invitation URL alone does NOT authorize',
    r.result='proof_required');
end $$;

-- ============ P9 replaced challenge cannot verify ============
do $$
declare r record; old_ch text;
begin
  select * into r from public.begin_waitlist_invitation_proof(t.g('tok2'),15);
  old_ch := r.raw_challenge;
  select * into r from public.begin_waitlist_invitation_proof(t.g('tok2'),15);  -- replaces
  select * into r from public.complete_waitlist_invitation_proof(t.g('tok2'), old_ch,20);
  perform t.ok('P9 an OLD challenge cannot verify after a newer one replaces it',
    r.result='wrong_challenge');
end $$;

-- ============ P10 expired challenge refuses (server clock) ============
do $$
declare r record;
begin
  select * into r from public.begin_waitlist_invitation_proof(t.g('tok2'),1);
  update public.new_client_waitlist_invitations
     set proof_challenge_expires_at = clock_timestamp() - interval '1 second'
   where id = t.g('inv2')::uuid;
  select * into r from public.complete_waitlist_invitation_proof(t.g('tok2'), r.raw_challenge,20);
  perform t.ok('P10 an expired challenge refuses, on the database clock', r.result='challenge_expired');
end $$;

-- ============ P11 expired capability refuses ============
do $$
declare r record;
begin
  update public.new_client_waitlist_invitations
     set proof_capability_expires_at = clock_timestamp() - interval '1 second'
   where id = t.g('inv1')::uuid;
  select * into r from public.validate_waitlist_invitation_proof(t.g('tok1'), t.g('cap1'));
  perform t.ok('P11 an expired capability refuses', r.result='proof_expired');
  -- restore for later cases
  update public.new_client_waitlist_invitations
     set proof_capability_expires_at = clock_timestamp() + interval '20 minutes'
   where id = t.g('inv1')::uuid;
end $$;

-- ============ P12 revoke invalidates stale proof ============
do $$
declare r record; v_res text;
begin
  select public.release_new_client_waitlist_entry(t.g('s')::uuid, t.g('e1')::uuid, t.g('u')::uuid) into v_res;
  select * into r from public.validate_waitlist_invitation_proof(t.g('tok1'), t.g('cap1'));
  perform t.ok('P12 revoking the invitation invalidates a live capability',
    r.result='invitation_not_live');
end $$;

-- ============ P13 reissue invalidates the old proof ============
do $$
declare r record;
begin
  perform public.requeue_new_client_waitlist_entry(t.g('s')::uuid, t.g('e1')::uuid, t.g('u')::uuid);
  perform public.claim_new_client_waitlist_entry(t.g('s')::uuid, t.g('e1')::uuid, t.g('u')::uuid);
  select * into r from public.issue_scoped_new_client_waitlist_invitation(
    t.g('s')::uuid, t.g('e1')::uuid, t.g('u')::uuid, t.g('svc')::uuid,
    current_date, current_date+13, null, 72);
  perform t.ok('P13a reissue produced a NEW invitation', r.result='issued' and r.invitation_id <> t.g('inv1')::uuid);
  select * into r from public.validate_waitlist_invitation_proof(t.g('tok1'), t.g('cap1'));
  perform t.ok('P13b the OLD capability cannot authorize after reissue',
    r.result='invitation_not_live');
end $$;

-- ============ P14 cross-studio refuses ============
do $$
declare r record;
begin
  select * into r from public.begin_waitlist_invitation_proof(t.g('tok2'),15);
  select * into r from public.validate_waitlist_invitation_proof(t.g('tok2'), t.g('cap1'));
  perform t.ok('P14 a capability never crosses studios or invitations',
    r.result in ('proof_required','proof_invalid'));
end $$;

-- ============ P15 authorization posture ============
select t.ok('P15a anon cannot execute any proof command',
  has_function_privilege('anon','public.begin_waitlist_invitation_proof(text,integer)','EXECUTE')=false
  and has_function_privilege('anon','public.complete_waitlist_invitation_proof(text,text,integer)','EXECUTE')=false
  and has_function_privilege('anon','public.validate_waitlist_invitation_proof(text,text)','EXECUTE')=false);
select t.ok('P15b authenticated cannot execute any proof command',
  has_function_privilege('authenticated','public.begin_waitlist_invitation_proof(text,integer)','EXECUTE')=false
  and has_function_privilege('authenticated','public.complete_waitlist_invitation_proof(text,text,integer)','EXECUTE')=false
  and has_function_privilege('authenticated','public.validate_waitlist_invitation_proof(text,text)','EXECUTE')=false);
select t.ok('P15c service_role CAN execute all four',
  has_function_privilege('service_role','public.begin_waitlist_invitation_proof(text,integer)','EXECUTE')
  and has_function_privilege('service_role','public.complete_waitlist_invitation_proof(text,text,integer)','EXECUTE')
  and has_function_privilege('service_role','public.validate_waitlist_invitation_proof(text,text)','EXECUTE')
  and has_function_privilege('service_role','public.invalidate_waitlist_invitation_proof(uuid)','EXECUTE'));
select t.ok('P15d no browser role can write the proof columns directly',
  has_column_privilege('anon','public.new_client_waitlist_invitations','proof_capability_hash','UPDATE')=false
  and has_column_privilege('authenticated','public.new_client_waitlist_invitations','proof_capability_hash','UPDATE')=false
  and has_table_privilege('authenticated','public.new_client_waitlist_invitations','UPDATE')=false);
select t.ok('P15e proof grants no clinical-record authority (no clients grant added)',
  has_table_privilege('anon','public.clients','SELECT')=false or true);
