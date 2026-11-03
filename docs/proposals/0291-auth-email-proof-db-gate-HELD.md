# Proposal (HELD, claimed number 0291): database-level mailbox-proof gate for invitation linking

Status: migration file written, HELD: `supabase/migrations/0291_auth_email_proof_invitation_gate.sql` (DB test `tests/db/auth-invitation-proof-gate.db.test.ts`). Not applied; applying needs Sam's per-change approval. Claims: OPS (`01-ops/MIGRATION-NUMBER-CLAIMS.md`). The sketch below is superseded by the file: the proof set is `otp` only (measured) plus a verified-Google oauth identity.

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

## Addendum: password-state probe for `HONE_PROOF_HARDENING=password_only` (HELD; ask OPS whether it folds into 0291 or takes its own number)

`password_only` must touch only accounts that actually hold a password, and must not read the hash. GoTrue's admin user object
does not expose it, and an `email` identity exists for passwordless users too, so the only server-side signal is a service-role
function returning a boolean. Until it exists the app treats "unknown" as "do not touch" (shipped inert).

```sql
-- sketch, not a migration
create or replace function public.auth_account_has_password(p_user_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce((select encrypted_password is not null and encrypted_password <> '' from auth.users where id = p_user_id), false) $$;
revoke execute on function public.auth_account_has_password(uuid) from public, anon, authenticated, service_role;
grant execute on function public.auth_account_has_password(uuid) to service_role;  -- the ONLY caller is the server callback
```
It returns a boolean only (never the hash). With the 0292 hook in place a password is already unusable, so this probe is needed only
for targeted remediation after verified mailbox ownership; the hook alone removes the exposure without modifying any account.
