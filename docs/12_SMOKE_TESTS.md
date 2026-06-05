# 12 Smoke tests

This is the catalogue of manual smoke tests every operator and reviewer should know how to run. Some can be executed from a curl loop; many require an authenticated practitioner session and a real test appointment and cannot be done from CI or from an AI harness.

Use [docs/11 Runbook](./11_RUNBOOK.md) for the SQL recipes referenced below.

## 1. Public booking smoke

1. Open `https://hone.care/book/willow-electrolysis`. Expect `200`.
2. Pick "Next available day". Expect a date with at least one slot.
3. Fill the form as a new client. Verify the service picker only shows consultation modalities.
4. Submit. Expect a confirmation banner and a confirmation email in the inbox.
5. SQL:
   ```sql
   select id, status, starts_at, cancellation_token,
          confirmation_send_attempts, confirmation_sent_at
     from public.appointments
    where studio_id = '<studio uuid>'
    order by created_at desc
    limit 5;
   ```
   Expected: new row, `status='confirmed'`, `cancellation_token` non-null, `confirmation_send_attempts >= 1`, `confirmation_sent_at` populated.

## 2. Portal smoke

1. Request a magic link at `/portal/login?studio=willow-electrolysis` for a test client.
2. Confirm the email arrives and the link points to `https://hone.care/portal/verify/<token>`.
3. Open the link in a fresh incognito window. Confirm GET is non-consuming (page renders the Continue form).
4. Click Continue. Confirm landing on `/portal` with the two-zone layout (Needs you / Your info).
5. Verify the cookie `hone_portal_session` is httpOnly + secure.
6. Sign out by clearing the cookie. Confirm `/portal/messages` redirects when anonymous.

## 3. Consent smoke (treatment + photo)

1. As the studio owner in `/settings/consent`, create or activate a `treatment_consent` template.
2. As a test client in `/portal`, sign the form (type your name + submit).
3. SQL:
   ```sql
   select id, template_title_snapshot, template_version, template_hash,
          signature_name, signed_at, response
     from public.client_consent_signatures
    where studio_id = '<studio uuid>' and client_id = '<client uuid>'
    order by signed_at desc;
   ```
   Expected: new row with the title/body/version snapshot, `signature_name` populated, `signed_at` recent.
4. Repeat for a `photo_consent` template.

## 4. Photo denial smoke (PR #137)

1. From a test client's `/portal`, find an active `photo_consent` form.
2. Click "Deny" (or the equivalent UI button).
3. SQL: the new `client_consent_signatures` row carries `response='denied'` and a `response_label_snapshot` describing the deny copy. The signature is real, not absent.

## 5. Card-on-file smoke (test mode)

See [docs/11 Stripe card-on-file smoke](./11_RUNBOOK.md#stripe-card-on-file-smoke-test-mode). Use Stripe test card `4242 4242 4242 4242`.

Expected end state:
- One `client_payment_methods` row with `status='active'`, `stripe_livemode=false`, valid Stripe ids, non-null `card_authorization_signature_id`.
- One `stripe_events` row for `setup_intent.succeeded` with `processed_at` set and no `processing_error`.
- The portal "Your info" zone shows `Visa ending in 4242`.

### 5b. Replace card smoke (PR #151)

1. Sign into the portal as a test client who already has an active card on file (Visa 4242 from §5).
2. Confirm the "Your info" zone shows `Card on file: visa ending in 4242, expires MM/YYYY` plus a **Replace card** button (and the test-mode disclaimer).
3. Click "Replace card". Confirm:
   - Read-only summary remains visible.
   - The replace-mode helper copy renders: "Your current card will be replaced after the new card is saved. No charge will be made."
   - A Stripe Elements `<PaymentElement />` form mounts under the connected-account context.
   - An inline Cancel link is present.
4. Enter a different Stripe test card if practical (e.g. `5555 5555 5555 4444` for Mastercard) or `4242 4242 4242 4242` again. Submit "Save new card".
5. On Elements success, the form replaces itself with the success copy "Card updated. The new card may take a moment to appear on the page."
6. Refresh the portal page. The "Your info" zone now shows the new brand + last4 + expiry.
7. SQL verify:
   ```sql
   select id, status, brand, last4, exp_month, exp_year,
          stripe_livemode, stripe_account_id, stripe_customer_id,
          stripe_payment_method_id, stripe_setup_intent_id,
          card_authorization_signature_id, added_via,
          added_at, removed_at
     from public.client_payment_methods
    where studio_id = '<studio uuid>'
      and client_id = '<client uuid>'
    order by added_at desc;
   ```
   Expected:
   - Exactly ONE row with `status='active'` (the new card).
   - The prior card row is `status='removed'` with `removed_at` populated.
   - The new active row carries a non-null `card_authorization_signature_id`.
   - `stripe_livemode = false` on both rows.
   - The new active row's `stripe_setup_intent_id` is different from the prior row's.
8. Stripe Dashboard → Customers → the connected-account customer for this `(studio, client)`. Confirm a NEW PaymentMethod attached. Confirm a NEW SetupIntent succeeded. Confirm **no PaymentIntent and no Charge were created** during the replace.
9. Click "Replace card" again, then click Cancel. Confirm the form unmounts and the card summary is restored unchanged.
10. (Optional safety) Cancel a Stripe test SetupIntent that has not yet succeeded. Confirm the prior active card row is NOT removed (the webhook only flips on `setup_intent.succeeded`).

## 6. Cancellation reason smoke (PR #144)

1. From a test booked appointment, open the cancel link `/cancel/<token>`.
2. Pick "Schedule changed" from the reason dropdown. Verify the reschedule nudge appears with a `Reschedule instead` button.
3. Click the button. Confirm `/reschedule/<token>` opens.
4. Return to the cancel link. Pick "Schedule changed" again. Add a note. Check the follow-up-allowed box. Submit.
5. SQL:
   ```sql
   select action, actor_type, details, created_at
     from public.appointment_audit
    where action = 'cancelled'
    order by created_at desc
    limit 5;
   ```
   Expected: top row has `details = {"source": "public_token", "reason": "schedule_changed", "reason_label": "Schedule changed", "note": "<your note>", "follow_up_allowed": true}`.
6. Open the appointment in `/calendar/<id>` (signed in as practitioner). Confirm:
   - "Cancellation reason: Schedule changed".
   - "Client note: <your note>".
   - "Follow-up okay" badge.
   - "Cancelled N minutes after booking" if `cancelled_at - created_at <= 15 minutes`.

## 7. Calendar block smoke (PR #139 + #140)

1. As an active non-owner practitioner (if available; otherwise the owner), open `/calendar`.
2. Drag to select a window. Pick "Block time" from the chooser.
3. Confirm the block renders with the warm-tan style (PR #138).
4. Open `/book/<slug>` and the studio's booking horizon date that overlaps the block. Confirm the blocked time is NOT offered as a bookable slot.
5. Repeat with an all-day block. Confirm the block synthesises `[utc(date 00:00), utc(date+1 00:00))` (no extra calendar day swept up).

## 8. Fee protection smoke (PR #145)

1. As owner in `/settings/payments`, set both `late_cancel_fee_cents` and `no_show_fee_cents` to non-zero values via the FeeAmountsCard.
2. Open a cancelled appointment with full evidence (active card, signed authorization, policy ack). The "Cancellation/no-show fee" card should show the eligible preview on the Late cancellation tab and block on the No-show tab with "No-show fee requires a no-show appointment."
3. Try Prepare with no internal note → blocked (client-side disable + server-side `NOTE_REQUIRED_ERROR`).
4. Add note + Prepare → success card "Manual charge prepared. No money has been charged yet."
5. SQL:
   ```sql
   select id, charge_type, status, amount_cents, currency,
          internal_note, timing_classification, created_at
     from public.manual_fee_charge_attempts
    order by created_at desc
    limit 5;
   ```
   Expected: new row with `status='ready'`, `timing_classification='practitioner_asserted'`, your note populated.
6. Set both fee amounts to NULL or 0. Confirm the eligible preview disappears and the blocked panel reads "Late cancellation fee amount is not configured."

## 9. Test-mode manual fee charge smoke (PR #146)

Critical money-adjacent path.

1. Pre-conditions: a `ready` attempt exists from §8 above. Stripe is in test mode (`STRIPE_SECRET_KEY` starts with `sk_test_`).
2. On the appointment detail page, click "Run test charge".
3. Wait for the success card to render.
4. SQL:
   ```sql
   select id, status, stripe_livemode,
          stripe_payment_intent_id, stripe_charge_id,
          stripe_idempotency_key, charged_at
     from public.manual_fee_charge_attempts
    where id = '<attempt uuid>';
   ```
   Expected: `status='succeeded'`, `stripe_livemode=false`, `stripe_payment_intent_id` populated, `stripe_charge_id` populated, `stripe_idempotency_key = 'hone:manual-fee:<attempt-id>:v1'`, `charged_at` set.
5. Stripe Dashboard → Payments under the connected account: exactly one PaymentIntent + Charge with metadata `hone_manual_fee_charge_attempt_id=<your id>`, `hone_environment=test`.
6. Click "Run test charge" again on the same now-succeeded row. The action short-circuits via `already_succeeded`. Stripe Dashboard shows still exactly one PaymentIntent.
7. Refresh the appointment detail page (simulating a network blip mid-action). Confirm the success panel reads the same `stripe_payment_intent_id`.
8. Prepare a separate `ready` attempt on a different appointment. Click "Cancel prepared fee" with a reason. Confirm:
   - Row flips to `status='cancelled'`.
   - `stripe_payment_intent_id` stays NULL.
   - No Stripe call (verify in dashboard).
9. Confirm no email/SMS receipt was sent (none should be; no receipt code exists today).
10. Confirm no live payment exists.

## 9b. Public reschedule safety smoke (PR #149)

Critical safety path. Public reschedule must match public booking on past-slot handling and must never expose raw DB or RPC errors.

1. Create a test appointment in the future. Open its `/reschedule/<token>` link.
2. Confirm the summary loads and slots render.
3. Pick **today** as the date. Confirm slots earlier than or equal to now are NOT offered.
4. Submit a forged form with `newStartsAt <= now()` (browser devtools edit the value attribute on a hidden field or POST directly). Confirm the response is the generic "This reschedule link can't be used right now." copy with no raw Postgres or function-name text.
5. Cancel the original appointment via `/cancel/<token>`. Re-open `/reschedule/<token>`. Confirm the page renders the generic unavailable surface and `/reschedule/<token>`'s read actions do not return the appointment summary.
6. Mark another future appointment `completed` and another `no_show` (via the practitioner calendar lifecycle). Re-open each one's reschedule link. Confirm the same generic behavior.
7. SQL check after a successful reschedule:
   ```sql
   select id, status, starts_at, cancellation_reason, cancelled_at,
          cancelled_by, cancellation_token, updated_at
     from public.appointments
    where studio_id = '<studio uuid>'
      and (id = '<original id>' or starts_at = '<new starts_at>')
    order by updated_at desc;
   ```
   Expected: original row has `status='cancelled'`, `cancellation_reason='Rescheduled via email link'`. New row has `status='confirmed'` and a new `cancellation_token`.
8. SQL check the RPC source carries both guards:
   ```sql
   select pg_get_functiondef(p.oid)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='reschedule_appointment';
   ```
   Expected substring matches:
   - `v_original.starts_at <= now()`
   - `p_new_starts_at <= now()`
9. Run the local automated test harness against the action's source file:
   ```bash
   npm test
   ```
   Expected: every test in `tests/app/reschedule/error-sanitization.test.ts`, `tests/app/reschedule/submitted-start-guard.test.ts`, and `tests/lib/booking/slots-filter-future.test.ts` passes. These pin down "no raw .message leak", "strict > now()" comparison, and the shared future-slot filter.

## 10. Security route smoke

```bash
echo "=== Anonymous routes ==="
curl -sI -o /dev/null -w "/book/willow-electrolysis %{http_code}\n" \
  "https://hone.care/book/willow-electrolysis"
curl -sI -o /dev/null -w "/calendar %{http_code} -> %{redirect_url}\n" \
  "https://hone.care/calendar"
curl -sI -o /dev/null -w "/settings/payments %{http_code} -> %{redirect_url}\n" \
  "https://hone.care/settings/payments"
curl -sI -o /dev/null -w "/portal %{http_code} -> %{redirect_url}\n" \
  "https://hone.care/portal"
curl -sI -o /dev/null -w "/portal/messages %{http_code} -> %{redirect_url}\n" \
  "https://hone.care/portal/messages"

echo "=== Token route privacy headers ==="
for p in /cancel /reschedule /manage /intake /portal/verify; do
  echo "${p}/fake:"
  curl -sI "https://hone.care${p}/fake" \
    | grep -iE '^(HTTP|x-robots-tag|referrer-policy)'
done

echo "=== /calendar-feed/fake.ics has the same headers ==="
curl -sI "https://hone.care/calendar-feed/fake.ics" \
  | grep -iE '^(HTTP|x-robots-tag|referrer-policy)'
```

Expected:

| Route | HTTP | Redirect / headers |
|---|---|---|
| `/book/willow-electrolysis` | `200` | n/a |
| `/calendar` | `307` | `/login` |
| `/settings/payments` | `307` | `/login` |
| `/portal` | `307` | `/portal/login` |
| `/portal/messages` | `307` | `/login` |
| `/cancel/fake` | `200` | `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` |
| `/reschedule/fake` | `200` | same |
| `/manage/fake` | `200` | same |
| `/intake/fake` | `200` | same |
| `/portal/verify/fake` | `200` | same |
| `/calendar-feed/fake.ics` | `404` (no real token) | same |

## 11. Global security header smoke (PR #150)

Run after every deploy. The global headers ship from `next.config.ts` via the builder in `lib/security/headers.ts`.

```bash
echo "=== Global headers on a safe route ==="
curl -sI https://hone.care/book/willow-electrolysis \
  | grep -iE '^(content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|referrer-policy|permissions-policy)'

echo ""
echo "=== Token routes still carry the PR #142 privacy overrides ==="
for p in /cancel/fake /reschedule/fake /manage/fake /intake/fake /portal/verify/fake /calendar-feed/fake.ics; do
  echo "--- $p ---"
  curl -sI "https://hone.care$p" \
    | grep -iE '^(content-security-policy|x-robots-tag|referrer-policy|x-frame-options|x-content-type-options|permissions-policy)'
done
```

Expected on the safe route:

| Header | Value |
|---|---|
| `Content-Security-Policy` | starts with `default-src 'self'`, contains `frame-ancestors 'none'`, contains `https://js.stripe.com`, contains `https://m.stripe.network` in BOTH `frame-src` and `connect-src`, contains the specific Supabase project host BOTH as `https://<host>` AND as `wss://<host>`, no wildcard `*`, no `sentry.io` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (no `preload` for this baseline) |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | starts with `camera=(), microphone=(), geolocation=()`, ... |

Expected on token routes: all of the above EXCEPT `Referrer-Policy` flips to `no-referrer` and `X-Robots-Tag: noindex, nofollow` is added.

Manual browser smoke (still required for full verification):

1. Open `https://hone.care/book/<slug>` in a fresh tab. Confirm public booking renders, slot picker works, no console CSP violations break the flow.
2. Open `https://hone.care/portal/login`. Confirm the page renders.
3. As a test client, sign in via magic link. Confirm `/portal` renders the two-zone layout.
4. Open the portal Add card flow. **Confirm Stripe Elements iframes load**, the test card `4242 4242 4242 4242` can be entered, and `setup_intent.succeeded` arrives at the webhook. CSP-breaking changes typically show up as the Stripe iframes failing to render or `loadStripe` throwing.
5. Confirm browser console shows no CSP violations on any of the core flows.
6. Confirm no second PaymentIntent / Charge was created (this PR adds no money-moving code).

## 12. Ops alerts smoke (PR #153)

Run after any PR that touches `lib/ops/alerts.ts`, the webhook, the cron routes, or the email/SMS helpers.

1. Force a benign critical alert by setting `STRIPE_WEBHOOK_SECRET` to an obviously wrong value in a non-production env and hitting `/api/stripe/webhook` with a real Stripe test event. The route returns 400 (signature mismatch); no ops_alerts row is written for the signature-mismatch path because it's a normal protocol error. Restore the secret.
2. Force a benign `cron_route_failed` by temporarily setting `SUPABASE_SERVICE_ROLE_KEY` to garbage and hitting `/api/cron/appointment-reminders` with the right `CRON_SECRET`. The route's catch fires `cron_route_failed`. Restore the env.
3. Query the table:
   ```sql
   select created_at, severity, event, message, route, safe_details
     from public.ops_alerts
    order by created_at desc
    limit 10;
   ```
   Expected:
   - No raw tokens / `client_secret` / Stripe secrets / card numbers anywhere in `safe_details`.
   - Each row has an `event` matching one of the documented names.
   - Severity is `info`, `warning`, or `critical` (CHECK enforced).
4. Confirm normal flows do NOT spam alerts:
   - Open `/cancel/fake` (invalid token) → no alert.
   - Submit `/portal/login` with a non-matching email → no alert.
   - Trigger a 429 via the rate limiter → no alert.
5. Run the full test suite. The 23 new ops-alerts tests + the source-grep wiring tests guard the contract:
   ```bash
   npm test
   ```

## Pilot control sheet (PR #160)

After a PR that touches Chloe / client testing lands, the operator's smoke is to refresh the tracker and confirm `pilot:check` agrees:

```bash
# 1. Edit the relevant YAML file(s) under pilot-control/.
$EDITOR pilot-control/chloe-testing-queue.yml
$EDITOR pilot-control/product-feedback.yml

# 2. Regenerate the canonical CSVs + the operator Excel.
npm run pilot:export

# 3. Confirm the freshness check is clean before opening the PR.
npm run pilot:check

# 4. Open Hone_Pilot_Control_Sheet.xlsx locally to scan the Dashboard
#    tab (counts by status / priority / pain level) before sharing
#    with Chloe.
open Hone_Pilot_Control_Sheet.xlsx
```

CI runs `npm run pilot:check` on every PR and every push to the default branch. A YAML drift or a missing required field fails the build.

## Portal layout cleanup (PR #159)

After deploy, the operator should confirm the portal's new structure renders end to end.

1. Open the portal as a test client. The top of the page should show: studio eyebrow, "Hello, <first name>.", a short intro line, and a top-right cluster containing an `Email <studio>` button (only when the studio has a postcare contact email on file) + Sign out.
2. If the client has any unsigned forms, unreviewed messages, intake, or unsigned card authorization, the "Needs you" section appears next, unchanged from PR #158.
3. The next four top-level sections appear in order:
   - **Appointments**: next appointment card + "View N more upcoming" disclosure.
   - **Care instructions**: open by default. Summary line reads `"Review these before and after your appointment."` Pre-care + postcare entries render below.
   - **Forms and records**: past messages (if any) + Completed forms (if any). Form rows are quiet (no border cards). Caption verb for non-photo rows reads `"Completed "`. Footnote: `"A viewable copy of signed forms is coming soon."`
   - **Payment method**: the four-state PR #158 surface (no template / authorization needed / signed but no card / active card).
4. Click the `Email <studio>` button in the header. A `mailto:` should open with the subject `Question about my <studio> appointment` pre-filled.
5. Confirm the legacy "Your info" wrapper heading is gone and the bottom "Need help?" section is gone.
6. Smoke the PR #158 guidance once more: for a client with unsigned card authorization, the "Card authorization needed before adding a card" placeholder still renders inside Needs you, and clicking "Review card authorization" still scrolls to the unsigned-forms block via `#forms-to-sign`.

## Card authorization guidance (PR #158)

After deploy, the operator should confirm the client portal and the matching practitioner card render the new explanatory copy.

### Portal (client view)

1. Log into a test client portal at `https://hone.care/portal` (use the magic-link flow) for a client whose studio has an active `card_authorization` template AND the client has NOT yet signed it AND has no card on file.
2. Expect "Needs you" to surface:
   - The `card_authorization` template inside the "Review and sign forms" block.
   - A second calm placeholder titled `"Card authorization needed before adding a card"` with the supporting copy (`"Before you can add a card on file, please review and sign the card authorization form above."` and `"Once that form is signed, the secure card form will appear here. No charge will be made when you add a card."`).
   - A dark `Review card authorization` button. Clicking it scrolls to the "Review and sign forms" block above.
3. Sign the form. The page revalidates; the placeholder disappears and the Add card form appears with supporting copy `"You have signed card authorization. You can now add a card on file."` and `"No charge will be made when you add a card."`.
4. Add a test card. The Add card surface goes away; the "Your info" zone now shows the card summary with a Replace card button.
5. As a separate check, open the portal for a studio with NO active `card_authorization` template at all. "Your info" shows the State A copy: `"Card setup is not available yet. This studio has not enabled online card setup. Please contact the studio if you have a question about payment."`

### Practitioner (client profile view)

1. Open `/clients/<id>` for the same test client. The "Payment method" card should mirror the portal state:
   - Before signing: yellow/amber block, heading `"Card authorization not signed"`, body explaining the Ask the client to open their portal step.
   - After signing, before adding the card: neutral block, heading `"Card authorization signed, but no card is on file yet."`
   - After the card is added: brand/last4/expiry summary with the authorization-signed timestamp.
   - If the studio has no template at all: amber block, heading `"Card authorization template not configured"`.
2. On a cancelled appointment for the same client (calendar detail), open the manual fee card. The blocked reasons should reflect the new wording: `"Card authorization not signed. The client must sign card authorization in the portal before a card can be added or a manual fee can be prepared."`

## Client profile appointment timeline (PR #157)

After deploy, the operator should confirm the new Sessions-tab timeline behaves correctly:

1. Open `/clients/<id>` for a client with at least one appointment in any status.
2. Switch to the **Sessions** tab.
3. Expect an **Appointments** section at the top with one or more of these groups visible (only non-empty groups render):
   - **Upcoming**: future confirmed appointments. Action: Open appointment.
   - **Needs charting**: past confirmed/completed appointments with no linked session yet. Action: Chart session (plus Open appointment).
   - **Charted**: appointments with a linked session via `appointment_id`. Action: View session (plus Open appointment).
   - **Cancelled**: status cancelled. Shows `cancelled_at` and `cancellation_reason` when present. Action: Open appointment (plus View session in the rare-case linked).
   - **No-show**: status `no_show`. Action: Open appointment (plus View session if linked).
4. Each row shows date/time with AM/PM in the user's browser timezone.
5. Click a **Needs charting** row's "Chart session" button. The destination page should show "Linking this session to the selected appointment." and the URL should carry `?appointment_id=<uuid>`.
6. After picking a modality, the new session row in DB should have `appointment_id` populated:
   ```sql
   select id, appointment_id from public.sessions
   where id = '<new session id>';
   ```
7. Return to the client profile Sessions tab. The same appointment now appears under **Charted**, not **Needs charting**. Click View session to confirm the link points at the new session.
8. The top-level **+ Log session** button still works for the client-scoped case and creates `appointment_id = NULL`.

## Migration 0068 verification (PR #156)

After `supabase db push --linked` lands `0068_sessions_appointment_link.sql`, run the following to confirm the column, FK, and indexes are in place. Do NOT run an UPDATE backfill from this recipe; ambiguous matches must stay null.

```sql
-- 1. Column shape
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'sessions'
  and column_name = 'appointment_id';
-- expect: appointment_id | uuid | YES

-- 2. FK definition
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.sessions'::regclass
  and conname ilike '%appointment%';
-- expect: a single row with "FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL"

-- 3. Indexes
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'sessions'
  and indexdef ilike '%appointment_id%';
-- expect: sessions_appointment_id_idx + sessions_studio_appointment_idx, both partial on (appointment_id is not null)

-- 4. Row counts (read-only)
select
  count(*) filter (where appointment_id is not null) as linked_sessions,
  count(*) filter (where appointment_id is null)     as unlinked_sessions
from public.sessions;
-- expect immediately after deploy:
--   linked_sessions = 0
--   unlinked_sessions = current total session row count
-- The linked count climbs only as new appointment-context "+ Chart session" runs.
```

## Quick gates a reviewer can run

GitHub Actions CI (PR #154) runs the full validation suite on every PR. The local equivalent is:

```bash
npm run ci    # typecheck + lint + build + test + check:stripe-gates
git diff --check
```

Lighter manual checks the reviewer can run by hand for spot-checking:

```bash
# Stripe dormancy: diff-only sanity check. The authoritative gate
# is scripts/check-stripe-gates.mjs (run via npm run check:stripe-gates).
git diff | grep -E '^\+' | \
  grep -E 'paymentIntents\.create|charges\.create|refunds\.create|checkout\.sessions|set_studio_require_card_on_file|STRIPE_ALLOW_LIVE_MODE=true'

# Em-dashes in added lines
git diff -- '*.ts' '*.tsx' '*.sql' | grep -E '^\+' | grep -c '-'

# Static stripe imports that aren't behind the existing key gate
grep -rn '@stripe/' --include='*.ts' --include='*.tsx' . | grep -v node_modules | grep -v .next
```

## What the harness cannot verify

When opening a PR, the report MUST explicitly call out which smoke steps were not run. Items that always require manual execution because GitHub Actions CI (PR #154) cannot exercise them without real credentials or a real browser:

- Anything requiring the practitioner session cookie (`/calendar/[id]`, `/settings/*`, the in-app actions).
- Anything requiring a real Resend send to a real inbox.
- Anything requiring a real Twilio SMS to a real phone number.
- Anything requiring a real Stripe test charge against the connected account.
- Anything requiring a real client portal session cookie.
- Anything requiring the Vercel production env dashboard.
