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
| 0141 `onboarding_invitation_reconciliation` | reconcile/accept/read RPCs + centralized policy versions; updates `handle_new_user` | **No** (repo-only) |

Both are additive, single-transaction. **Apply migration-first** (before the code
that reads the new column/table), then deploy code. **Rollback:** the code is
skew-safe, so reverting the migration leaves the app functional (onboarding
degrades to off). Required cross-PR apply order (do not merge/apply out of order):

```
0135–0139  PR #458 (per-practitioner availability)
0140–0141  PR #459 (onboarding: state + reconciliation)   ← this work
0142       PR #460 (internal booking; renumbered from 0141)
```

## 3. Admin studio creation

`/admin/studios/new` → `createStudioWithOwnerInvite`. New opt-in checkbox
**"Enable guided onboarding"**:

- **Off (default):** byte-for-byte today's — flag stays false, **no** welcome
  email, **no** `studio_onboarding` seed row.
- **On:** sets `onboarding_v2_enabled` at insert, then (best-effort, never blocks
  the create) sends the welcome email and seeds `studio_onboarding`. Emits the
  `studio_created` analytics event regardless.

**Welcome email variant** (`lib/email/templates/welcome.ts`): `new_owner` vs
`existing_account`, chosen by an accepted-invitation heuristic (never touches
`auth.users`/`practitioners`). The existing-account copy does **not** claim
access is complete and notes the owner may need to review current policies.

## 4. Email recovery / resend runbook

- **Send outcome** (Sent / Failed / not-sent) is recorded on
  `studio_onboarding.welcome_email_status` + `welcome_email_last_sent_at` +
  `welcome_email_variant`. **No delivered/opened tracking** (no Resend webhook /
  pixel — deliberate clinical-data privacy posture). Never marked "delivered".
- **Dev/preview:** Resend is null/dummy-keyed, so nothing sends; the status is
  recorded honestly. Studio creation never depends on email.
- **Resend:** admin studio-detail page → **Resend welcome email**
  (`resendWelcomeEmailAction`, operator-only, idempotent, re-stamps the status).
- **"Accepted"** is derived from `pending_invitations.status` (first sign-in),
  not from email.

## 5. Existing-user invitation reconciliation (migration 0141)

**Problem:** `handle_new_user` only provisions the membership when a **new**
`auth.users` row is inserted. An email that already has a Hone account, invited
to a new studio, signs in without a new auth row → the invite stays pending → the
user hits `/no-access`.

**Fix — two authenticated, self-scoped `SECURITY DEFINER` RPCs** (identity from
`auth.uid()` + verified `auth.users` email; the caller passes **nothing**):

- `reconcile_my_pending_invitation()` — called in `/auth/callback` after sign-in.
  Links the membership **only** when a **single** existing practitioner row for
  this user carries **both** current-version terms **and** privacy acceptance;
  copies those four exact values (**never `now()`**). Otherwise returns
  `acceptance_required` and leaves the invite pending.
- `accept_my_pending_invitation()` — called by `/accept-invitation` after the
  user confirms current policies; stamps the **actual transaction time** + the
  current versions (genuine fresh consent).
- `my_pending_invitation()` — self-scoped read for the acceptance page (studio
  name + role only).

Policy versions are centralized (`current_terms_version()` /
`current_privacy_version()`); `handle_new_user` uses the same source. Per-email
advisory xact lock + `FOR UPDATE` for concurrency; never overwrites another
user's `user_id` (returns `conflict`); `accepted_at` is consumption time,
distinct from the legal `terms_accepted_at`.

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
invitation / onboarding row; (6) conflicting membership → safe support message.

Welcome email: send outcome recorded (Sent/Failed); admin Resend is idempotent;
never claims delivered.

**Coverage:** `tests/db/studio-onboarding.db.test.ts`,
`tests/db/invitation-reconciliation.db.test.ts` (A–N),
`e2e/onboarding.spec.ts`, `e2e/invitation-reconciliation.spec.ts`,
`tests/lib/onboarding/*`, `tests/lib/email/welcome-email.test.ts`,
`tests/migrations/0140-*`, `tests/migrations/0141-*`,
`tests/app/dashboard/onboarding-flag-off-contract.test.ts`.
