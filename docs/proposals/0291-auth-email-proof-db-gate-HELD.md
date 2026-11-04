# Proposal (HELD, claimed number 0291): database-level mailbox-proof gate for invitation linking

Status: migration file written, HELD: `supabase/migrations/0291_auth_email_proof_invitation_gate.sql` (DB test `tests/db/auth-invitation-proof-gate.db.test.ts`). Not applied; applying needs Sam's per-change approval. Claims: OPS (`01-ops/MIGRATION-NUMBER-CLAIMS.md`). The sketch below is superseded by the file: the proof set is `otp`, `magiclink` and `recovery` (measured per flow, incl. PKCE) plus a verified-Google oauth identity.

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
    where a ->> 'method' in ('otp','magiclink','recovery')
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

## S-2b address binding (Insurance Z-1/G-3, 3 Nov) - amendment to the sketch above
The sketch is historical; the migration file is the authority. A link-type amr entry now also has to be at or after the account's
last email-change activity: `since = floor(epoch(greatest(auth.users.email_change_sent_at, max(updated_at) of the account's
'email' identity)))`, NULL = never changed = no constraint, entry `timestamp` must be a JSON number `>= since`. Columns chosen from
the measured matrix (machines/AUTH-S2B-columns-evidence.json): `users.updated_at` also moves on OTP requests, sign-ins and refreshes, so
it is not used. Measured cost: only an account with email-change activity after the session began is asked to confirm again; nobody is
locked out. DB proof (minted claims before/after the change, plus a real-GoTrue magic-link attacker) is written and runs in the next slot.

## S-2b rule fix (auth-worker, 4 Nov) - supersedes the amendment above
The whole-second `>= since` rule above is REPLACED. Measured on GoTrue v2.197.0 with Confirm email ON (hosted shape), it accepted
two attacker sessions: one created before the change in the change's own second (Codex P1), and the session GoTrue returns to
the LAST confirm click of a double-confirm change (implicit flow, amr `otp`, created about 6-10 ms after the change). With
double_confirm on, that last click can be the OLD address's owner. The strict `>` alternative refused every first sign-in.
0291 now gates link-type proof on `public.session_link_proof_is_current()`:
- the JWT's session row exists for the caller (`auth.sessions`, by `session_id` AND `auth.uid()`);
- AND either the address never changed (`email_change_sent_at` null and every `email` identity has `updated_at = created_at`),
  OR a sign-in credential (`recovery_sent_at` / `confirmation_sent_at`) was issued strictly after
  `greatest(email_change_sent_at, email identity updated_at)` and strictly before the session's `created_at`. All comparisons
  are in microseconds.

Every legitimate post-change sign-in moves `recovery_sent_at` into that window; the completion click moves none, and a credential
issued before the change no longer redeems (`otp_expired`). The function is EXECUTE for `authenticated` only, revoked from
public/anon/authenticated/service_role by name first. The app's reader calls it for exactly the accounts whose address changed,
because the app cannot see `auth.sessions`. Evidence and negative controls: `auth-worker/1333-RULE-FIX-PACKAGE.md`.

## CODEX-P2 (session-bound proof stamp, auth-worker, 4 Nov)
**The finding (Codex, confirmed by test):** the credential window reads the account's CURRENT `recovery_sent_at` /
`confirmation_sent_at`. Any later link or recovery request moves them, even if never redeemed, so an honest changed-account session
on one device lost proof when another device asked for a link. It failed closed: an availability problem, not a hole.

**The fix:** `public.stamp_session_link_proof()` (volatile, SECURITY DEFINER, EXECUTE for authenticated only).
- `/auth/callback` calls it when a sign-in completes.
- It runs the same window check. Only when the window holds does it record `(session_id, user_id, anchor)` in
  `public.auth_session_link_proofs` (RLS on, no API role may read or write it).
- It re-reads the anchor afterwards and drops the stamp if a change committed in between.
- `session_link_proof_is_current()` also accepts a stamp for the caller's own session whose anchor equals the CURRENT anchor.
  Any new email-change activity voids it.

**Why the attack refusals are unchanged:** a stamp is written only at a moment the existing rule would itself prove the session.
- the completion session and a pre-change session can never be stamped (tested, including an attacker calling the RPC directly
  in every race round);
- refresh keeps `session_id`;
- a signed-out session is still refused (the session row must exist).

**Residual:** a session that never reaches the callback (no app sign-in path) is not stamped and keeps the previous behaviour.
