-- Migration 0062: harden SMS RPC grants (service_role only).
--
-- PR #141. Migration 0049 installed two SECURITY DEFINER RPCs that
-- mutate per-appointment SMS reminder state:
--
--   public.claim_sms_send(p_appointment_id uuid, p_sms_type text)
--   public.record_sms_result(p_appointment_id uuid, p_sms_type text,
--                            p_success boolean)
--
-- Both functions were exposed with EXECUTE granted to anon AND
-- authenticated (verified via pg_proc + has_function_privilege
-- against prod before this migration). A SECURITY DEFINER function
-- runs as its owner, so an authenticated user who knew or guessed
-- an appointment UUID could call claim_sms_send / record_sms_result
-- and mutate another tenant's SMS reminder state. Multi-tenant
-- security risk.
--
-- Caller audit (TypeScript, completed before this migration):
--   * lib/sms/send-appointment.ts (only two .rpc() call sites for
--     these functions) accepts a SupabaseClient parameter named
--     `admin` and invokes the RPCs on it.
--   * Every upstream caller passes a service-role client created
--     via createAdminClient():
--       app/book/[slug]/actions.ts
--       app/(app)/calendar/actions.ts
--       app/reschedule/[token]/actions.ts
--       app/api/cron/appointment-reminders/route.ts
--   * Zero user-scoped or anon callers exist.
--
-- Conclusion. Revoking EXECUTE from anon, authenticated, and PUBLIC
-- and granting it explicitly to service_role does NOT break any
-- production caller. The hard gate from the PR brief passed.
--
-- Scope. Grants only. NO SECURITY DEFINER body rewrite. NO
-- search_path change. NO function signature change. NO SMS
-- behaviour change. If the SMS dispatch breaks after this migration
-- it isolates blame to the grant change alone, not a body rewrite.
--
-- Strictly additive + idempotent. REVOKE ... FROM ... is a no-op
-- when the grant was already absent; GRANT ... TO ... is a no-op
-- when the grant was already present. Re-running this migration
-- against a clean DB has no further effect.

-- --------------------------------------------------------------------
-- Revoke EXECUTE from every non-service_role
-- --------------------------------------------------------------------

revoke execute on function public.claim_sms_send(uuid, text)
  from authenticated;
revoke execute on function public.record_sms_result(uuid, text, boolean)
  from authenticated;

revoke execute on function public.claim_sms_send(uuid, text)
  from anon;
revoke execute on function public.record_sms_result(uuid, text, boolean)
  from anon;

revoke execute on function public.claim_sms_send(uuid, text)
  from public;
revoke execute on function public.record_sms_result(uuid, text, boolean)
  from public;

-- --------------------------------------------------------------------
-- Grant EXECUTE explicitly to service_role
-- --------------------------------------------------------------------

grant execute on function public.claim_sms_send(uuid, text)
  to service_role;
grant execute on function public.record_sms_result(uuid, text, boolean)
  to service_role;
