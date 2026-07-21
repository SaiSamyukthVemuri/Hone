# 24 — First-time studio onboarding (v2)

Guided first-run experience for a new studio **owner**: welcome email → auto-opening
resumable dashboard wizard → pinned setup-progress card → celebration, plus an
admin invite/onboarding status view and an existing-account invitation
reconciliation path.

**Status:** built behind a per-studio flag, **default OFF**. Migrations
0140–0141 are **repo-only** (not hosted-applied). Nothing is enabled for any
production studio; Willow is untouched. See PR #459.

---

## 1. Feature flag & rollout

`studios.onboarding_v2_enabled` — additive `boolean not null default false`
(migration 0140). While it is not exactly `true`, the studio sees today's
experience byte-for-byte (the legacy getting-started link/footer; no wizard, no
welcome email, no celebration). Pinned by
`tests/app/dashboard/onboarding-flag-off-contract.test.ts`.

- **Operator-controlled.** A `SECURITY INVOKER` guard trigger
  (`guard_onboarding_flag_activation`) rejects any change to the flag by a
  browser role (anon/authenticated, studio owners included) with `42501`.
  Enable it **only** via service role / operator SQL, or at studio-create time
  (the admin wizard checkbox, which inserts with the flag set).
- **Enable one studio (operator):**
  ```sql
  update public.studios set onboarding_v2_enabled = true where id = '<studio-id>';
  ```
  Rollback = set it back to `false` (instant, per studio; no data rewrite).
- Read it as `studio.onboarding_v2_enabled === true` (undefined ⇒ off). The
  owner dashboard reads it off a `select *` studio object, so it is
  deployment-skew-safe; the admin studio-detail page reads it (and
  `studio_onboarding`) separately and tolerates their absence.

## 2. Migrations & deployment order

| # | Adds | Hosted-applied? |
|---|---|---|
| 0140 `studio_onboarding` | flag + `public.studio_onboarding` state table (RLS member-read/owner-write, guard trigger) | **No** (repo-only) |
| 0141 `onboarding_invitation_reconciliation` | reconcile (authenticated) + `admin_accept` (service-role) + read RPCs + welcome-email claim + centralized policy versions; makes `handle_new_user` a no-op | **No** (repo-only) |

Both are additive, single-transaction. Required cross-PR apply order (do not
merge/apply out of order):

```
0135–0139  PR #458 (per-practitioner availability)
0140–0141  PR #459 (onboarding: state + reconciliation)   ← this work
0142       PR #460 (internal booking; renumbered from 0141)
```

**Deployment order (APP-FIRST for 0141):**
- **0140** (flag + state table) is a pure additive column/table; the app is
  deployment-skew-safe (reads tolerate the column/table being absent), so 0140
  can go migration-first or app-first.
- **0141 MUST be APP-FIRST.** It replaces `handle_new_user` with a no-op, so
  provisioning + acceptance move to the app (`/auth/callback` reconcile +
  `/accept-invitation`). Deploy the reconciliation-capable app **first**, then
  apply 0141.

**Both deployment orders fail safely** (no data loss either way):
- **App-first (mandated):** during the window the app has reconciliation and the
  old trigger still provisions — no duplication (reconcile sees the invite
  already accepted → `already_linked`). After 0141, new invited users go through
  explicit acceptance. Zero stranding.
- **Migration-first (forbidden operationally):** no-op trigger + an app without
  reconciliation → a new invited user gets no membership and lands on
  `/no-access`, but the invitation stays **pending and fully recoverable** — the
  next sign-in once the app is live provisions them. Safe (a safe page, no
  corruption), just avoidable.
- **Rollback:** reverting 0141 restores the old provisioning trigger; existing
  memberships are untouched. Reverting 0140 leaves the app functional (onboarding
  degrades to off, skew-safe).

## 3. Admin studio creation

`/admin/studios/new` → `createStudioWithOwnerInvite`. New opt-in checkbox
**"Enable guided onboarding"**:

- **Off (default):** byte-for-byte today's — flag stays false, **no** welcome
  email, **no** `studio_onboarding` seed row.
- **On:** sets `onboarding_v2_enabled` at insert, then (best-effort, never blocks
  the create) sends the welcome email and seeds `studio_onboarding`. Emits the
  `studio_created` analytics event regardless.

**Welcome email** (`lib/email/templates/welcome.ts`): ONE truthful invitation
email for **both** new and existing accounts (no account-variant is inferred).
At creation the owner has been **invited**, not added — so the copy says
"you've been invited", mentions using an existing account if they have one, and
notes they'll confirm the current Terms/Privacy when they join. It never claims
access is complete.

## 4. Email delivery / recovery / resend runbook

- **Attempt states:** `welcome_email_status` ∈ `not_sent` (never attempted /
  provider unconfigured) · `sent` (provider accepted) · `failed`. **Never
  `delivered`** — there is no delivery evidence (no Resend webhook / pixel;
  deliberate clinical-data privacy posture). `welcome_email_last_sent_at` is the
  last **attempt** time.
- **Single-attempt idempotency:** `claim_welcome_email_attempt(p_studio_id)`
  (service-role only) is an atomic conditional upsert; concurrent resends /
  rapid double-clicks claim once → exactly one send, no duplicate studio /
  invitation / membership.
- **Bounded logging:** failures log only `welcome_email_error:<stage>:<safe_code>`
  (stages `claim`/`send`/`stamp`; codes `provider_rejected`/`provider_exception`/
  `write_failed`). Never the provider error object, recipient address, or DB text.
- **Dev/preview:** the transport is null (no key), so nothing sends; status is
  recorded honestly. Studio creation never depends on email.
- **Resend:** admin studio-detail page → **Resend welcome email**
  (`resendWelcomeEmailAction`, operator-only, idempotent via the claim).
- **"Accepted"** is derived from `pending_invitations.status`, not from email.
- **Fake transport** (E2E): `HONE_E2E_FAKE_RESEND=1` (server-only, refused in any
  deployed runtime) selects `lib/email/e2e-fake-resend.ts` with
  `HONE_E2E_FAKE_RESEND_MODE` = `success`/`reject`/`throw`.

## 5. Existing-user invitation reconciliation (migration 0141)

**Provisioning + consent happen at sign-in, with exactly ONE authoritative
acceptance event.** `handle_new_user` is a **no-op** — Auth-user creation
(magic-link OR Google OAuth) never creates a membership or stamps acceptance
(that fabricated consent). This unifies new and existing users: both are
provisioned at sign-in.

**RPC grants (identity always derived internally — the browser passes no
email/studio/role/timestamps/versions):**

| RPC | Caller | Role |
|---|---|---|
| `reconcile_my_pending_invitation()` | `/auth/callback` (authenticated) | `authenticated` |
| `my_pending_invitation()` | `/accept-invitation` page read (authenticated) | `authenticated` |
| **`admin_accept_pending_invitation(p_user_id)`** | `/accept-invitation` server action via the admin client | **`service_role` ONLY** |
| `claim_welcome_email_attempt(p_studio_id)` | send adapter | `service_role` ONLY |
| `link_invited_membership(...)`, `current_terms_version()`, `current_privacy_version()` | internal | no browser execute |

- **`reconcile`** (auto path): links **only** by copying a **single** existing
  practitioner row with **both** current-version terms **and** privacy (the four
  exact values — **never `now()`**). No reusable evidence, or a same-user
  **inactive** target row → `acceptance_required`. Never stamps fresh acceptance.
- **`admin_accept`** (the ONE authoritative acceptance): service-role only, so
  the browser cannot self-accept. The `/accept-invitation` server action
  validates the unchecked-by-default current-policy checkbox, resolves the user
  from the session, and passes **only** that user id. It stamps the **actual
  transaction time** + current versions, and REACTIVATES a same-user inactive
  target row **in place** (UPDATE — never a second INSERT).

**Target-state resolution order** (both RPCs): (1) same-user membership in the
target studio (active → `already_linked`; inactive → reactivate/`acceptance_
required`); (2) another user's row under the invited email → `conflict` (never
overwrite a `user_id`); (3) none → insert. Policy versions are centralized;
per-email advisory xact lock + `FOR UPDATE` for concurrency; `accepted_at` is
consumption time, distinct from the legal `terms_accepted_at`.

**Login page:** the checkbox is no longer a legal-acceptance control (it now
confirms the invited email); the ONE authoritative acceptance is
`/accept-invitation`.

**Routing (`/auth/callback`):**

| RPC status | Destination |
|---|---|
| `linked` / `already_linked` (single membership) | `/dashboard` |
| `linked` / `already_linked` (+ `choose_studio`) | clear selection cookie → `/dashboard` → chooser |
| `acceptance_required` | `/accept-invitation` |
| `conflict` | `/no-access?reason=invite-conflict` |
| `ambiguous` | `/no-access?reason=invite-ambiguous` |
| `no_invitation` / other | default (`/dashboard`) |

Reconciliation **never blocks sign-in** (failures fall through to the default).

### `/accept-invitation`

Authenticated (the `!user` gate still applies) but exempt from the no-studio gate
in middleware, so a pending-invite user with no membership can reach it. Shows
only safe self-scoped info (studio name + role). An **unchecked-by-default**
current-policy checkbox gates the submit — **no app access before affirmative
consent**.

## 6. Multi-studio chooser

Hone supports multiple active memberships. After reconciliation:

- **0 prior memberships** → continue to the new studio.
- **≥1 prior** → **do not auto-select**; the callback clears
  `hone_selected_studio` so the middleware routes 2+ memberships (no valid
  selection) to the chooser (`/no-access?reason=multiple-studios`). Both
  memberships are shown; nothing is auto-picked.

## 7. `/no-access` troubleshooting

Safe, self-scoped copy (no DB/Auth text, no cross-tenant info):

- `?reason=multiple-studios` → the studio chooser.
- `?reason=invite-conflict` → "couldn't finish setting up your access; contact
  the studio or Hone support." (The invited email already has a membership held
  by a different account.)
- `?reason=invite-ambiguous` → more than one pending invitation for the account;
  contact support.
- no reason (0 memberships) → the invite-only gate.

## 8. Analytics event catalogue

Server-side only, opaque-id, allowlisted properties (`lib/analytics/server.ts`):

| Event | Actor | Properties | Site |
|---|---|---|---|
| `studio_created` | studio | `studio_id` | `createStudioWithOwnerInvite` |
| `onboarding_wizard_started` | user | `studio_id` | `acknowledgeWelcomeAction` |
| `onboarding_wizard_completed` | user | `studio_id` | `completeOnboardingAction` |

`stripe_account_connected` (existing) already serves as the "stripe connected"
signal. Deferred (not yet emitted): `service_created`,
`availability_configured`, `booking_page_opened`, `first_booking`,
`first_payment`. Welcome-email open/delivered tracking is intentionally **not**
implemented.

## 9. Manual test checklist

Wizard (flag ON studio): first login auto-opens at welcome → walk
service/availability/booking → skip/connect payments → success celebration →
Go to dashboard closes it and hides the card. Close (X) preserves progress; the
pinned card re-opens it. Flag OFF: no wizard, legacy link only.

Reconciliation (existing account): (1) no evidence → `/accept-invitation`,
blocked from the app until consent, then in; (2) valid current-version evidence →
straight to the dashboard, no consent screen; (3) one-studio user + a second
invite → chooser, nothing auto-selected; (4) stale/one-policy evidence → the
current-policy gate appears; (5) refresh/repeat → no duplicate membership /
invitation / onboarding row; (6) conflicting membership → safe support message;
(7) a same-user **inactive** target membership → explicit accept **reactivates
it in place** (no duplicate row); (8) the acceptance command cannot be called by
anon or an authenticated browser role; (9) creating an Auth user (magic-link or
OAuth) provisions **nothing** and stamps no acceptance — the invite stays
pending.

New-user provisioning: welcome email → sign in → explicit current-policy
acceptance → membership created → onboarding wizard. The login-page checkbox is
NOT the acceptance control.

Welcome email: one truthful invitation email; send outcome recorded (Sent/
Failed, never delivered); concurrent resend / double-click → one send; failures
log only bounded `welcome_email_error:<stage>:<code>` markers.

**Coverage:** `tests/db/studio-onboarding.db.test.ts`,
`tests/db/invitation-reconciliation.db.test.ts` (A–N + direct-accept-denial,
new-user-consent-provenance, inactive-reactivation),
`tests/db/welcome-email-claim.db.test.ts`, `tests/db/new-studio-wizard.db.test.ts`,
`tests/db/invite-only-posture.db.test.ts`, `e2e/onboarding.spec.ts`,
`e2e/invitation-reconciliation.spec.ts`, `tests/lib/onboarding/*`,
`tests/lib/email/welcome-email.test.ts`,
`tests/lib/email/deliver-welcome-email.test.ts`, `tests/migrations/0140-*`,
`tests/migrations/0141-*`,
`tests/app/dashboard/onboarding-flag-off-contract.test.ts`.
