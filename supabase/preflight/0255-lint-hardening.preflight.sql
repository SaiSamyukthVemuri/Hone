-- 0255 S1 PREFLIGHT. READ-ONLY. COUNTS AND FLAGS ONLY.
--
-- Not run by the migration and never run by an agent against hosted: the
-- operator runs each numbered statement separately under the S1 GO, one at a
-- time, and records the output. No statement here selects a value from either
-- form table (only count(*)); the function and role sections read catalog
-- metadata. Nothing is written.
--
-- 1. Rows that WOULD violate each 0255 CHECK (a NOT VALID check still binds
--    UPDATE and COPY, so any non-zero count must be cleaned, or the constraint
--    left NOT VALID with the restore step in the recovery plan, before the
--    validate script runs). The expressions are byte-for-byte the constraints'.
select 'waitlist_email_format_chk' as constraint_name, count(*) as violating_rows
  from public.waitlist
 where (char_length(email) between 3 and 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') is false;

select 'waitlist_field_length_chk' as constraint_name, count(*) as violating_rows
  from public.waitlist
 where (char_length(practice_name) <= 300 and char_length(source) <= 40) is false;

select 'demo_requests_email_format_chk' as constraint_name, count(*) as violating_rows
  from public.demo_requests
 where (char_length(email) between 3 and 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') is false;

select 'demo_requests_field_length_chk' as constraint_name, count(*) as violating_rows
  from public.demo_requests
 where (char_length(name) between 1 and 200
      and char_length(practice_name) <= 300
      and char_length(location) <= 300
      and char_length(current_tool) <= 300
      and char_length(notes) <= 5000
      and char_length(status) <= 40) is false;

-- 2. Owner, definer flag, config and ACL of the 21 functions 0255 alters or
--    revokes on (ALTER FUNCTION and REVOKE need the migration role to own
--    them). A signature that does not exist shows exists = false.
select s.sig,
       to_regprocedure(s.sig) is not null as fn_exists,
       p.proowner::regrole::text as owner,
       p.prosecdef as security_definer,
       p.proconfig as config,
       p.proacl::text as acl
  from unnest(array[
  'public.set_updated_at()',
  'public.reject_payment_consents_mutation()',
  'public.reject_payment_audit_mutation()',
  'public.set_updated_at_now()',
  'public.treatment_plan_stages_set_studio_id()',
  'public.client_personal_notes_set_studio_id()',
  'public.tg_client_portal_messages_set_updated_at()',
  'public.tg_client_portal_message_replies_set_updated_at()',
  'public.tg_consent_form_templates_set_updated_at()',
  'public.tg_client_payment_methods_set_updated_at()',
  'public.payment_charge_attempts_touch_updated_at()',
  'public.enforce_treatment_image_integrity()',
  'public.tg_studio_tracking_providers_set_updated_at()',
  'public.snapshot_appointment_buffer()',
  'public.handle_new_user()',
  'public.enforce_appointment_buffer()',
  'public.guard_scoped_recurring_rule_capacity()',
  'public.studios_admission_mode_guard()',
  'public.is_studio_member(uuid)',
  'public.is_studio_owner(uuid)',
  'public.session_is_visible(uuid)'
  ]) as s(sig)
  left join pg_proc p on p.oid = to_regprocedure(s.sig)
 order by s.sig;

-- 3. Every role holding any privilege on the 13 tables 0255 touches, with its
--    BYPASSRLS flag. A role that is not BYPASSRLS and held PUBLIC access
--    through a PUBLIC-default policy loses it when 0255 retargets that policy.
select c.relname as table_name,
       coalesce(r.rolname, 'PUBLIC') as grantee,
       r.rolbypassrls as bypassrls,
       a.privilege_type
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  left join pg_roles r on r.oid = a.grantee
 where n.nspname = 'public'
   and c.relname = any(array['manual_fee_charge_attempts', 'ops_alerts', 'payment_charge_attempts', 'service_practitioners', 'studio_availability_default', 'studio_availability_overrides', 'studio_blockouts', 'studio_calendar_reservations', 'studio_recurring_break_occurrences', 'studio_recurring_break_rules', 'studio_timed_blocks', 'waitlist', 'demo_requests'])
 order by c.relname, grantee, a.privilege_type;

-- 4. Policies on the two form tables, metadata only. 0255 aborts unless each
--    table has exactly one INSERT-capable policy, permissive and not always
--    true, and no read, update or delete policy for a browser role.
select pol.polrelid::regclass::text as table_name,
       pol.polname,
       pol.polcmd,
       pol.polpermissive,
       (select array_agg(coalesce(r.rolname, 'PUBLIC') order by coalesce(r.rolname, 'PUBLIC'))
          from unnest(pol.polroles) as o(oid) left join pg_roles r on r.oid = o.oid) as roles,
       pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check
  from pg_policy pol
 where pol.polrelid in ('public.waitlist'::regclass, 'public.demo_requests'::regclass)
 order by 1, 2;
