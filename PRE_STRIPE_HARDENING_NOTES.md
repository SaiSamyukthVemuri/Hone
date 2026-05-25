# Pre-Stripe operational hardening — review + deployment notes

> Branch: `claude/pre-stripe-final-hardening`
> Base: `claude/build-hone-saas-hOex7` at `9ae86a60`
> Migration: `supabase/migrations/0033_pre_stripe_operational_hardening.sql`
>
> This document is the reviewer's index. It covers:
>
> * Immediate operational actions to take in production BEFORE the
>   branch is deployed.
> * What this branch changes and why.
> * Concrete plans for the two P1 items that remain follow-on work
>   (`P1-1` reminder claim atomicity, `P1-2` rate limiting,
>   `P1-3` retention + tenant integrity).
> * Validation results.

---

## 0. Production preflight findings (recorded for the runbook)

Read-only preflight against the production Supabase project
`alhhybgqdmcdyzpybykj` found:

- **`INTAKE_SIGNING_SECRET` exists in Vercel Production** (confirmed
  via `vercel env ls production`; value is non-empty). The
  fallback-chain removal in `lib/intake/tokens.ts` therefore does
  not fail-fast at first token-generation in production.

- **Intake preflight** (`status='in_progress' AND deleted_at IS NULL`):
  **0 rows**. No intake-reissue workflow is needed prior to deploy;
  the `INTAKE_SIGNING_SECRET` swap will not strand any client.

- **Confirmation-token preflight** (`status='confirmed' AND
  starts_at > now() AND cancellation_token IS NULL`): **1 row**.
  - `id = 391f0ef8-e1c5-4644-acda-29563a70c397`
  - `starts_at = 2026-05-26 14:00:00+00`
  - `status = confirmed`

  This appointment pre-dates the column-based token rollout. Rather
  than depend on an out-of-band manual `psql` UPDATE during the
  rollout, migration 0033 now contains an **idempotent backfill**
  inside its install transaction (see §2). The backfill:
  - Fills `cancellation_token` with a URL-safe 32-char hex value
    (`replace(gen_random_uuid()::text, '-', '')`) — base16 ASCII,
    free of base64's `+` / `/` characters that previously
    contaminated email URLs.
  - Targets ONLY rows where the token is NULL or whitespace-blank,
    so re-applying against a clean DB updates zero rows.
  - Re-checks the predicate after the UPDATE and raises 23514 if
    any future-confirmed appointment still lacks a token.
  - Logs ONLY the affected count — never any token value — so the
    `migration_log` row is safe to retain in CI artifacts.

The corresponding production rollout-runbook step has been updated:
the manual base64 one-shot UPDATE is no longer the primary fix.
The post-apply verification query now checks for both NULL and
whitespace-blank tokens:

```sql
select id, starts_at, status, cancellation_token
from public.appointments
where status = 'confirmed'
  and starts_at > now()
  and (
    cancellation_token is null
    or length(btrim(cancellation_token)) = 0
  )
order by starts_at asc;
-- expect: 0 rows after migration 0033 apply
```

### How to read the backfill NOTICE line

When migration 0033 applies, the backfill emits a NOTICE of the form:

```
NOTICE (00000): 0033: backfilled N future confirmed appointments missing cancellation_token
```

**`N` is informational only.** It may be `0`, `1`, or more depending
on timing between the preflight query and the apply. **Do NOT use
the value of `N` as a stop condition.** The preflight found one row,
but a confirmed booking placed between preflight and apply would
also be caught by the WHERE filter and increment the count; an
already-applied 0033 (re-run) would emit `0`. Both outcomes are
correct.

**STOP the rollout only on:**

1. The `supabase db push --linked` command emits any `ERROR:` line
   (a failed migration apply leaves the transaction rolled back —
   the migration row is NOT recorded).
2. `npx supabase migration list --linked` does not show `0033` in
   the Remote column after the apply attempt.
3. The Block-2 grant verification at the end of 0033 fails (raises
   inside the `do $block2_0033$` block).
4. The authoritative post-apply query above returns ANY rows
   (i.e. any future confirmed appointment still has a NULL or
   whitespace-blank `cancellation_token`).
5. Any of the post-deploy smoke tests in the runbook fail.

Outside those five conditions, a non-zero `N` is expected and
acceptable. The backfill is structured to be **fail-closed at
SQL level**: it re-runs the same predicate after the UPDATE and
raises a 23514 if any row remains, so the transaction simply will
not commit a partially-backfilled state.

---

## 1. Production no-show shutdown status: ✅ DONE

The operational containment of the unsafe auto no-show flow is **already
complete in production**. No further production SQL is required from
this branch to disable the no-show family.

**Studios fixed:**

| Studio | before `auto_mark_no_shows` | before `send_no_show_followup` | after `auto_mark_no_shows` | after `send_no_show_followup` |
|---|---:|---:|---:|---:|
| Willow Electrolysis | true | false | false | false |
| My Studio `6cdef761-07ce-4c3d-b121-69cb1ec834cf` | true | false | false | false |
| My Studio `9d37c51a-6237-42ef-b9d3-28a567c2bfa8` | true | false | false | false |

**External scheduler:** The `cron-job.org` job that pinged
`/api/cron/no-show-check` is **disabled**. The endpoint in this branch
also returns a non-mutating informational response, so even an
accidental re-enable would not mark any row as no-show.

**Containment must remain in place** until the safe-lifecycle
redesign (`ends_at + grace_minutes`, claim-token duplicate-send
protection, per-run limit, and `mark_appointment_no_show` RPC routing)
ships and is approved. Until then:

- DO NOT re-enable the cron-job.org schedule for `/api/cron/no-show-check`.
- DO NOT flip `auto_mark_no_shows` back to true on any studio.
- DO NOT add a back door in the settings UI; the toggle is also
  force-OFF in `EmailSettingsForm.tsx`.

### Environment variable: `INTAKE_SIGNING_SECRET` — pre-deploy gate

This is an **explicit pre-deploy gate**. The branch MUST NOT be promoted
to production until all three of these are confirmed by the deploy
operator IN ORDER:

1. **Confirm `INTAKE_SIGNING_SECRET` is present in Vercel Production** (and Preview / Development) AND non-empty. The code in `lib/intake/tokens.ts` will throw at first token-generation request if the variable is missing, but the safer check is to confirm presence before the build is promoted.

2. **Run this read-only production query** (via the same `psql --linked` flow used for migration 0032; NOT via SQL Editor):

   ```sql
   select id, client_id, studio_id, status, created_at, updated_at
     from public.client_intake_forms
    where status = 'in_progress'
      and deleted_at is null
    order by updated_at desc;
   ```

3. **If the query returns any rows:** do NOT deploy until each affected client has received a replacement intake link generated by the NEW signing secret. Reissue workflow:
   - For each row, call `ensureIntakeForClient({ studioId, clientId, appOrigin })` (in `lib/intake/queries.ts`). It returns a fresh `url` signed with the new secret.
   - Have the studio email the replacement link to the client from their inbox (Hone does not currently send a self-service "you have an in-progress intake to finish" email; this is a manual one-shot during the rollout).
   - Once every affected client has been resent, promote the build.

If the query returns zero rows: promote freely.

#### Why this matters

- **`.env.local.example`** already documents `INTAKE_SIGNING_SECRET` (line 46), alongside `APPOINTMENT_SIGNING_SECRET`. No file change to `.env.local.example` is required by this branch.
- **Existing tokens signed by the removed fallback chain** (`APPOINTMENT_SIGNING_SECRET` or `SUPABASE_SERVICE_ROLE_KEY`) will return `bad_signature` after deployment. This is correct from a security standpoint (the service-role key should never have been the intake-token signing key) but is a live-client-facing change. The pre-deploy query above is what catches this risk.
- **Local DB** has been verified to have `in_progress_intake_count = 0` after a fresh `supabase db reset` (expected for a wiped local DB). The production-side equivalent of this query MUST be run by the deploy operator before promote.

---

## 2. What this branch changes

### Migration `0033_pre_stripe_operational_hardening.sql`

Adds four hardened SECURITY DEFINER RPCs (all service_role only,
all schema-qualified, all running under `search_path = pg_catalog,
pg_temp`):

| RPC | Purpose |
|-----|---------|
| `record_email_attempt(uuid, text, boolean)` | Re-issue of the migration 0028 function with hardened search_path, schema-qualified `public.appointments`, and EXECUTE revoked from public/anon/authenticated. |
| `public_cancel_appointment_with_token(text, text)` | Public token-based cancellation. Refuses any source state other than `confirmed`. Refuses past-start appointments. Returns a uniform `invalid_token` shape that does not leak whether a real appointment exists for an unknown token. |
| `practitioner_cancel_appointment(uuid, uuid, uuid, text)` | Practitioner-initiated cancellation. Validates active studio practitioner, reads `cancelled_by` from the live practitioner role, refuses non-confirmed source states, writes audit atomically. |
| `mark_appointment_no_show(uuid, uuid, uuid)` | Manual no-show. Returns `too_early` if `ends_at` is still in the future (never marks an in-progress session as no-show). |

Block 2 inside the migration verifies all four RPCs have execute
revoked from anon/authenticated and granted to service_role.

### Application code

| File | Change |
|------|--------|
| `app/api/cron/no-show-check/route.ts` | Replaced mutating cron with non-mutating informational response. Still requires CRON_SECRET. |
| `app/cancel/[token]/actions.ts` | Routes the actual mutation through `public_cancel_appointment_with_token` RPC. Returns a generic `PUBLIC_CANCEL_GENERIC_ERROR` for every non-success outcome; raw DB error messages are logged server-side only. |
| `app/(app)/calendar/actions.ts` | `cancelAppointmentAction` now routes through `practitioner_cancel_appointment` RPC. Adds `markAppointmentCompleteAction` and `markAppointmentNoShowAction` server actions. |
| `app/(app)/calendar/AppointmentLifecycleActions.tsx` *(new)* | Reusable client component exposing Mark complete / Mark no-show buttons. Refuses to render anything if the appointment isn't `confirmed`. Disables both buttons until `ends_at` has passed. | P0-1, P0-3 |
| `app/(app)/calendar/[id]/page.tsx` | **Mounts `AppointmentLifecycleActions` in the existing appointment detail page** (the surface the practitioner lands on by clicking an appointment on the calendar grid). Renders a new "Outcome" section with the two buttons for confirmed appointments; completed / no_show / cancelled appointments each show a terminal status pill. The "Cancel" form is hidden for any terminal state. | P0-1, P0-3 |
| `app/(app)/settings/studio/EmailSettingsForm.tsx` | Adds a `forceOff` flag on toggles. The two no-show toggles (`auto_mark_no_shows`, `send_no_show_followup`) are force-OFF: the UI renders them in the disabled state, refuses to flip them, and the form action always writes `false` for them so a malicious POST can't toggle them on. |
| `app/book/[slug]/actions.ts` | Public booking: replaces `.ilike('email', email)` with `.eq('normalized_email', normalize(email))`. Handles `unique_violation` race against `clients_studio_normalized_email_uniq` by re-reading the winning row. Returns `PUBLIC_BOOKING_GENERIC_ERROR` for any DB-originated failure (raw error logged server-side). |
| `app/intake/[token]/page.tsx` | Two-step fetch: load only header (`status`, `current_step`, `studio.name`) first, then load `responses` ONLY when status is `in_progress`. Submitted / reviewed intakes return `initialResponses: {}` so a refreshed link cannot expose saved answers. |
| `app/intake/[token]/actions.ts` | Returns a generic intake save error message and logs the DB error server-side. |
| `lib/intake/queries.ts` | `INTAKE_LINK_TTL_DAYS` reduced from 60 → 14. Comment explains the choice and the deferred token-version design. |
| `lib/intake/tokens.ts` | Removes the `INTAKE_SIGNING_SECRET → APPOINTMENT_SIGNING_SECRET → SUPABASE_SERVICE_ROLE_KEY` fallback chain. `INTAKE_SIGNING_SECRET` is now required. |
| `CRON_SETUP.md` | Removes the false "idempotent + rate-limited internally" claim. Documents the current reminder-duplicate-send risk and the lifecycle requirements for re-enabling auto no-show. Documents the inline-claim-column plan for the reminder duplicate-send problem. |

### Files NOT changed
- `supabase/migrations/0032_stripe_connect_phase_1.sql` (frozen)
- `supabase/migrations/0028_email_attempt_tracking.sql` (kept; 0033 supersedes the function and its grant)
- Reschedule path (`reschedule_appointment` RPC is already terminal-safe and goes through SECURITY DEFINER)
- Any Stripe / payment application code (none exists yet, per the goal of this branch)

---

## 3. P1-1 plan: reminder duplicate-send protection (deferred)

The reminder cron route can today produce a duplicate email under
concurrent invocations. The two-step `SELECT ... WHERE *_sent_at IS NULL`
followed by `record_email_attempt` is not atomic.

**Recommended fix (next migration 0034, this branch documents it
only):** add per-row claim columns to `public.appointments`:

```sql
alter table public.appointments
  add column reminder_24h_claim_token uuid,
  add column reminder_24h_claim_started_at timestamptz,
  add column reminder_2h_claim_token  uuid,
  add column reminder_2h_claim_started_at  timestamptz;

create index appointments_reminder_24h_claim_idx
  on public.appointments (reminder_24h_claim_started_at)
  where status = 'confirmed' and reminder_24h_sent_at is null;

create index appointments_reminder_2h_claim_idx
  on public.appointments (reminder_2h_claim_started_at)
  where status = 'confirmed' and reminder_2h_sent_at is null;
```

A `claim_appointment_reminder(appointment_id, email_type)` SECURITY
DEFINER RPC issues a single UPDATE that flips the claim_token only if
it is NULL or stale (>5 minutes), and returns the new token on
success. The cron route MUST acquire the claim token before sending
and pass it to `record_email_attempt` (extended to accept a claim
token and refuse mismatched callers). Two concurrent runs land on the
single-row UPDATE; the loser sees zero rows affected and skips. The
5-minute stale lease handles a crashed worker.

This is the same Stripe-style pattern already used in migration 0032
for charge / refund / cleanup attempts.

Until 0034 ships:
* DO NOT schedule the reminder cron at sub-hourly cadence
* DO NOT run two schedulers simultaneously

---

## 4. P1-2 plan: public abuse rate limiting (deployment-ready)

### Scope
Rate-limit these public mutation endpoints:
* `POST` of `publicBookAppointmentAction` (booking submit)
* `POST` of `saveIntakeStepAction` / `submitIntakeAction` (intake save/submit)
* `POST` of `publicCancelAppointmentAction` (cancellation)
* `POST` of `rescheduleAppointmentViaTokenAction` (reschedule)

### Provider + store
**Provider:** Upstash Ratelimit (`@upstash/ratelimit`) backed by
Upstash Redis (`@upstash/redis`). Reasons:
* No new infrastructure to operate — Hone already runs on Vercel and
  Upstash has a free tier sized comfortably above expected public
  traffic for a single-studio MVP.
* Sliding-window algorithm available out of the box; survives Vercel
  serverless cold starts (no in-memory state).
* Composable per-key strategy — we use the same store for multiple
  limit dimensions (IP, slug, email).
* Authentication via env vars: `UPSTASH_REDIS_REST_URL`,
  `UPSTASH_REDIS_REST_TOKEN`.

**Alternative considered + rejected:** edge-compatible in-memory
rate-limiter (e.g. `@hono/rate-limit` or roll-our-own LRU). Rejected
because Vercel cold starts and multi-region deployment make
in-memory state ineffective in production.

### Limits

| Endpoint | Identifier (key) | Limit | Window | Rationale |
|----------|-------------------|-------|--------|-----------|
| `publicBookAppointmentAction` | `book:ip:<ip>` | 10 | 5 min | A real user submits 1; spam-floor heuristic for a single IP burst. |
| `publicBookAppointmentAction` | `book:slug:<studio_slug>` | 30 | 5 min | Single studio shouldn't see > 30 bookings/5min from public funnel. |
| `publicBookAppointmentAction` | `book:email:<normalized_email>` | 5 | 1 hr | Same email shouldn't book > 5 distinct slots/hour. |
| `saveIntakeStepAction` | `intake_save:token:<token>` | 60 | 5 min | Save-as-you-type triggers ~1/30s; 60/5min is generous. |
| `submitIntakeAction` | `intake_submit:token:<token>` | 3 | 5 min | Real users submit once; 3 absorbs retry-on-network. |
| `publicCancelAppointmentAction` | `cancel:ip:<ip>` | 10 | 5 min | Same IP probing many tokens = abuse. |
| `rescheduleAppointmentViaTokenAction` | `reschedule:token:<token>` | 10 | 1 hr | Real reschedules are rare; 10/hr blocks brute force. |

Identifiers normalize: IP is `req.headers.get('x-forwarded-for') ??
'unknown'`; tokens are passed verbatim; normalized_email uses the same
`lower(trim(...))` rule as `clients.normalized_email`.

### Behaviour on exceeded limit
* Return `{ ok: false, error: "Too many attempts. Please try again in a moment." }` to the caller.
* Log internal event `event: 'rate_limited', endpoint, key, limit, window` server-side.
* Do NOT distinguish in the user-facing message between "this IP is over the limit" and "this email is over the limit" — the existence of multiple keyspaces is internal.

### Files to add (next branch)
* `lib/rate-limit/index.ts` — module exposing
  `enforcePublicBookingLimits(req, slug, normalizedEmail)`,
  `enforceIntakeSaveLimit(token)`, `enforceCancelLimit(req)`, etc.
* `app/book/[slug]/actions.ts` — wire `enforcePublicBookingLimits`
  at the top of `publicBookAppointmentAction`.
* (and the equivalents for intake / cancel / reschedule).

### Deployment env vars
```
UPSTASH_REDIS_REST_URL=https://<your>-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=<read-write-token>
```

Set these in Vercel before the rate-limit branch deploys. No
production traffic is affected until that branch is merged — this
hardening branch documents the design only.

---

## 5. P1-3 assessment: clinical retention + tenant integrity

### 5.1 Cross-tenant composite-FK coverage

Tenant-scoped tables in this codebase use a single-column FK to
`clients(id)`, `practitioners(id)` or `services(id)` instead of a
composite FK to `(id, studio_id)`. Single-column FKs do NOT prevent
inserting a row that names `studio_id = A` but `client_id` from
studio B — only application code does that today.

The composite FK fix already exists for the payment tables (migration
0032 adds `clients_id_studio_id_unique`, `practitioners_id_studio_id_unique`,
`services_id_studio_id_unique` and the payment tables FK to those
composite keys). The composite uniques are present in production; the
non-payment tables can adopt them in a follow-on migration with zero
behaviour change since they're already studio-scoped at the
application layer.

**Tables with no composite tenant FK today** (vulnerable to bug-
class "row inserted in wrong studio"):

| Table | Current client_id FK | Recommended fix |
|-------|----------------------|-----------------|
| `appointments` | `(client_id) -> clients(id)` | Add `(client_id, studio_id) -> clients(id, studio_id)` |
| `sessions` | `(client_id) -> clients(id)` | Add `(client_id, studio_id) -> clients(id, studio_id)` |
| `client_intake_forms` | `(client_id) -> clients(id)` | Add composite |
| `client_pinned_notes` | `(client_id) -> clients(id)` | Add composite |
| `client_tags` | `(client_id) -> clients(id)` | Add composite |
| `client_pricing` | `(client_id) -> clients(id)` | Add composite |
| `treatment_plans` | `(client_id) -> clients(id)` | Add composite |
| `treatment_goals` | `(client_id) -> clients(id)` | Add composite |

The local-DB validity check ran against `appointments`, `sessions`,
`client_intake_forms`, `treatment_plans`, `treatment_goals` (joined to
`clients` on `client_id`) and confirmed zero cross-tenant rows. The
same check must be re-run against PRODUCTION before composite FKs are
added; any non-zero row count must be remediated first.

**Recommendation:** ship the composite-FK additions as migration
`0035_cross_tenant_composite_fks.sql` AFTER the payment application
code is wired up, since the payment surface is what raises the
business risk of a cross-tenant bug. Until then the existing
application-level checks plus RLS are the live defense.

### 5.2 Hard-delete paths for clinical data

| Path | Behaviour today | Recommendation |
|------|-----------------|----------------|
| `electrolysis_entries.delete()` in `app/(app)/clients/[id]/sessions/[sessionId]/actions.ts:282` | Hard delete. No audit row. | Replace with soft-delete column (`deleted_at`, `deleted_by`) on `electrolysis_entries`. Write a per-entry audit row before deletion. |
| `laser_entries.delete()` in same file at :304 | Hard delete. No audit row. | Same as above. |
| `sessions` | Already soft-delete (migration 0013) | Keep. |
| `appointment_audit`, `session_audit` | Append-only at SQL level (no app delete path) | Keep. |
| `clients` | `ON DELETE CASCADE` from appointments / sessions / intake / etc. | Audit: if a client is deleted, multiple clinical rows cascade. We should switch to `ON DELETE RESTRICT` and require soft-delete on the client row instead. Reason: insurance / regulatory retention. |

**Recommendation:** add a follow-on migration `0036_soft_delete_clinical_entries.sql`
that:
* adds `deleted_at`, `deleted_by`, `delete_reason` to
  `electrolysis_entries` and `laser_entries`,
* converts the application code to soft-delete,
* writes a session-scoped audit row on every delete attempt,
* and audits a retention policy doc (clinical data minimum 7 years,
  or per local jurisdiction).

This is the second highest-value follow-on after the composite-FK
additions.

### 5.3 Retention plan
A scoped retention policy (separate doc, follow-on) needs to cover:
* Clinical intake: retain 7 years from `submitted_at`.
* Sessions / entries: retain 7 years from `started_at`.
* Audit logs: retain matching the underlying record's retention plus
  1 year.
* Client identifiers: retain until the client requests deletion AND
  the retention windows above have elapsed (GDPR / PIPEDA
  reconciliation).

The retention policy itself is policy work, not a code change.

---

## 6. Validation results

* `npx supabase db reset --local --no-seed` — applied migrations
  `0001` through `0033` cleanly. All migration `0032` Block 2
  verifications (v3, v5, v6, v7, FINAL, FINAL_FIXED) passed. Migration
  `0033` Block 2 verification passed.
* `npm run typecheck` — PASS (no type errors).
* `npm run lint` — PASS (no ESLint warnings or errors; the only
  noise is a deprecation warning about `next lint` migrating to the
  ESLint CLI, unrelated to this branch).

### Executed SQL smoke tests — 11/11 PASS, fail-loud (`psql -v ON_ERROR_STOP=1`)

| Test | Coverage | Result |
|------|----------|--------|
| **H1** | `record_email_attempt` hardened search_path + schema-qualified + grants | PASS |
| **H2** | Completed appointment cannot be cancelled via either RPC surface | PASS |
| **H3** | `mark_appointment_no_show` rejects before `ends_at`, succeeds after | PASS |
| **H4** | Public cancel RPC: past + unknown + empty token uniform | PASS |
| **H5** | `normalized_email` exact-equality + partial unique + 23505 race | PASS |
| **H6** | Calendar reservation preserved through `completed` | PASS |
| **H7** | RPC-level `already_cancelled` idempotency on both surfaces | PASS |
| **H8** | Submitted intake's `responses` JSONB is NOT exposed via the page header SELECT; sensitive marker absent | PASS |
| **H_PAST_CANCEL** | `practitioner_cancel_appointment` refuses past+in-progress; permits future | PASS |
| **H11** | Public fetch token-state collapse: 1 future-confirmed passes; 5 terminal/past/unknown collapse | PASS |
| **H_BOOKING_NO_MUTATE** | Existing client row stays untouched at the data layer | PASS |

Each block re-raises on assertion failure so the script aborts loud
(`raise;` after the `raise notice 'H... FAIL'` line in every
`exception when others then` block).

### Executed application-source assertions — 28/0 PASS via `/tmp/hone_app_assertions.sh`

| Assertion class | Coverage | Result |
|---|---|---|
| **H_SETTINGS_FORCE_OFF** | Settings action writes literal `false` for both no-show toggles; no `readBool` for those fields | PASS |
| **H_BOOKING_NO_MUTATE (source)** | `app/book/[slug]/actions.ts` contains zero `from("clients").update(...)` calls | PASS |
| **H_CANCEL_COLLAPSE** | Single `PUBLIC_CANCEL_GENERIC_ERROR`; no "expired" string; no inline string-literal errors in exported public actions; stale "already cancelled banner" comment removed | PASS |
| **H9** | Zero raw `error.message` returns across `book / cancel / intake`, including `fetchPublicSlotsAction`; intake page gates `responses` SELECT on `!alreadySubmitted` | PASS |
| **H10** | All three calendar lifecycle actions call `getCurrentPractitionerWithStudio()`; none reads identity from formData; resolver uses `supabase.auth.getUser()` + `eq("user_id", user.id)` + `eq("active", true)` | PASS |
| **H_EXPIRED_COLLAPSE** | `tsx`-executed: an HMAC token with `expires_at = past` returns `{ ok: false, error: "expired" }`; the action source collapses to `PUBLIC_CANCEL_GENERIC_ERROR` at every `if (!resolved.ok)` guard | PASS |

The shell harness exits non-zero if any assertion fails. Final
summary line: `PASS: 28 / FAIL: 0`.

---

## 7. Files in this branch

```
M  CRON_SETUP.md
M  app/(app)/calendar/[id]/page.tsx
M  app/(app)/calendar/actions.ts
A  app/(app)/calendar/AppointmentLifecycleActions.tsx
A  app/(app)/calendar/PractitionerCancelForm.tsx
M  app/(app)/settings/studio/EmailSettingsForm.tsx
M  app/(app)/settings/studio/actions.ts
M  app/api/cron/no-show-check/route.ts
M  app/book/[slug]/actions.ts
M  app/cancel/[token]/CancelForm.tsx
M  app/cancel/[token]/actions.ts
M  app/cancel/[token]/page.tsx
M  app/intake/[token]/actions.ts
M  app/intake/[token]/page.tsx
M  lib/intake/queries.ts
M  lib/intake/tokens.ts
A  supabase/migrations/0033_pre_stripe_operational_hardening.sql
A  PRE_STRIPE_HARDENING_NOTES.md  (this file)
```

`supabase/.gitignore` and `supabase/config.toml` are present in the
working tree because `npx supabase init` created them during local
validation. They are NOT part of this commit (see §7 of this doc
for justification). They are useful locally for `supabase db reset
--local` and may be evaluated separately in a tooling-config branch.

All changed/new files are listed above (18 items including this doc).
The `supabase/.gitignore` and `supabase/config.toml` files exist in
the working tree but are NOT part of this commit — see the note
above. No Stripe / payment application code is introduced.
`require_card_on_file` remains defaulted to FALSE for all studios and
no studio is opted in.

### §7: Why `supabase/.gitignore` and `supabase/config.toml` are excluded from this commit

Both files are generated by `npx supabase init` and are essential for
running `supabase db reset --local` against a Docker-backed Postgres,
which we used heavily for migration 0033 validation. Their contents
are mostly default Supabase CLI scaffolding (project_id, study DB port,
extension list), with no Hone-specific configuration. They were not
needed to apply migration 0032 to production via CLI, and the prior
production workflow (`supabase link --project-ref ...`) was done from a
session that did NOT need a tracked `config.toml`.

Excluded reasons:
- This is an operational-hardening branch, NOT a tooling-config
  refactor. Bundling tooling files into this commit conflates two
  concerns.
- The `supabase/.gitignore` lives inside the supabase folder and
  shadows the repo's root gitignore in subtle ways; introducing it
  alongside payment-related code is risky for git ignore semantics
  that the wider team may not have reviewed.
- Local-only development tooling can live un-tracked on Sam's machine
  without affecting CI or production builds.

If the team decides to track them in a future tooling-config branch,
they should be added in isolation with a dedicated review of the
config.toml contents (port assignments, JWT secrets, default
extensions, etc.).

---

## 8. Deferred items (each LABELED as a launch gate for real payments)

Each item below is **deliberately deferred from this branch**. Each
is also **labelled as a blocking gate** for the corresponding payment
feature. None of these may be unblocked without a separate branch,
review, and validation pass.

| Item | Status | LAUNCH GATE — blocks |
|------|--------|----------------------|
| Reminder claim-token columns + atomic claim RPC (CRON_SETUP.md plan, migration 0034) | Deferred | **Blocks re-enabling the reminder cron at sub-hourly cadence AND blocks any payment notification email that piggybacks on the reminder pipeline.** |
| Public abuse rate-limiting via Upstash Ratelimit (plan in §4 of this doc) | Deferred | **Blocks public payment-method-setup pages (`/book/[slug]` with card-on-file enabled), public card-recovery URLs, and any public Stripe-touching surface. Required before `require_card_on_file` is enabled for any studio.** |
| Composite-FK additions on non-payment clinical tables (migration 0035, see §5.1) | Deferred | **Blocks enabling Stripe charges for studios that operate more than one studio entity OR share clients between studios. Single-studio Stripe Phase 1 can ship without this; multi-studio MUST not.** |
| Soft-delete on `electrolysis_entries` / `laser_entries` (migration 0036, see §5.2) | Deferred | **Blocks the multi-studio rollout for clinical-record retention/compliance reasons. Single-studio Stripe Phase 1 can ship without this; longer-term clinical retention policy depends on it.** |
| Clinical retention policy doc (see §5.3) | Deferred | **Blocks any production use of intake clinical data beyond the current single-studio pilot. Required before onboarding studios in regulated jurisdictions (Quebec PIPEDA-equivalent / EU GDPR).** |
| Intake token-version column + HMAC payload upgrade | Deferred | **Soft launch gate.** Status-based revocation in this branch handles the highest-value risk (submitted/reviewed forms cannot expose saved responses on a refreshed link). Token-version is a future hardening item; does not block Stripe phase 1. |
| Terms-of-service consent evidence linked to payment events | Deferred | **Blocks first live `create_or_claim_charge_attempt` against a real customer. Migration 0032's `payment_consents` table already records consent at booking; the gap is connecting it to a versioned terms-of-service record so an operator can prove "this customer accepted v1.4 of Hone's terms at booking time" during a dispute response. Required before live payments process.** |
| Mounting `AppointmentLifecycleActions` in the appointment detail page | **DONE in this branch** at `app/(app)/calendar/[id]/page.tsx`. See §2 above. |
