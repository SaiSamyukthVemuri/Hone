# Proposal (HELD, claimed number 0291): database-level mailbox-proof gate for invitation linking

Status: proposal only, HELD. Number 0291 is claimed by OPS for this (no migration file exists). Claims: OPS (`01-ops/MIGRATION-NUMBER-CLAIMS.md`); applying needs Sam's per-change approval.

## Why

The app now refuses invitation linking and the platform-admin check for a session that has not proven control of its email
(`lib/auth/email-proof.ts`; `/auth/callback`, `acceptInvitationAction`, `isProvenPlatformAdmin`). The database does not see that
rule: `reconcile_my_pending_invitation()` and `my_pending_invitation()` are callable by any `authenticated` JWT over PostgREST and
use `auth.users.email` with no check of how the session was created. A password session on an auto-confirmed account could
therefore still call them directly. `tests/db/auth-email-proof.db.test.ts` records the observed behaviour (evidence key
`passwordSessionRpc`). `admin_accept_pending_invitation(p_user_id)` is service-role only, so it is gated by its single adapter.

## Proposal

Read the session's `amr` from the JWT inside both functions and treat the caller as unproven unless it holds a mailbox method.

```sql
-- sketch, not a migration
create or replace function public.session_proves_mailbox() returns boolean
language sql stable security invoker set search_path = ''
as $$
  select exists (
    select 1 from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) a
    where a ->> 'method' in ('otp','magiclink','email/signup','invite','recovery')
       or (a ->> 'method' = 'oauth' and a ->> 'provider' = 'google'
           and exists (select 1 from auth.identities i
                        where i.user_id = auth.uid() and i.provider = 'google'
                          and (i.identity_data ->> 'email_verified')::boolean is true
                          and lower(i.identity_data ->> 'email') = lower((select email from auth.users where id = auth.uid()))))
  );
$$;
-- reconcile_my_pending_invitation / my_pending_invitation: return {"status":"proof_required"} (no studio data, no write)
-- when not public.session_proves_mailbox().
```

Notes: revoke EXECUTE from `anon`, `authenticated` AND `service_role` by name on the helper if it is not meant to be called
directly (CLAUDE.md §5); keep the existing function signatures; one fresh `db reset` and the existing
`tests/db/invitation-reconciliation.db.test.ts` matrix re-run with OTP JWTs (the harness mints HS256 tokens without `amr`, so it
must add `amr` for its positive controls). The `amr` claim is present in GoTrue access tokens; the recorded evidence
(`passwordAmr`, `magicLinkAmr`, `emailOtpAmr`) pins the exact strings.
