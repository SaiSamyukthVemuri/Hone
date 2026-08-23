# 03 Security and privacy

## Session payment amount authority

The **reference price** is resolved **server-side** from current records at the
moment of preparation, and the browser cannot decide it. Precedence is current
client-specific price → current booked-service menu price → block. Conflicting
equally-current client prices fail closed. `expected_amount_cents` submitted by
the UI is stale-display detection only and can never supply a value.

**F-PAY-002 amended what the browser may request, not what it may forge.** The
browser MAY request the operator-authored **final total**, which becomes
`payment_charge_attempts.amount_cents`. That request is refused unless: the
displayed reference still matches the freshly re-resolved one; the amount parses
as strict CAD with at most two decimals inside the ceiling (no coercion, no
rounding, no clamping); and — when it differs from the reference — the
authenticated practitioner's role is `owner` and a bounded non-empty adjustment
reason is supplied. The owner fact comes from
`getCurrentPractitionerWithStudio()`; there is no `is_owner` form field, and the
deciding module is pure and cannot read a request. A $0.00 total prepares
nothing.

The browser still cannot supply the studio, the practitioner, the practitioner's
role, the client, the session, the appointment, the service lineage, the card,
the consent signature, or any Stripe identifier. Once prepared, the amount is an
immutable transaction fact: execution charges `attemptRow.amount_cents` and no
pricing is re-read for it. See docs/06_PAYMENTS_AND_STRIPE.md.

**F-PAY-001 and F-PAY-002: IMPLEMENTED — PENDING MERGE AND PRODUCTION
VERIFICATION.**

## 1. Tenant isolation model

Hone is multi-tenant per studio. The unit of isolation is `studio_id`.

- Every studio-scoped table carries a `studio_id` column.
- Every studio-scoped table has RLS enabled.
> **This section describes the COMMON pattern, not a universal invariant.** Several tables
> deliberately deviate — default-deny with no browser policy at all (`calendar_sync_outbox`,
> `calendar_connection_secrets`, `google_oauth_states`, `admin_action_events`), append-only
> clinical artifacts frozen for **all** roles including `service_role`, an owner-only read tier
> for `record_keeping_exposure_incidents`, and SELECT-only-with-everything-else-revoked for the
> 0157 `session_copy_operations` ledger. **RLS also does not govern TRUNCATE, REFERENCES or
> TRIGGER** — those need explicit table-privilege revocation. Full list and rationale:
> [09_DATABASE_AND_RLS.md](./09_DATABASE_AND_RLS.md) "Deliberate exceptions" and
> "RLS is not the same thing as a table privilege".

- The default SELECT policy on those tables is `using (public.is_studio_member(studio_id))`. The helper is `SECURITY DEFINER` and reads from `public.practitioners` to check that the calling auth user is an active practitioner in the row's studio.
- INSERT / UPDATE / DELETE policies are stricter and table-specific. Most are owner-only or service-role-only.
- Cross-studio data sharing does not exist. The same email can be a client of two studios; each studio gets its own `clients` row.

Practitioners belong to exactly one studio. Clients are studio-scoped (`(client_id, studio_id)` unique). Services, appointments, sessions, treatment plans, intake forms, consent templates, signatures, card payment methods, policy acknowledgements, fee attempts; all studio-scoped, all RLS-gated.

### 1a. Service-role inventory (PR #313)

`createAdminClient()` (`lib/supabase/admin-server.ts`) is the **only** way to build a service-role Supabase client, and it **BYPASSES RLS**. Its use must be **exceptional and justified** — the service-role key is server-only (guarded by `import "server-only"` + the browser-boundary test), and it is used only where RLS cannot apply (session-less public token routes, webhooks, cron, the operator admin console) or where an authenticated action writes through after resolving the caller's studio.

To stop an overlooked or new service-role usage from silently breaking studio isolation, **every runtime `createAdminClient()` call site under `app/` and `lib/` is allowlisted** in `tests/security/service-role-allowlist.ts` — each entry declares a **path**, a **purpose**, a **why** (the reason RLS must be bypassed), and a **scopeGuard** (a real token/signature/studio/client/appointment guard symbol that must appear in the file, e.g. `getCurrentPractitionerWithStudio`, `verifyIntakeToken`, `verifyCancellationToken`, `constructEvent`, `isAuthorizedCronRequest` / `CRON_SECRET`, `isAdmin` / `ADMIN_EMAILS`). The companion test (`tests/security/service-role-allowlist.test.ts`) fails CI if:

- a **new, unallowlisted** `createAdminClient()` usage appears,
- an allowlisted usage is **removed but still listed**,
- an entry is missing a purpose / why / scopeGuard, or
- a file no longer contains its declared **scopeGuard** symbol (a dropped guard).

**Any new service-role usage must add an allowlist entry** with all four fields. This is an **inventory + drift gate** — it proves each call site *has* a guard symbol; it is **not** a formal proof that every query is perfectly scoped. Deeper, per-query audits are still required for the high-risk session-less surfaces (public token routes, webhooks, cron). This complements the browser-boundary test (`tests/lib/supabase/admin-server-boundary.test.ts`), which keeps the service-role key out of client bundles.

## 2. Public route model

> Treatment images (PR #271) are **not** a public surface. The `treatment-images` bucket is private (no public URLs); images are practitioner-only and viewed only via short-TTL signed URLs minted server-side after a studio-ownership re-check. No public/token route below exposes them.
>
> **Storage trust boundary (PR #276, migration 0093 — APPLIED in production; the earlier "not yet applied to prod" note is superseded).** Treatment images are **service-mediated only**: 0093 removes the authenticated `storage.objects` policies, so members cannot read/write objects directly — every upload/sign/archive runs through the server actions (service-role, after a studio re-check). Before signing, the signer (and the page pre-signer) run a strict path validator: the bucket must be exactly `treatment-images` and the path must bind to the caller's studio + the row's client (`<studio_id>/<client_id>/<file>.<jpg|jpeg|png|webp>`), so a **forged/malformed/cross-studio metadata row is rejected, never signed**. The metadata table enforces the same path/bucket shape (CHECK) + parent consistency (client∈studio / session∈studio+client / block∈session+studio) and **freezes identity columns** post-insert (a trigger), so a member cannot move a row to another bucket/path/studio/client. Orphan cleanup runs if a metadata insert fails (critical ops alert if the cleanup itself fails). Signed URLs stay short-TTL and are never stored or logged; archive is metadata-only (soft-delete) — object bytes remain in the private bucket (retention), never exposed.
>
> **Archive scope + zero-row handling (PR #287, no migration).** RLS scopes by studio and 0093 freezes identity columns, but neither stops a same-studio **wrong-client archive** (a `deleted_at` flip on another client's row is a legitimate same-studio update), and the archive action previously scoped its conditional UPDATE by `id + studio_id` only and never confirmed a row changed — so a Client A route call with Client B's image id archived the wrong client's photo, and a nonexistent/already-archived/wrong-client id updated zero rows yet returned success. `archiveTreatmentImageAction` now scopes the UPDATE by `id + studio_id + client_id + deleted_at IS NULL` and requires **exactly one** changed row via `.select("id")`; a zero-row result returns a generic **"Treatment photo not found."** (never revealing whether another client's image exists) and does **not** revalidate the page or report success. App-layer only — no storage/bucket/signing/sanitizer/RLS/schema change. The upload action may now store a `session_id` and/or `session_block_id` (already-existing nullable columns, 0092) so a photo is attached to a session / treatment area. The submitted ids are **never trusted**: the action re-validates them server-side against the caller's studio + client (session ∈ studio+client; block ∈ its session + studio, with the session derived from the block row) and stores only proven-consistent ids, returning a generic error otherwise. This mirrors — and is backstopped by — the 0093 parent-consistency trigger, so a cross-studio/cross-client/mismatched attach is structurally impossible. No storage/RLS/signed-URL/sanitizer change; no public/portal exposure; the recent-sessions read for the selector uses the studio+client-scoped RLS client (ids reach the client only as `<option>` values, never as visible text).
> **Content validation + EXIF stripping (PR #277, no migration).** Uploads no longer trust the browser MIME/bytes. A server-only sharp module (`lib/images/treatment-image-sanitize.ts`, Node runtime) decodes the actual bytes, rejects anything that is not a genuine JPEG/PNG/WebP (SVG, HEIC/HEIF, PDF, HTML, video, corrupt data, **fake-MIME** where declared ≠ detected, empty files, and decompression bombs via an input-pixel cap), and **re-encodes the same format without preserving metadata** so EXIF/GPS/XMP/ICC are stripped before storage. The upload action stores the **sanitized bytes + sanitized content type + sanitized size**; the original filename stays display-only and is never used for the path. Invalid uploads return a generic "Upload a valid JPEG, PNG, or WebP image." and never reach storage. `sharp` is a direct dependency (already used by Next's image optimizer in production).

> **Upload pre/post-buffer size hardening (PR #292, no migration).** Defense-in-depth byte-length bounding around the existing pipeline — **no change to the sanitizer, storage, signed URLs, bucket policy, or UI.** The pre-buffer gate (MIME allowlist + `file.size > 0` + `file.size <= 15 MB`, all before `arrayBuffer()`) trusted the **client-reported** `file.size`, and the re-encoded sanitizer output was never byte-capped. The upload action now adds two guards, both reusing the single-source `TREATMENT_IMAGE_MAX_BYTES` (15 MB) + `validateTreatmentImageUpload`: **(1)** after `arrayBuffer()` and **before** the Sharp sanitizer, it re-validates the **actual buffered length** (`> 0` and `<= 15 MB`) independently of `file.size`, so an over-cap/empty buffer is rejected before any Sharp work; **(2)** after the sanitizer and **before** the storage upload, it caps the **sanitized output length** (`<= 15 MB`), so a re-encode that grows past the limit (bounded otherwise only by the 100 MP pixel guard) is never uploaded or recorded. Errors stay generic ("Image file is empty." / "Image is larger than the 15 MB limit." / "Could not upload the image."); no Sharp/storage detail leaks. The sanitizer remains authoritative for real image type, decodeability, pixel limit, and EXIF/GPS/XMP/ICC stripping; sanitized bytes are still what's stored; storage stays private/service-role-only with no public URLs. Pinned by `tests/app/clients/treatment-image-upload-bounds.test.ts`.
>
> **Tenant consistency constraints (PR #278, migration 0094 — APPLIED in production; the earlier "not yet applied to prod" note is superseded. Migration 0151 later closed the same gap for `appointments`, which 0094 had omitted).** Sensitive clinical/import child tables now prove their parent rows are same-studio at the DB layer (so a row can never carry studio_id=A while pointing at a client/session/appointment/import-batch from studio B). Enforced with **composite foreign keys** (the pattern the payment subsystem + the `treatment_images` 0093 trigger already used) on `sessions`, `session_blocks`, `client_intake_forms`, `imported_treatment_memories`, `treatment_plans`, and `electrolysis_entries` (block must belong to its own session). RLS is unchanged (still the primary studio gate); these FKs are defense-in-depth for every write path including service-role. No app/payment behavior change.
>
> **Clinical lineage enforcement (PR #286, no migration).** 0094 proves a charting row's parents are **same-studio**, but it does NOT stop a same-studio **wrong-client write action**: a Client A route action submitted with Client B's (same-studio) `sessionId`/`blockId`/`entryId` — from a stale tab, a bug, or a tampered form — could write onto Client B's session and corrupt treatment memory. The charting actions now enforce the full `studio → client → session → block → entry` lineage at the app layer: a shared `assertSessionForClient(studioId, clientId, sessionId)` (`lib/sessions/session-lineage.ts`) proves the session belongs to BOTH the caller's studio AND the route client before any write, and every block/entry write is scoped by that (now client-validated) `session_id` (+ `studio_id`/`block_id`), so 0094's block∈session / entry∈block∈session closes the chain. The session-level `actions.ts` already did this (`assertSessionVisible`); PR #286 fixes the `block-actions.ts` charting writes, which previously checked session∈studio only. Mismatches return a generic "Treatment session not found." (never revealing another client/session). Defense-in-depth above RLS; no RLS/schema/charting-behavior change; valid same-client writes are unaffected.

>
> **Intake review integrity — `F-CLIN-004`. Status: APPLICATION DEPLOYED — DATABASE FIX IMPLEMENTED, NOT APPLIED.** `markIntakeReviewedAction` previously filtered its `UPDATE` by intake `id` + `studio_id` + `deleted_at is null` only. It did **not** require the submitted `client_id`, did **not** require `status = 'submitted'` or a non-NULL `submitted_at`, did **not** select the affected row (so a zero-row update reported success), and returned the raw PostgREST `error.message`. One click could therefore mark an intake reviewed that the client had never submitted — a false clinical-review signal on a record whose allergy/EpiPen answers may be incomplete — or, with a mismatched intake id, review a **different client's** intake in the same studio. The action is now a single conditional `UPDATE` requiring `id` + server-derived `studio_id` + the submitted `client_id` + `deleted_at is null` + `status = 'submitted'` + `submitted_at is not null`, proving exactly one affected row with `.select()`. `status`, `reviewed_at` and `reviewed_by` are all server-derived — nothing from `FormData` reaches them. The `status` predicate is also the **race boundary**: under READ COMMITTED the second of two concurrent reviews re-evaluates it against the winner's committed row and matches zero rows, so exactly one transition happens and the original attribution is never rewritten. Every refusal returns one generic string, so the action is not an existence/ownership oracle. `saveIntakeNotesAction` gains the same same-client + affected-row protections and writes `practitioner_notes` only; notes remain editable in all three statuses. In the UI the `alreadyReviewed` boolean is replaced by the real `IntakeStatus`: the *Mark reviewed* CTA renders **only** for `submitted`, `in_progress` shows a durable "the client must submit this intake before it can be marked reviewed", `reviewed` shows a durable server-derived Reviewed state, and the transition now requires the house accessible `ConfirmDialog` (Cancel/Esc issue zero server calls). **The application half is MERGED AND DEPLOYED** (PR #497, merge `b7d85f5`). **The database half is WRITTEN BUT NOT APPLIED.** Migration **0162** replaces the `enforce_intake_terminal_immutability()` body so any incoming transition to `reviewed` requires `old.status = 'submitted'`, a non-null `old.submitted_at`, an unchanged `submitted_at`, and a non-null `reviewed_by` that is an **active practitioner owned by `auth.uid()` in the intake's own studio** — 0118 checked only `user_id`/`active`, which one user holding practitioner rows in two studios could satisfy with the wrong studio's row. `reviewed_at` is now **stamped by the database** (`transaction_timestamp()`), so a backdated or future timestamp cannot be forged. It also makes `reviewed` terminal for end users (closing a two-step `reviewed -> submitted -> reviewed` attribution-laundering path 0118 left open) and forbids review metadata on a non-reviewed row. Service-role review transitions **fail closed**: a caller audit found `status: "reviewed"` written in exactly one place in the repository, on the authenticated path, so the 0118 blanket `auth.uid() is null` exemption is deliberately not preserved for this transition — while the service-role client submission, inserts and link-metadata writes are untouched. **Until 0162 is applied, the direct-PostgREST UPDATE path remains reachable in production.** **And even once applied, 0162 does NOT close the INSERT path:** its guard is a BEFORE UPDATE trigger, so an authenticated member can still INSERT a brand-new row already `reviewed` with a NULL `submitted_at` and a forged `reviewed_at` (reproduced locally and rolled back). That is the broader `authenticated` direct-DML limitation tracked as **L18**, out of 0162's scope, and pinned by the `RESIDUAL` cases in `tests/db/intake-review-db-boundary.db.test.ts`. Repo migration max is `0162`; hosted max is still `0161`. See [`docs/production/known-limitations.md` L22](./production/known-limitations.md), `tests/db/intake-review-db-boundary.db.test.ts` (adversarial matrix + real concurrency race) and `tests/migrations/0162-intake-review-transition-integrity.test.ts`. Do not describe `F-CLIN-004` as closed, remediated, production-verified or fully fixed until 0162 is applied and verified.

| Surface | Public? | What protects it |
|---|---|---|
| `/`, `/pricing`, `/demo`, `/privacy`, `/terms` | Yes | Static marketing content. The waitlist and demo-request forms on these pages submit anonymous server actions that are rate-limited per IP (5/hour) and per normalized email (2/day) via the shared Upstash module, with SHA-256-hashed identifiers and a generic refusal message (PR #187). |
| `/book/<slug>` | Yes | Slug is the studio's public booking identifier (not a token). Rate-limited via Upstash if configured (fails open). Server resolves studio by slug; client is find-or-created with normalized email. |
| `/portal/login` | Yes | Generic-success response regardless of email match (no enumeration). Rate-limited per email + per IP. |
| `/login` (practitioner) | Yes | **Invite-only during the pilot (PR #189), enforced at two layers.** (1) The magic-link request runs through a server action that sets `shouldCreateUser` true ONLY when a pending invitation exists for the email; uninvited unknown emails get the same generic "sent" response and no auth user is created. (2) Migration 0081 removed `handle_new_user()`'s no-invite fresh-studio fallback, so even a path that does create an auth user (Google OAuth cannot pass `shouldCreateUser`) provisions NOTHING: no studio, no practitioner row, and every `(app)` surface denies access when the practitioner row is absent. Studio creation for new pilots happens via service role only. |
| `/cancel/<token>` | Yes via token | Token IS the credential. **Hashed at rest:** the DB stores only `appointments.cancellation_token_hash` (SHA-256, added + backfilled by 0090/PR #260); the raw `cancellation_token` column was **dropped by 0091/PR #264**. The raw token lives only in the outbound link at creation time; resolvers hash the URL token and match the stored hash, so already-emitted links still work. See §4. |
| `/reschedule/<token>` | Yes via token | Same — hash-at-rest (`cancellation_token_hash`); raw column dropped in 0091. |
| `/manage/<token>` | Yes via token | Same — hash-at-rest (`cancellation_token_hash`); raw column dropped in 0091. |
| `/intake/<token>` | Yes via token | Same. |
| `/portal/verify/<token>` | Yes via token | Same. |
| `/calendar-feed/<token>.ics` | Yes via token | Same; carries a **privacy-preserving** iCal feed (PR #289 — no client PII, no treatment context; see below). |

> **Calendar feed default privacy (PR #289, no migration).** The feed URL `/calendar-feed/<token>.ics` is a **bearer secret**: third-party calendar providers (Google / Apple / Outlook) store both the URL and the event contents. Previously the default ICS `DESCRIPTION` carried the **client name** + service **modality** (`Client: <name>` / `Type: Electrolysis`), leaking sensitive appointment context outside Hone the moment a practitioner subscribed. The default feed is now privacy-preserving: every event is `SUMMARY:Hone appointment` + a generic `DESCRIPTION` ("Appointment scheduled in Hone. Open Hone for details.") + an auth-gated `/calendar/<id>` deep link (no token); accurate start/end; a stable PII-free `UID` (`<appointment_id>@hone.care`); `LOCATION` = the studio's already-public address only. The route no longer even SELECTs the client name or service modality (defense-in-depth — a leaked row carries no client PII). **NO** client name / email / phone / address, intake, treatment notes, modality / body-area / treatment context, status, token, signed URL, storage path, or Stripe/payment data appears. Practitioners open Hone (the auth-gated deep link) for real details. Cancelled appointments stay excluded; the 30-day-back + future window, hash-at-rest token lookup (PR #182/0079), and the `Referrer-Policy: no-referrer` / `X-Robots-Tag: noindex` / `Cache-Control: no-store` headers are unchanged. Existing feed tokens keep working (no format/hash change). **Deferred backlog:** an explicit per-studio opt-in to include client names, token rotation/revoke UI, last-used telemetry. Pinned by `tests/app/calendar-feed/feed-privacy.test.ts`.

### Token routes do not get analytics (PR #142)

Vercel Analytics + Speed Insights are removed from the root layout. Safe trees opt in via `app/_components/SafeAnalytics.tsx`. Token subtrees never opt in. Reason: an analytics script that already loaded on an earlier safe page can capture the URL of a later token page in the same SPA session; a runtime pathname denylist cannot prevent this. The only safe fix is structural absence.

### Token routes carry privacy headers (PR #142)

`next.config.ts` adds these to every token URL prefix:

- `X-Robots-Tag: noindex, nofollow`; keeps the URL out of search indexes even if a link leaks.
- `Referrer-Policy: no-referrer`; strips the token URL from the `Referer` header on any outbound navigation initiated from the page.

Each React-tree token page also exports `metadata.robots = { index: false, follow: false }` as a redundant meta-tag signal. The route handler `/calendar-feed/[token]/route.ts` relies on the header alone (no HTML head).

### Token paths are canonicalized before Sentry transmission (F-PRIV-001)

**Status: IMPLEMENTED — PENDING MERGE AND PRODUCTION VERIFICATION.**

The token in these routes is a **replayable bearer credential**: possession of the URL is possession of the authorization. That makes the *path itself* secret material — a different problem from the query string, and one `sendDefaultPii: false` does not solve, because a URL path is not PII, it is a credential.

Before this change, `lib/observability/sentry-scrub.ts` stripped the query string but **deliberately preserved the path**, and never scrubbed `event.transaction` at all. The existing value patterns (JWT triple-segment, a literal `Bearer ` prefix, Supabase token shapes, email, phone) all key off credential **syntax**, so an arbitrary opaque segment like `/intake/9f3a…` passed straight through every one of them.

`lib/security/token-routes.ts` is now the **single canonical registry** of the six token-bearing families, consumed by both the privacy-header block in `next.config.ts` and the Sentry scrubber. `canonicalizeTokenPaths` keys off the **route**, not the credential shape:

```
https://hone.care/intake/RAW?x=1#frag   ->  https://hone.care/intake/[Redacted]
GET /portal/verify/RAW/step/2           ->  GET /portal/verify/[Redacted]
```

What is guaranteed:

- The **credential, every suffix segment after it, the query string and the fragment** are all removed — `/intake/<token>/step/2` is as replayable as `/intake/<token>`.
- **No token-derived hash, fingerprint, prefix or suffix is ever sent.** The placeholder is a fixed constant, so two different credentials produce byte-identical output and telemetry cannot be used to correlate or brute-force a token.
- Protection is **credential-shape independent** — opaque, base64url, UUID-like, dotted non-JWT, percent-encoded and short credentials are all covered.
- It runs **first** inside `redactString`, so every recursive string surface inherits it: `request.url`, `event.transaction`, `event.message`, exception values, breadcrumb messages, fetch/XHR breadcrumb URLs, span descriptions, span data, `extra`, `contexts` and `tags`.
- The same pure module runs in **browser, Node and edge** — the three Sentry configs share it and none reimplements scrubbing locally.
- It is **idempotent** and **non-throwing**; it never parses or decodes a URL, so it cannot re-emit a decoded secret.
- The **route family and origin are preserved** on purpose. The goal is safe diagnostics, not no diagnostics.

Six protected families: `/portal/verify`, `/cancel`, `/reschedule`, `/manage`, `/intake`, `/calendar-feed`.

**Adding a new token-bearing route:** add it to `lib/security/token-routes.ts`. Both privacy headers and Sentry canonicalization then apply automatically, and `tests/lib/security/token-route-parity.test.ts` fails if `next.config.ts` re-declares its own list or if the family set changes without deliberate review. `sendDefaultPii: false` is **not** the only control, and Session Replay and Sentry Logs remain disabled with console breadcrumbs dropped.

This change affects telemetry emitted **from now on**. No historical Sentry event was deleted, no provider-side deletion was performed, and no live token was rotated or revoked. Pinned by `tests/lib/observability/sentry-token-paths.test.ts` (138 cases incl. a deterministic 120-credential generated matrix) and `tests/lib/security/token-route-parity.test.ts`.

### Ops alert observability (PR #153)

A new `ops_alerts` table (migration 0067) records durable, append-only rows for operator-facing silent-failure states: manual fee charge needs_manual_review, Stripe webhook processing failures, card-on-file setup failures, email/SMS give-up, cron route failures. The `lib/ops/alerts.ts:recordOpsAlert` helper is the single entry point.

Redaction rules (enforced before any sink — stderr log, DB insert, admin page, AND critical email). The pure helpers live in `lib/ops/redact.ts`.

**Message redaction (PR #285) — safe by default.** Earlier, `recordOpsAlert` redacted `safe_details` but only **truncated** the free-text `message`; many call sites pass a provider `error.message` (Supabase / Stripe / storage / Twilio / app exceptions), which can carry PII, signed URLs, storage paths, tokens, Stripe object secrets, or DB internals into the log, the `ops_alerts.message` column, the admin page, and the critical email. The helper now runs `redactOpsAlertMessage(message)` centrally before any sink, so **no caller mistake can leak an unsafe message**. The scrubber removes: email addresses; phone numbers (≥8 digits); `Bearer`/`authorization` tokens; `CRON_SECRET`; JWTs; Supabase/S3 signed URLs (`/object/sign/`); sensitive URL query params (`token`/`signature`/`X-Amz-Signature`/`expires`/`download`/`sig`); appointment/intake/manage/cancel URL tokens; `treatment-images/…` + raw `<uuid>/<uuid>/…` storage paths; Stripe secret/restricted keys (`sk_`/`rk_` live/test), webhook secrets (`whsec_`), and client secrets (`pi_…_secret_…` / `seti_…_secret_…`); named JSON fields `token`/`secret`/`client_secret`/`password`/`api_key`; and any leftover ≥32-char high-entropy token. It **preserves** non-secret Stripe object ids (`pi_`/`ch_`/`re_`/`cus_`/… not the `_secret_` form) and standalone UUIDs so operators keep the ids they need for reconciliation/support. Deterministic + idempotent. The typed alert columns (`studio_id`, `client_id`, `stripe_payment_intent_id`, `stripe_event_id`, `route`, `event`, `severity`) are unchanged.

`safe_details` redaction (unchanged in spirit; values now also run the message scrubber):

- Keys matching `token`, `raw_token`, `client_secret`, `secret`, `password`, `cookie`, `authorization`, `auth`, `api_key`, `apikey`, `stripe_secret_key`, `private_key`, `card_number`, `pan`, `cvc`, `cvv`, `ssn`, `bearer`, `cron_secret` are replaced with `[redacted]`.
- Whole VALUES matching a secret shape — Stripe secret/restricted key (`sk_`/`rk_` live/test), webhook secret (`whsec_`), client secret (`pi_/seti_ …_secret_…`), a JWT, a signed URL, or a long bearer-token shape (≥32 alnum/underscore/hyphen, excluding UUIDs + safe Stripe ids) — are replaced with `[redacted]` regardless of key name.
- String values longer than 500 chars are truncated with a `...[truncated]` sentinel so a paste-bomb cannot fill the column.
- The helper itself never throws to the caller; DB insert failures are swallowed and surface only as additional structured stderr logs. (Since PR #193, critical alerts also trigger a best-effort operator email AFTER the durable insert; that email helper also never throws and never calls back into `recordOpsAlert`, so an email failure cannot recurse into more alerts. The email receives the already-redacted message.)
- As call-site hygiene (PR #285), the highest-risk storage-error alerts (`treatment_image_upload_failed` / `…_metadata_insert_failed` / `…_orphan_cleanup_failed` / `…_sign_failed`) now pass generic, event-descriptive messages rather than the raw provider `error.message`; central redaction remains the backstop for every other call site.

RLS posture for `ops_alerts`:

- Studio members read alerts scoped to their studio via `is_studio_member(studio_id)`.
- NULL-studio rows (failures that arrived before lineage was resolved) are visible to service-role queries only.
- No INSERT/UPDATE policy is granted to anon/authenticated; the helper writes via the service-role admin client only.
- No DELETE policy; resolve via `resolved_at` + `resolution_note`.

Operator notification channel (updated PR #219; originally SQL-only when 0067 shipped): durable `ops_alerts` rows are the source of truth, surfaced in the `/admin/ops-alerts` dashboard (PR #193) and via the SQL recipes in [docs/11_RUNBOOK.md](./11_RUNBOOK.md). Since PR #193, CRITICAL alerts additionally send a best-effort operator email through the standalone `lib/ops/alert-email.ts` helper. That helper imports only the bare Resend client and deliberately does NOT import `lib/email/send-appointment.ts` (no dependency cycle with the email subsystem the alerts observe), and it never calls `recordOpsAlert`, so alert-email failures cannot recurse. `OPS_ALERT_EMAILS` (comma-separated recipient list) IS read by that helper. It is **optional outside production** but **REQUIRED in production (PR #291)**: the production env gate (`scripts/check-production-env-gates.mjs`) fails the production build if it does not parse to ≥1 recipient (whitespace-only / comma-only counts as none), so a deploy cannot silently ship with critical-alert delivery disabled. At runtime, when unset or empty, a once-per-instance warning is logged and the email is skipped; the durable row and the dashboard are unaffected either way. Email content carries only the already-redacted message plus safe ids.

### Token routes collapse error states

Token resolution failure (malformed / unknown / expired) always returns the same generic message. Comparing response strings cannot reveal whether the token is structurally valid or only expired. The cancel page and the reschedule page both collapse `invalid_token / already_cancelled / not_cancelable` into one public error.

### Global browser security headers (PR #150)

Every route (`/:path*`) now carries an enforced baseline of cross-cutting browser security headers. The token-route privacy block from PR #142 is layered AFTER the global block so it overrides the global `Referrer-Policy` back to `no-referrer` for token subtrees. The header builder is `lib/security/headers.ts` and is unit-tested.

Globally:

- `Strict-Transport-Security: max-age=31536000; includeSubDomains` (the `preload` directive is intentionally omitted from this first baseline; submitting to hstspreload.org is a longer-term commitment and a separate decision)
- `X-Frame-Options: DENY` (and `Content-Security-Policy: frame-ancestors 'none'` for the same reason): no Hone page may be framed by third-party sites. This is the clickjacking protection around portal consent signing, photo-consent allow/deny, card-on-file Stripe Elements, and the manual fee test-charge button.
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin` (token routes override to `no-referrer`)
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=(), interest-cohort=()`: every browser capability Hone does not currently use is explicitly empty. A future feature that needs camera (e.g. portal photo capture) must deliberately loosen this entry.
- `Content-Security-Policy`: first enforced baseline. Keeps `'unsafe-inline'` for now (Next inline RSC hydration, Tailwind inline styles, Stripe Elements styling). Production excludes `'unsafe-eval'`; development includes it for Next HMR. Allowlisted sources by directive: `script-src https://js.stripe.com https://va.vercel-scripts.com`; `frame-src https://js.stripe.com https://hooks.stripe.com https://m.stripe.network`; `connect-src` carries the specific Supabase project host BOTH as `https://<host>` AND as `wss://<host>` for the realtime websocket (from `NEXT_PUBLIC_SUPABASE_URL` at build), Stripe API surfaces (`api.stripe.com`, `r.stripe.com`, `q.stripe.com`, `m.stripe.network`), and Vercel Analytics + Speed Insights beacons (`va.vercel-scripts.com`, `vitals.vercel-insights.com`); `font-src 'self' data:` (next/font self-hosts the Google fonts at build, so the browser never fetches from `fonts.gstatic.com` at runtime); `frame-ancestors 'none'`; `form-action 'self'`; `object-src 'none'`; `base-uri 'self'`; `upgrade-insecure-requests`.
- No wildcard `*` source. **CORRECTION (2026-07-27): Sentry IS installed** — `@sentry/nextjs` is a direct dependency with `sentry.server.config.ts` / `sentry.edge.config.ts` present and deployed, hardened (`sendDefaultPii` off, deny-by-default scrubbers, Replay and Logs OFF, `/monitoring` tunnel). The earlier "Sentry is NOT installed" statement is superseded. No `fonts.gstatic.com` / `fonts.googleapis.com`.

What this baseline is **not**:
- Not a nonce-based CSP. A future PR may convert `'unsafe-inline'` to per-request nonces.
- Not a report-only path. A future PR may add `Content-Security-Policy-Report-Only` with a report endpoint before tightening further.
- **CSP + Sentry (updated 2026-07-27):** Sentry HAS since shipped, so "they will be added in the Sentry-install PR if that ships" is superseded. Sentry is configured to use the same-origin `/monitoring` **tunnel** specifically so no third-party Sentry ingest domain needs to be added to the CSP. **Verify the deployed CSP against the tunnel configuration before assuming either way** — this was not re-verified in the 2026-07-27 documentation reconciliation.

## 3. Portal session model

| Step | What happens |
|---|---|
| Client requests magic link at `/portal/login` | `requestPortalMagicLinkAction` rate-limits, generates a 32-byte URL-safe-base64 raw token, SHA-256-hashes it, stores the hash + email + studio binding on `client_portal_magic_links`. Returns the SAME generic success regardless of match. |
| Email arrives | The magic-link URL is `https://hone.care/portal/verify/<raw token>`. Token has a **60-minute TTL** (raised from 30 minutes in PR #166 to absorb real-world email-delivery + click-time latency; see [docs/13](./13_BACKLOG_AND_DECISIONS.md) "Secure-link expiry raised to 1 hour"). The TTL constant lives in `app/portal/login/actions.ts:MAGIC_LINK_TTL_MS` and is the single source of truth; the email body copy in `lib/email/templates/portal-magic-link.ts` is pinned by `tests/lib/email/portal-magic-link.test.ts` so the two cannot drift. |
| GET `/portal/verify/<token>` | **NON-consuming.** Validates the token shape + that the row exists + not consumed + not expired + linked to an active client. Renders Continue button or generic unavailable. Reason: email scanners and link-preview bots fetch the URL before the human clicks; the previous one-step verify burned the token against those bots. |
| POST `/portal/verify/<token>` | **Consuming.** Conditional UPDATE on `consumed_at IS NULL` stamps `consumed_at`. Creates the `hone_portal_session` cookie (httpOnly, secure, SameSite=Lax). Resolves to `(studio_id, client_id)`. |
| Subsequent `/portal/*` reads | Action resolves the session cookie via `getCurrentPortalSession()`. Archived clients are blocked. |

Token storage: the DB only ever holds `hashToken(rawToken)`. A DB compromise does not yield usable tokens. Comparison uses constant-time `crypto.timingSafeEqual` over the 64-char hex strings.

## 4. Stripe / payment safety

- **No raw card data ever lands on Hone.** Stripe Elements collects the card directly in the browser via `stripe.confirmCardSetup` (SetupIntent) for save-card and `stripe.paymentIntents.create({ confirm: true })` (server-side) for charge. Hone reads `brand`, `last4`, `exp_month`, `exp_year`, and the Stripe ids; the PAN and CVC never touch Hone's servers or DB.
- **`client_secret` is never persisted.** It is returned to the browser exactly once for the SetupIntent flow; the portal Stripe Elements form consumes it and discards it. Nothing else reads it.
- **Card is linked to a signed card authorization.** `client_payment_methods.card_authorization_signature_id` is the FK to `client_consent_signatures`. The portal flow refuses to save a card without that signature.
- **Manual fee charge is test-mode only today.** Three guards stack:
  1. `inferStripeLivemode()` short-circuits before any Stripe call.
  2. `assertStripeKeyAllowed()` refuses `sk_live_*` without `STRIPE_ALLOW_LIVE_MODE=true`.
  3. `manual_fee_charge_attempts.stripe_livemode` is CHECK-pinned to `false`. Live-mode requires a deliberate migration replacing this CHECK.
- **Atomic claim before any Stripe call.** `claim_manual_fee_charge_attempt` (PR #146) uses `FOR UPDATE` + conditional UPDATE + idempotency-key stamp in one transaction.
- **Deterministic idempotency key.** `hone:manual-fee:<attempt_id>:v1`. Same attempt always produces the same key. Stripe's 24-hour idempotency replays the response on retry within the window.
- **Pending recovery never blind-retries past safe window.** If a `pending_stripe` row has no PI id and the claim is older than 60 minutes, the action returns `needs_manual_review` rather than retrying. See [docs/06](./06_PAYMENTS_AND_STRIPE.md) §6 for the full state machine.
- **No platform customer / no platform payment method.** Every Stripe call carries `{ stripeAccount }`. Customers and PaymentMethods live on the connected account, not on the platform.

## 5. SMS safety

- **Studio toggle off by default.** `studios.send_*_sms` columns default `false`. SMS only goes out when the studio toggle is `true`.
- **Client consent required.** `clients.sms_consent_at` must be set and `clients.sms_opted_out_at` must be null.
- **STOP webhook handled.** `/api/twilio/inbound-sms` verifies the Twilio signature, idempotently stamps `sms_opted_out_at` on the matching client, and never reveals whether the number was known.
- **SMS RPC grants are service-role only.** PR #141 / migration 0062 revoked `claim_sms_send` and friends from `anon` and `authenticated`. The action layer always invokes them via `createAdminClient()`.
- **Twilio credentials gate the whole subsystem.** Missing `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` makes `sendBookingConfirmationSmsToClient` return `ok:false` cleanly; the booking continues.

## 6. Analytics privacy (PR #142)

- Vercel Analytics + Speed Insights are NOT mounted in `app/layout.tsx`.
- A new `app/_components/SafeAnalytics.tsx` wrapper mounts both together.
- Safe routes opt in: `app/(app)/layout.tsx`, `app/admin/layout.tsx`, `app/book/layout.tsx`, `app/_components/PolicyLayout.tsx` (covers privacy + terms), inline on `app/page.tsx`, `app/pricing/page.tsx`, `app/demo/page.tsx`.
- Token subtrees never opt in. The compiled production bundles confirm: the token-route page chunks (`/cancel/[token]`, `/reschedule/[token]`, `/manage/[token]`, `/intake/[token]`, `/portal/verify/[token]`) have zero matches for `vercel-scripts.com`, `vitals.vercel-insights`, `_vercel/insights`, or `_vercel/speed-insights`. The safe-only chunks (`/_next/static/chunks/3494-*.js`, `(app)/layout-*.js`, `book/layout-*.js`) each carry the analytics URL.
- **Why a pathname denylist is not enough:** the analytics script can already have loaded on a previous safe page in the same SPA navigation. By the time a runtime denylist runs, the script is already in the document and ready to observe the new URL.

## 7. Production config fail-closed (PR #143)

- **`ADMIN_EMAILS`**; production with no/empty `ADMIN_EMAILS` makes `isAdmin()` return `false` for everyone. The previous hardcoded `["samyukth.ssv@gmail.com"]` fallback was removed from the production path; dev still keeps it for convenience. A sanitized one-shot server-side log fires on the missing-env path in prod.
- **`PORTAL_FINGERPRINT_SALT`**; production with no salt makes `hashFingerprint()` return `null` (the diagnostic IP / UA / email-hash columns store null). No constant fallback salt in prod, so a leaked DB yields no usable reverse-lookup table. Portal login does NOT break because fingerprint hashing is diagnostic-only. Dev still has a stable fallback.
- **`NEXT_PUBLIC_APP_ORIGIN`**; `lib/app-origin.ts:getRequiredAppOrigin()` throws in production if neither this nor `VERCEL_URL` is set. No silent fallback to `https://hone.care`. Resolution order: explicit env → `VERCEL_URL` (Preview) → `localhost:3000` (dev only) → throw.

## 8. Known risks and deferred hardening

This is the honest list. Do not hide gaps.

| Risk | Status |
|---|---|
| Email reminder outbox / claim discipline | **Resolved (PR #189, migration 0080).** The 24h / 2h reminder cron claims each row atomically via `claim_email_send` before sending (mirror of the SMS claim from 0049: conditional UPDATE on sent-is-null + attempts cap + 5-minute stale-claim window). Overlapping cron runs can no longer double-send. |
| Hashed `calendar_feed_token` storage | **Partially resolved (PR #182, phase 1).** Migration 0079 added `practitioners.calendar_feed_token_hash` (SHA-256 hex, backfilled); the feed route looks up by hash only and no longer SELECTs the raw column. The raw column is kept for rollout compatibility until phase 2 (settings UI shows the URL only at rotation time, then the raw value is nulled). Phase 2 is not started; do not proceed until real Google/Apple calendar subscriptions are confirmed still polling cleanly after phase 1. |
| Comprehensive automated coverage | **Substantial.** Vitest suite (~1,990 tests as of PR #225) plus the GitHub Actions CI job (PR #154) run typecheck, lint, build, `npm test`, `git diff --check`, and `npm run check:stripe-gates` on every PR; the separate `db-integration` job (PR #220/#221) applies the full migration chain to a local Supabase Postgres and runs real RLS/trigger/claim-RPC behavior tests plus the generated types drift check (Supabase CLI pinned to 2.102.0 for grants parity; bumps require re-verification). **CORRECTION (2026-07-27): browser E2E is NOT deferred** — `playwright.config.ts` plus 74 specs under `e2e/` exist at the production SHA and run as the `browser-e2e` CI job. Manual smoke (docs/12) remains a complement for real provider sends, real Stripe Elements and real webhook delivery, not the only browser check. |
| Real legal review of consent / cancellation / card-authorization wording | **Required before live payment.** Drafts exist in code (`docs/05_CONSENT_AND_FORMS.md`). Enforceability under Ontario law depends on lawyer-reviewed wording. |
| Stripe metadata search for stale pending recovery | **Test mode acceptable today.** PR #146 reconciles within a 60-minute window with the deterministic idempotency key; older pending attempts surface "needs manual review." A live-mode PR must add `paymentIntents.search` by metadata before any blind retry. |
| Receipts / charge notice email | **Built in test mode (PR #175)** for session payments on `payment_charge_attempts`: a receipt email is sent on a successful test charge. Still open for live: content/legal review of the template and a charge notice for the legacy manual-fee path. |
| Refunds / disputes | **Refunds built in test mode (PR #178)**: full-amount, reason-agnostic refunds on `payment_charge_attempts`; the dormant 0032 refund tables remain unused. **Disputes are alert-only (PR #179)**: `charge.dispute.created` fires a critical ops_alert; no automated dispute response exists. |
| Practitioner-recovery card-add path | **Deferred.** `client_payment_methods.added_via` allows `practitioner` but no UI exists for that yet. |
| New-client waitlist prospect data (Stage A, dark) | **Open, and deliberately not claimed. THIS IS WHY NO STUDIO MAY BE ENABLED IN STAGE A.** Migration 0185 creates `new_client_waitlist_entries`, a NEW studio-scoped personal-data class (name, email, optional phone for people who are **not** clients and who did not have their details entered by a practitioner). Three things are true of it today and none may be glossed. (1) The **public privacy notice does not yet cover it**: `app/privacy/page.tsx` scopes itself to practitioners and to clients whose information a practitioner enters, and a waitlist prospect is neither — so enabling a studio would collect prospect data outside every disclosed category. (2) It is **not** included in the `/settings/data` studio export; the export page says "supported studio records" rather than claiming completeness, so nothing in the product asserts otherwise, but a studio asked for "everything you hold about me" would not produce these rows. (3) **No retention or purge policy covers it yet** — removal in the product is a terminal `removed` transition that retains the row. Therefore `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` must remain empty in every deployed environment: **no studio may be enabled in Stage A**, and Willow specifically must not be. Closing (1) is Stage B, which additionally owns the notice period the policy itself promises; closing (2) and (3) belongs with the export/offboarding slice (PRIV-01). |
| Two-practitioner studio support | **NOW EXERCISED (corrected 2026-07-27).** Willow Electrolysis has **2 practitioners**, and there are **6 across 5 studios** — the single-practitioner premise below is superseded, so the owner-only exposure-incident tier now has real effect. *(Historical note:)* Code paths are written studio-scoped, not owner-scoped, and at the time of writing the only pilot was single-practitioner. |

> **Clinical delete posture (PR #217, migration 0087):** core clinical/client-history tables (clients, sessions, session_blocks, photos, probe_lots, client_intake_forms, client_tags, treatment_goals, client_personal_notes) are no longer hard-deletable by normal authenticated studio members; the app archives or soft-deletes instead, and treatment memory is preserved because it is the product moat. DELETE remains, explicitly per-command, only where a reviewed UI affordance exists (electrolysis_entries, laser_entries, treatment_plan_stages, client_pricing). Record Keeping logbooks and audit events were already non-deletable (PR #205/#206). Future deletion needs should use archive/correction workflows. **CORRECTION (2026-07-27): the DB/RLS integration harness SHIPPED (PR #220)** — 95 `.db.test.ts` suites run in the `db-integration` CI job against the full migration chain applied from scratch. The earlier "still an open follow-up" framing is superseded. Coverage also includes static SQL tests plus a production catalog audit.

> **Exposure incident owner tier (PR #222, migration 0088):** `record_keeping_exposure_incidents` carries sensitive personal/health information (exposed person's name, address, phone, exposure details, action taken, staff involved), so reading the history and editing records is OWNER-ONLY (`is_studio_owner`); any active studio member can still FILE a new incident (`is_studio_member` INSERT), and there is still no DELETE policy. The audit table's SELECT policy gained a matching carve-out: exposure-incident audit rows (whose `changes` carry old/new field values) are owner-only to read, while all other record types stay member-readable; audit immutability (SELECT-only, trigger-written) is unchanged. This is privacy hardening ahead of any multi-practitioner studio; *(Updated 2026-07-27: Willow is **no longer solo** — she has 2 practitioners, and there are 6 across 5 studios. The owner-only exposure-incident tier therefore now has real effect: a non-owner member can file an incident but cannot read the history.)* Verified by the DB lane (tests/db/exposure-incident-owner-access.db.test.ts). *(Point-in-time note; as of 2026-07-08 supervised live owner-run session payments are live for approved studios — see [docs/production/current-state.md](./production/current-state.md).)*

> **Exposure-incident person autofill (PR #280):** the add/edit exposure form gained a Client / Staff-or-self / Other selector that autofills the existing free-text `exposed_person_full_name`/`phone`/`address` fields. The client + staff option lists are server-fed from same-studio queries (`getClientsForStudio` / `getPractitionersForStudio`), so **no cross-studio person can ever appear as an option**, and the autofill only pre-fills text a member could already type by reading the client list (members can read clients) — it does **not** elevate access. Critically, **no client/practitioner foreign key is stored** on the exposure record (only the free-text snapshot), so the owner-only read posture (0088) and audit carve-out are unchanged; the incident remains a point-in-time free-text record. The disinfectant operator dropdown likewise resolves only same-studio active practitioners (studio-scoped server lookup); a cross-studio id falls back to free text and never attaches.
