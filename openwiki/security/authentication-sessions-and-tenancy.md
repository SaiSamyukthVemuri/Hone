---
type: security boundary
title: Authentication, sessions and tenancy
description: How Hone authenticates practitioners (invite-only magic link or Google OAuth, sign-in-time invitation reconciliation), gates every request in middleware, derives the acting studio and practitioner exactly once per request, and where a studio id supplied by the browser is or is not trusted — plus the separate client-portal session realm and the operator allowlist.
tags: [authentication, tenancy, multi-studio, invite-only, sessions, client-portal, admin, security]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T20:08:11.217Z
sources:
  - id: openwiki-source-29f5d815aa4966f3c92bbe05
    resource: repo://app/(app)/clients/%5Bid%5D/sessions/new/actions.ts
  - id: openwiki-source-ca24c5e271452a7d45e66ac0
    resource: repo://app/(auth)/accept-invitation/actions.ts
  - id: openwiki-source-a0b778a550bced321aa7d3cc
    resource: repo://app/(auth)/auth/callback/route.ts
  - id: openwiki-source-501a6ab6bea6a01eaabf9afb
    resource: repo://app/(auth)/login/actions.ts
  - id: openwiki-source-5207b2cd5c4f3a351f44c305
    resource: repo://app/(auth)/login/page.tsx
  - id: openwiki-source-c8c63018e7c00fb0be3c8c4b
    resource: repo://app/(auth)/no-access/actions.ts
  - id: openwiki-source-88f734cd106bb34dfb2bb671
    resource: repo://app/admin/layout.tsx
  - id: openwiki-source-f9116f0674b76f2685a840b3
    resource: repo://app/portal/verify/%5Btoken%5D/actions.ts
  - id: openwiki-source-428f7e71a4b573a67a7647da
    resource: repo://docs/03_SECURITY_AND_PRIVACY.md
  - id: openwiki-source-81540d55f57e8108b840432e
    resource: repo://docs/20_NEW_STUDIO_SETUP_RUNBOOK.md
  - id: openwiki-source-e2ff2d5ec8ce9ed68fec4e72
    resource: repo://docs/production/migration-state.json
  - id: openwiki-source-074418188d433d183a2d2a90
    resource: repo://lib/admin.ts
  - id: openwiki-source-e65da206b9c2f6871acfa78c
    resource: repo://lib/portal/magic-link.ts
  - id: openwiki-source-098ed071339a3e574b25fc7a
    resource: repo://lib/portal/session.ts
  - id: openwiki-source-f29532dcda137c4bfc1a8b8c
    resource: repo://lib/supabase/middleware.ts
  - id: openwiki-source-bf4a03832f84ac176dc48f73
    resource: repo://lib/supabase/queries.ts
  - id: openwiki-source-2b1c860a5d2152bb5a097349
    resource: repo://lib/supabase/selected-studio.ts
  - id: openwiki-source-9166d99273c429f447e8e564
    resource: repo://middleware.ts
  - id: openwiki-source-0479c4d807cfcaf49b8df86a
    resource: repo://supabase/migrations/0001_init.sql
  - id: openwiki-source-cab430b0fc17b8972611ef4d
    resource: repo://supabase/migrations/0141_onboarding_invitation_reconciliation.sql
  - id: openwiki-source-69126d72bc36d60399cbd4c9
    resource: repo://supabase/migrations/0167_session_write_commands.sql
  - id: openwiki-source-cf30cf78074c56edc357b806
    resource: repo://supabase/migrations/0178_practitioner_identity_boundary.sql
  - id: openwiki-source-211384cfd867882e2309d030
    resource: repo://supabase/migrations/0181_multi_studio_command_authority.sql
  - id: openwiki-source-a803385a9cc24ff3f9f2ff15
    resource: repo://tests/db/cross-studio-isolation.db.test.ts
  - id: openwiki-source-6b94557a175b2c3aae5fa380
    resource: repo://tests/db/multi-studio-membership.db.test.ts
  - id: openwiki-source-1203e4b52f42cc524ab47bcb
    resource: repo://tests/db/multi-studio-session-authority.db.test.ts
  - id: openwiki-source-9599e4dad6a799c1337f659a
    resource: repo://tests/db/practitioner-identity-boundary.db.test.ts
  - id: openwiki-source-11de910c90a312b31221be28
    resource: repo://tests/lib/supabase/request-identity-dedupe.test.ts
  - id: openwiki-source-833044c4d4591cb2eabb5a7e
    resource: repo://tests/security/service-role-allowlist.ts
generated: { by: "claude-code", at: "2026-10-02T20:08:11.217Z" }
---

# Authentication, sessions and tenancy

Hone has four kinds of caller, and they never share a credential:

| Caller | Credential | Resolved to |
|---|---|---|
| Practitioner | Supabase Auth session cookie (magic link or Google OAuth) | an **active** `practitioners` row in one studio (§3) |
| Client | `hone_portal_session` cookie, a separate realm (§6) | one `(studio_id, client_id)` pair |
| Anonymous link holder | appointment or invitation token in the URL | the row the token resolves to — see [Public token routes and privacy](public-token-routes-and-privacy.md) |
| Operator | a practitioner session whose email is on `ADMIN_EMAILS` (§7) | cross-studio, read-mostly `/admin` surface |

The rule this page documents: **the browser never chooses the tenant**. The studio and the acting
practitioner come from the server-side resolver, and every database command re-proves membership itself.
Row-level policies are covered on [RLS, grants and SECURITY DEFINER commands](rls-grants-and-security-definer.md).

## 1. Practitioner sign-in is invite-only

**Magic link.** `/login` sends the address to `requestPractitionerMagicLinkAction`. That action:

- looks up a `pending` invitation with the service-role client (the requester is anonymous, and
  `pending_invitations` is limited to studio members by RLS);
- sets `shouldCreateUser` only when an invitation exists — a lookup error fails closed for sign-up, but
  existing practitioners still get their link;
- returns the same generic success either way, folding Supabase's "signups not allowed" into it, so the form
  cannot reveal who has an account.

<!-- openwiki: broken internal link [../../app/(auth] file "../../app/(auth" does not exist. Fix the href or restore the target, then delete this comment. -->
Evidence: [`app/(auth)/login/actions.ts` L35-L82](../../app/(auth)/login/actions.ts#L35-L82).

**Google OAuth.** It starts in the browser and cannot pass `shouldCreateUser`, so it can create an
<!-- openwiki: broken internal link [../../app/(auth] file "../../app/(auth" does not exist. Fix the href or restore the target, then delete this comment. -->
`auth.users` row for anyone ([`login/page.tsx` L36-L48](../../app/(auth)/login/page.tsx#L36-L48)).
Creating that row grants nothing:

- since `0141`, `handle_new_user()` is a **no-op** — it creates no membership and stamps no acceptance
  ([`0141` L59-L78](../../supabase/migrations/0141_onboarding_invitation_reconciliation.sql#L59-L78));
- `0081` had already removed the older fallback that gave every new user a fresh studio
  ([`0081` L1-L17](../../supabase/migrations/0081_invite_only_handle_new_user.sql#L1-L17)).

**Provisioning happens at sign-in.** Both methods land on `/auth/callback`
<!-- openwiki: broken internal link [../../app/(auth] file "../../app/(auth" does not exist. Fix the href or restore the target, then delete this comment. -->
([`route.ts` L9-L76](../../app/(auth)/auth/callback/route.ts#L9-L76)):

1. It exchanges the code for a session.
2. It calls `reconcile_my_pending_invitation()`, an authenticated, self-scoped `SECURITY DEFINER` RPC that
   ([`0141` L202-L307](../../supabase/migrations/0141_onboarding_invitation_reconciliation.sql#L202-L307)):
   - takes a per-email advisory lock;
   - acts only when exactly **one** pending invitation matches the caller's verified auth email
     (more than one returns `ambiguous`);
   - refuses with `conflict` when another user already holds an active row with that email in the studio;
   - links a membership **only** by copying an existing current-version terms + privacy acceptance;
     otherwise it returns `acceptance_required`.
3. The callback routes on the result:

| Result | Destination |
|---|---|
| `acceptance_required` | `/accept-invitation` |
| `conflict` | `/no-access?reason=invite-conflict` |
| `ambiguous` | `/no-access?reason=invite-ambiguous` |
| linked, now a member of 2+ studios | `/dashboard`, with the studio-selection cookie cleared so the chooser appears |

Any reconciliation failure falls through to the default destination; it never blocks sign-in.

**Explicit acceptance.** `/accept-invitation` is the single authoritative acceptance point
<!-- openwiki: broken internal link [../../app/(auth] file "../../app/(auth" does not exist. Fix the href or restore the target, then delete this comment. -->
([`accept-invitation/actions.ts` L10-L60](../../app/(auth)/accept-invitation/actions.ts#L10-L60)). Its server
action checks the current-policy checkbox, resolves the user from the session, and calls
`admin_accept_pending_invitation(p_user_id)` with **only** the user id. That command is service-role-only; the
two self-scoped readers are granted to `authenticated` and never to `anon`
([`0141` L480-L515](../../supabase/migrations/0141_onboarding_invitation_reconciliation.sql#L480-L515)).

`0141` is at or below the declared hosted maximum (`0204`,
[`migration-state.json` L16](../../docs/production/migration-state.json#L16-L16)), so this flow is
migration-applied. See [Migrations and hosted state](../operations/migrations-and-hosted-state.md) for how to
read that file.

## 2. The request gate (`middleware.ts` → `updateSession`)

Every request outside the static-asset matcher runs `updateSession`
([`middleware.ts` L4-L58](../../middleware.ts#L4-L58)). The matcher excludes a few files by **exact path**,
never by prefix, because a prefix would also exempt a same-named authenticated route.

`updateSession` refreshes the Supabase cookies through `auth.getUser()`, then applies three gates in order
([`lib/supabase/middleware.ts` L5-L236](../../lib/supabase/middleware.ts#L5-L236)):

1. **Anonymous gate.** An anonymous request to anything off the public allowlist goes to `/login`
   ([L153-L157](../../lib/supabase/middleware.ts#L153-L157)). The allowlist is exact paths or narrow prefixes
   ([L36-L151](../../lib/supabase/middleware.ts#L36-L151)):
   - marketing pages and generated files;
   - the token routes `/book/`, `/cancel/`, `/manage/`, `/reschedule/`, `/intake/` and `/invitation/`;
   - only `/portal`, `/portal/login` and `/portal/verify/` of the portal;
   - `/calendar-feed/` and `/api/cron/`, plus the exact Stripe and Twilio webhook paths.

   Each route on the list authenticates itself.
2. **No-studio gate.** For a signed-in user on any route except `/no-access` and `/accept-invitation`, it reads
   the caller's **active** memberships through the RLS-scoped anon-key client
   ([L159-L233](../../lib/supabase/middleware.ts#L159-L233)):

   | Active memberships | Outcome |
   |---|---|
   | 0 | `/no-access` |
   | 1 | proceed |
   | 2+, `hone_selected_studio` cookie names one of them | proceed |
   | 2+, no valid cookie | the chooser (`/no-access?reason=multiple-studios`); a forged or stale cookie is deleted |

3. **Operator carve-out.** `/admin` paths skip the no-studio gate only for an `isAdmin` email
   ([L180-L192](../../lib/supabase/middleware.ts#L180-L192)), and the `/admin` layout checks `isAdmin` again
   ([`app/admin/layout.tsx` L13-L18](../../app/admin/layout.tsx#L13-L18)).

The middleware is a gate, not an identity source: nothing downstream reads its result.
Browser proof: [`e2e/invite-only.spec.ts` L69-L130](../../e2e/invite-only.spec.ts#L69-L130). In it, an
uninvited signed-in user lands on `/no-access` from every app route, with no studio navigation visible, and
an anonymous user is sent to `/login`.

## 3. The single derivation of studio and practitioner

All of it lives in `lib/supabase/queries.ts`.

**`loadRequestIdentity`** is wrapped in React `cache()`, so it runs once per server request
([L80-L142](../../lib/supabase/queries.ts#L80-L142)). It makes two calls:

- `auth.getUser()` — a real GoTrue round trip, not a cookie decode;
- a select of `practitioners` joined to `studios`, filtered to `user_id = <the authenticated user>` and
  `active = true`, on the authenticated client ([L65-L78](../../lib/supabase/queries.ts#L65-L78)).

The cache is per request only: nothing survives the response, so a revoked session is refused on the next
request.

**`resolveActivePractitionerMembership`** turns those rows into one decision
([L144-L165](../../lib/supabase/queries.ts#L144-L165)):

| Active rows | Result |
|---|---|
| 0 | `none` |
| 1 | that membership |
| 2+, selection cookie matches a row | that row |
| 2+, otherwise | `choose` — a studio is never auto-picked |

Two wrappers expose it, and they differ only in how they fail:

| Wrapper | Used by | No auth | No membership | Must choose |
|---|---|---|---|---|
| `getCurrentPractitionerWithStudio()` ([L184-L216](../../lib/supabase/queries.ts#L184-L216)) | server actions and pages | redirect `/login` | throws | throws a controlled error |
| `requirePractitionerWithStudio()` ([L218-L259](../../lib/supabase/queries.ts#L218-L259)) | the app shell | redirect `/login` | redirect `/no-access` | redirect to the chooser |

**The selection cookie** (`hone_selected_studio`) is httpOnly, `sameSite=lax`, and holds only a studio id. It is
re-read on every wrapper call and honoured only when it matches an active row
([`selected-studio.ts` L4-L38](../../lib/supabase/selected-studio.ts#L4-L38)). The only code that sets it is
`switchStudioAction`, after an RLS-scoped check that the user is an active member of the submitted studio
<!-- openwiki: broken internal link [../../app/(auth] file "../../app/(auth" does not exist. Fix the href or restore the target, then delete this comment. -->
([`no-access/actions.ts` L16-L51](../../app/(auth)/no-access/actions.ts#L16-L51)).

Tests:

- [`request-identity-dedupe.test.ts`](../../tests/lib/supabase/request-identity-dedupe.test.ts#L292-L532):
  - one navigation costs one `getUser` and one membership query;
  - the read is limited to the caller's own active rows;
  - no identity crosses a request boundary;
  - a forged cookie is refused even inside a memoised request;
  - a failed membership read surfaces as an error, never as "no memberships".
- [`multi-studio-membership.db.test.ts` L36-L93](../../tests/db/multi-studio-membership.db.test.ts#L36-L93):
  2+ memberships is a reachable state, and the switch check returns zero rows for a studio the user does not
  belong to.

## 4. Where a studio id crosses into the database

| Path | Who names the studio | Who re-proves it |
|---|---|---|
| Authenticated-client reads and writes | the row's own `studio_id` | RLS predicates `is_studio_member` / `is_studio_owner`: `auth.uid()` must hold an **active** row (owner role for the owner variant) ([`0001` L151-L189](../../supabase/migrations/0001_init.sql#L151-L189)) |
| Service-role commands (Pattern A) | the server action, from `getCurrentPractitionerWithStudio()` — never a form field | the command re-derives membership and role from `(studio_id, user_id)`. Every `createAdminClient()` call site must appear in an allowlist that requires a scope guard to be present in the file — an inventory and drift gate, not a proof of perfect scoping ([`service-role-allowlist.ts` L1-L42](../../tests/security/service-role-allowlist.ts#L1-L42)) |
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
| Authenticated-callable commands that take a studio (Pattern B) | the server action passes `p_studio_id` from the resolver ([`sessions/new/actions.ts` L203-L223](../../app/(app)/clients/[id]/sessions/new/actions.ts#L203-L223)) | the command maps `auth.uid()` + that studio to an active practitioner row, or refuses (`session_actor_practitioner`, [`0167` L78-L107](../../supabase/migrations/0167_session_write_commands.sql#L78-L107); `own_practitioner_in_studio`, [`0178` L59-L86](../../supabase/migrations/0178_practitioner_identity_boundary.sql#L59-L86)) |
| Studio switch | a form field | an RLS-scoped active-membership check before the cookie is set (§3) |
| Public slug, appointment and invitation tokens, portal session | the credential's own row | each route — see [Public token routes and privacy](public-token-routes-and-privacy.md) |

**Why `p_studio_id` is explicit.** In the incident behind `0181`, `start_session` chose a studio with an
unordered `limit 1` over all of the caller's memberships. A practitioner in two studios could therefore render
the page for the selected studio and then run the command against the other one
([`0181` L1-L54](../../supabase/migrations/0181_multi_studio_command_authority.sql#L1-L54)). The fix:

- the five-argument command proves an active membership in the **named** studio before reading the client
  ([L121-L136](../../supabase/migrations/0181_multi_studio_command_authority.sql#L121-L136));
- the retained four-argument wrapper derives the studio from the client's own studio instead of guessing
  ([L255-L314](../../supabase/migrations/0181_multi_studio_command_authority.sql#L255-L314)).

Proof: [`multi-studio-session-authority.db.test.ts` L107-L200](../../tests/db/multi-studio-session-authority.db.test.ts#L107-L200)
(explicit A, explicit B, a cross-studio client, a non-member studio and an inactive membership) and
[L360-L420](../../tests/db/multi-studio-session-authority.db.test.ts#L360-L420) (the legacy wrapper).
`0178` fixed the same class in `treatment_image_actor`: it took the first active row with no studio scope,
which made the actor nondeterministic and caused intermittent refusals rather than a proven leak
([`0178` L33-L39](../../supabase/migrations/0178_practitioner_identity_boundary.sql#L33-L39)).

## 5. The practitioner roster is SELECT-only

`0178` revoked **all** privileges on `public.practitioners` from `public`, `anon`, `authenticated` and
`service_role`, then granted back `SELECT` only. This covers TRUNCATE, REFERENCES, TRIGGER and PostgreSQL 17's
MAINTAIN, none of which RLS governs. It also dropped the owner insert and update policies and kept
`practitioners: members read`
([`0178` L505-L544](../../supabase/migrations/0178_practitioner_identity_boundary.sql#L505-L544)).

What remains writable, and how:

- **Own preferences** (name, colour, feed-token hash, default frequency): three authenticated-callable
  commands bound to `auth.uid()`
  ([L546-L578](../../supabase/migrations/0178_practitioner_identity_boundary.sql#L546-L578)).
- **Team lifecycle**: the owner-gated locked command, unchanged.

Proof ([`practitioner-identity-boundary.db.test.ts` L116-L453](../../tests/db/practitioner-identity-boundary.db.test.ts#L116-L453)):

- a real authenticated UPDATE is denied by privilege, not silently filtered by RLS;
- a non-owner can edit their own preferences but cannot self-promote, deactivate themselves or touch a
  colleague;
- a forged studio id mutates nothing;
- a multi-studio user resolves per studio;
- multiple owners stay valid.

Cross-studio read isolation, with positive controls and "the row exists" ground truth, is proved in
[`cross-studio-isolation.db.test.ts` L51-L466](../../tests/db/cross-studio-isolation.db.test.ts#L51-L466).

## 6. Client portal sessions — a separate realm

`lib/portal/session.ts` owns the `hone_portal_session` cookie
([L6-L33](../../lib/portal/session.ts#L6-L33)):

- the cookie is httpOnly, `sameSite=lax` and `secure` in production, and carries the raw token;
- the database stores only its SHA-256 (`client_portal_sessions`);
- the TTL is 7 days, computed on the server;
- portal sessions never grant practitioner access, and practitioner sessions never grant portal access.

**Lookup** ([L43-L120](../../lib/portal/session.ts#L43-L120)) filters on the hash and rejects a revoked or
expired row. A database error is treated as anonymous rather than a 500.

**Sign-out** ([L164-L200](../../lib/portal/session.ts#L164-L200)) revokes the row and always clears the cookie.

**Portal magic links** ([`lib/portal/magic-link.ts` L6-L55](../../lib/portal/magic-link.ts#L6-L55)) are
256-bit random tokens, hashed at rest, valid for 60 minutes and bound to one studio and client.

**Redemption** happens in a POST server action, so link scanners that fetch the URL do not consume it
([`verify/[token]/actions.ts` L9-L31](../../app/portal/verify/[token]/actions.ts#L9-L31)). The action:

- re-checks expiry and whether the client is archived;
- consumes the link with a conditional `consumed_at IS NULL` update, so exactly one concurrent POST wins;
- only then creates the session ([L69-L125](../../app/portal/verify/[token]/actions.ts#L69-L125)).

More on the portal: [Client portal, intake and consent](../portal/client-portal-intake-and-consent.md).

## 7. Operators (`ADMIN_EMAILS`)

`isAdmin(email)` checks a comma-separated, lower-cased `ADMIN_EMAILS` allowlist
([`lib/admin.ts` L42-L72](../../lib/admin.ts#L42-L72)):

- **Production:** an empty or unset variable denies everyone and logs a one-time sanitized error; there is no
  hard-coded fallback ([L10-L21](../../lib/admin.ts#L10-L21)).
- **Outside production:** a built-in development list applies.

Admin pages and actions use the service-role client for cross-studio reads, and each action re-checks
`isAdmin`.

## 8. Contradictions and open questions

1. **Code comments still describe trigger-based provisioning.**
   - The login action's header says that on first login `handle_new_user()` "matches the invite and places
     the practitioner in the inviting studio"
<!-- openwiki: broken internal link [../../app/(auth] file "../../app/(auth" does not exist. Fix the href or restore the target, then delete this comment. -->
     ([`login/actions.ts` L17-L19](../../app/(auth)/login/actions.ts#L17-L19)).
   - Since `0141` that trigger is a no-op, and provisioning happens only in the sign-in reconciliation (§1).
   - `docs/03_SECURITY_AND_PRIVACY.md` still frames invite-only as the `shouldCreateUser` gate plus the `0081`
     change and does not mention reconciliation
<!-- openwiki: broken internal link [../../docs/03_SECURITY_AND_PRIVACY.md#L90-L90] heading anchor "L90-L90" does not exist in "../../docs/03_SECURITY_AND_PRIVACY.md". Fix the href or restore the target, then delete this comment. -->
     ([L90](../../docs/03_SECURITY_AND_PRIVACY.md#L90-L90)).
   - `docs/20_NEW_STUDIO_SETUP_RUNBOOK.md` carries the corrected account
<!-- openwiki: broken internal link [../../docs/20_NEW_STUDIO_SETUP_RUNBOOK.md#L100-L114] heading anchor "L100-L114" does not exist in "../../docs/20_NEW_STUDIO_SETUP_RUNBOOK.md". Fix the href or restore the target, then delete this comment. -->
     ([L100-L114](../../docs/20_NEW_STUDIO_SETUP_RUNBOOK.md#L100-L114)).
2. **Sign-in analytics label every sign-in as a magic link.** The callback sends `user_signed_in` with
   `provider: "magic_link"` for every successful exchange
<!-- openwiki: broken internal link [../../app/(auth] file "../../app/(auth" does not exist. Fix the href or restore the target, then delete this comment. -->
   ([`route.ts` L21-L28](../../app/(auth)/auth/callback/route.ts#L21-L28)), including Google OAuth sign-ins,
   which use the same callback.
3. **The callback accepts an unvalidated `next` parameter.** It reads `next` from the query string (default
   `/dashboard`) and appends it to the request origin without checking that it is a same-origin path
<!-- openwiki: broken internal link [../../app/(auth] file "../../app/(auth" does not exist. Fix the href or restore the target, then delete this comment. -->
   ([L12](../../app/(auth)/auth/callback/route.ts#L12-L12),
<!-- openwiki: broken internal link [../../app/(auth] file "../../app/(auth" does not exist. Fix the href or restore the target, then delete this comment. -->
   [L67](../../app/(auth)/auth/callback/route.ts#L67-L67)). No caller in the repository sets `next`.
   Restricting it to relative paths is an open hardening question, not a documented decision.
4. **The four-argument `start_session` still has an application caller.**
   - `0181` says the legacy signature will have no caller once the app binds explicitly, and "may be dropped
     by a later migration"
     ([`0181` L268-L274](../../supabase/migrations/0181_multi_studio_command_authority.sql#L268-L274)).
   - The session-start action still calls it as a one-retry fallback when PostgREST reports the five-argument
     signature missing (`PGRST202`)
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
     ([`sessions/new/actions.ts` L225-L261](../../app/(app)/clients/[id]/sessions/new/actions.ts#L225-L261)).
   - No later migration drops it.
5. **The "sole remaining unconstrained resolver" finding is a dated record, not a guard.** `0181`'s header
   reports a live-schema census that found `start_session` was the last `SECURITY DEFINER` function picking
   a practitioner from `auth.uid()` with no studio constraint
   ([`0181` L56-L74](../../supabase/migrations/0181_multi_studio_command_authority.sql#L56-L74)). The DB
   tests above prove the specific commands. No test located for this page enumerates every such function, so
   a new unconstrained resolver would not be caught automatically.
