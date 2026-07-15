# Google Calendar owner connection — operator setup checklist

Phase B1 (owner connection + integration status) is **code-complete and dormant**.
The Settings → Integrations → Google Calendar surface exists, but the connect flow
**fails closed** until the operator provisions the values below. **No hosted Google
Cloud or Vercel change is performed by this PR** — this is a manual checklist for a
later, deliberate enablement. Do **not** enable any `google_calendar_*` sync flag,
the worker, or connect a real account as part of this checklist.

Phase **B2.4 — dual destination** (migration 0131, **APPLIED to production +
dormant**, PR #424 merged + operator-validated 2026-07-14 — see §6) adds two
owner-selectable appointment destinations whose OAuth event scope the **server
derives from the chosen destination** — the browser only picks a destination, never
a scope. This checklist lists **both** destination scopes so the Google Cloud OAuth
client + consent screen are provisioned once for either choice. **Granting a
destination permission (or letting Hone create the empty "Hone Appointments"
calendar) still enables NO synchronization** — the worker and all four
`google_calendar_*` flags stay OFF and Willow stays unconnected. Design detail:
`docs/integrations/google-calendar-sync.md` §3d.

Phase **B2.3-b — reconciliation sweep + heartbeat + route** (authored in-repo,
**dormant, NO migration** — hosted max stays 0131) adds the enqueue-side recovery
net (`/api/cron/calendar-reconcile`, `CRON_SECRET`-guarded) that converges
appointments mutated while outbound intent was unavailable. It is **not**
cron-registered, actuates only within intent-eligible studios (production has none),
never calls Google, and never enables the worker or a flag. **No operator action is
required for B2.3-b** — no Google Cloud, Vercel, or flag change. Design detail:
`docs/integrations/google-calendar-sync.md` §3e.

## 1. Google Cloud OAuth client (one-time)

- Create an **OAuth 2.0 Client ID** (type: Web application) in the Hone Google
  Cloud project.
- **Authorized redirect URIs** — add the EXACT callback URL for each environment
  (no wildcards; the app builds this server-side from the app origin):
  - Production: `https://hone.care/api/google-calendar/oauth/callback`
  - Preview: `https://<preview-domain>/api/google-calendar/oauth/callback` (only if
    OAuth is exercised on a preview deployment; otherwise omit)
- **Scopes** requested by the app (least privilege). The **discovery** scopes are
  requested at connection time; the **event** scope is requested later via
  incremental auth and is **derived by the server from the chosen destination** (the
  browser never selects a scope):
  - Discovery (Phase A, unchanged): `openid`,
    `https://www.googleapis.com/auth/userinfo.email`,
    `https://www.googleapis.com/auth/calendar.calendarlist.readonly` — account
    identity + calendar list for selection only. **No event read/write at connection
    time.**
  - Destination `dedicated_app_created` (Hone **creates** the "Hone Appointments"
    calendar) → `https://www.googleapis.com/auth/calendar.app.created`.
  - Destination `existing_owned` (an **existing calendar the connected user owns**,
    exact Google `accessRole === "owner"`; writer/reader/freeBusyReader/shared are
    excluded) → `https://www.googleapis.com/auth/calendar.events.owned`.
- **Superseded — historical note:** broad `https://www.googleapis.com/auth/calendar.events`
  was the previously-planned event scope. It is **removed from the outbound
  destination contract** (app request path, callback acceptance, readiness, worker
  eligibility, and the DB scope seam) and now authorizes **no** destination. Do **not**
  add it to the consent screen for outbound sync.
- **Scope sensitivity classification** (record from the live console; do **not**
  guess or infer):
  - `calendar.app.created` classification: MUST BE RECORDED FROM CURRENT GOOGLE CLOUD CONSOLE
  - `calendar.events.owned` classification: MUST BE RECORDED FROM CURRENT GOOGLE CLOUD CONSOLE
- The client stays in **Testing** mode until Google app verification is completed for
  whichever destination event scope is put into use (Willow is blocked on this — see
  §1b).

## 1b. OAuth consent screen — Data Access, test users, verification

Configure the OAuth consent screen (Google Auth Platform → *Branding* / *Audience* /
*Data Access*) in the same Hone Google Cloud project as the OAuth client.

- **Data Access (scopes):** add exactly the scopes the app requests — the three
  discovery scopes plus **both** destination event scopes so either destination can
  be authorized: `openid`, `.../auth/userinfo.email`,
  `.../auth/calendar.calendarlist.readonly`, `.../auth/calendar.app.created`, and
  `.../auth/calendar.events.owned`. Do **not** add broad `.../auth/calendar.events`
  (superseded — see §1). Record each scope's sensitivity classification
  (non-sensitive / sensitive / restricted) **exactly as the console shows it** — see
  the two placeholders in §1; do not label a scope without observed console evidence.
- **Publishing status — Testing vs Production:**
  - **Testing:** only explicitly-listed **test users** can complete the flow;
    everyone else is blocked at consent. Use this for Sam's controlled validation.
  - **Production (Published):** required before any non-test user (e.g. Willow) can
    connect. Publishing an app that requests a **sensitive** or **restricted** scope
    triggers Google's **verification** requirement.
- **Test users:** add each Google account that will connect during Testing (e.g.
  Sam's controlled account) under *Audience → Test users*. An account **not** on this
  list cannot consent while the app is in Testing.
- **Unverified-app behavior:** while the app is unverified and in Testing, Google
  shows the **"Google hasn't verified this app"** interstitial; a test user must
  expand *Advanced → Go to Hone (unsafe)* to proceed. This is expected for the
  controlled Sam validation and is **not** an acceptable experience for real
  customers — it is one of the reasons Willow is gated on verification/publication.
- **Testing-mode refresh-token 7-day expiry (important):** while the app is in
  **Testing**, Google **expires refresh tokens after 7 days**. A connection that
  worked during validation will therefore stop refreshing about a week later and land
  in `reconnect_required`. This is a Testing-mode constraint, not a Hone bug; moving
  the app to **Production** (verified) removes the 7-day cap. Do not interpret a
  ~7-day-later refresh failure on a Testing-mode client as a token-encryption or
  storage defect.
- **Verification / publication prerequisites** (needed before a sensitive/restricted
  destination scope can be used by non-test users such as Willow):
  - A published **privacy policy URL** and an app **homepage URL**, both on the same
    verified domain, reachable, and consistent with the app name/branding.
  - **Domain verification** of that domain for the Google Cloud project (via Google
    **Search Console** where Google requires it), so the homepage/privacy-policy
    domain is proven to belong to the project owner.
  - A **scope justification** / demo explaining why each sensitive destination scope
    is required, submitted with the verification request.
  - Consent-screen **branding** (app name, support email, logo) finalized.
  Willow remains blocked until this verification/publication is complete for the
  destination scope actually put into use.

## 2. Server-only environment variables

Set these in Vercel (Production and, if used, Preview) — **server-only, never
`NEXT_PUBLIC_*`, never logged**. All four are required; the connect flow fails
closed (a safe "not configured yet" message) if any is missing:

| Variable | Purpose |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth client id |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth client secret (server-only) |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | 32-byte key (64-hex or base64) — AES-256-GCM refresh-token + PKCE-verifier encryption. Dedicated key, independent of the marketing/CAPI key. |
| `GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION` | Positive integer, stored per row for future rotation |

The exact callback URL is derived server-side as
`${APP_ORIGIN}/api/google-calendar/oauth/callback` (host-header injection guarded);
`APP_ORIGIN` comes from `NEXT_PUBLIC_APP_ORIGIN` (prod) / `VERCEL_URL` (preview).

## 3. Studio enablement (per studio, when ready)

- The Integrations → Google Calendar **card is shown only when the studio flag
  `google_calendar_connection_enabled` is `true`**. It is `false` by default.
- Enabling this flag surfaces the connect UI **only** — it does **not** enable any
  synchronization. The outbound/inbound/two-way sync flags and the global
  `calendar_sync_control.worker_enabled` remain **OFF** and are out of scope here.

## 4. Hard "do not" for this phase

- Do **not** set `google_calendar_outbound_sync_enabled` (or inbound/two-way).
- Do **not** enable `calendar_sync_control.worker_enabled`.
- Do **not** connect Willow's real account (blocked on Google app verification).
- Do **not** register the cron / start the worker.

## 5. Verifying dormancy after setup

After provisioning + connecting a **test** account only:

- `calendar_connections` has the connected row; `calendar_connection_secrets` holds
  the encrypted refresh token (never plaintext; unreadable by any browser role).
- `calendar_sync_outbox` and `calendar_event_links` remain **empty**.
- All `google_calendar_*` studio flags and `worker_enabled` remain **OFF**.
- No Google event was created/updated/deleted (the connection reads calendar
  metadata only).
- **Granting a destination permission does NOT enable synchronization.** Even after a
  destination event scope is granted — or Hone creates the empty "Hone Appointments"
  calendar for `dedicated_app_created` — no event / outbox row / event-link is
  created, the worker + all four `google_calendar_*` flags stay **OFF**, and Willow
  stays unconnected.
- **Disconnect never deletes a Hone-created Google calendar.** Disconnecting revokes
  credentials + clears local state only; removing a Hone-created calendar is a
  separate future product decision, not part of disconnect.

## 6. Controlled production validation — B2.4 dedicated destination (2026-07-14)

The B2.4 dual-destination feature is **deployed to production and remains dormant**;
one controlled Sam-only validation of the `dedicated_app_created` destination was
performed. Recorded state (no secrets / no account email / no provider or calendar
IDs / no sensitive studio identifiers):

**Deploy / migration**
- Migration `0131` **applied** (hosted migration max = `0131`; no `0132`).
- PR **#424 merged** (merge commit `8a25df6…`, reviewed head `3425f72…`); dual-destination
  code deployed; production deployment succeeded at `https://hone.care`.

**Google Cloud (operator setup verified 2026-07-14, reported from the live console)**
- Existing Hone project reused (not recreated); OAuth app
  remains in **Testing** (not published, not submitted for verification).
- **Data Access delta added:** `calendar.app.created` (console classification: **Non-sensitive**)
  and `calendar.events.owned` (console classification: **Sensitive**). Broad `calendar.events`
  is **absent**; no restricted scopes; the three discovery scopes remain present.
- **1** controlled test user listed (Willow not added). Production redirect confirmed exactly
  `https://hone.care/api/google-calendar/oauth/callback`. The existing Hone project and Web
  OAuth client were reused (not recreated); the current console state above — Testing status,
  the listed test user, the exact production callback, and the two scope classifications — was
  confirmed by Sam from the live Google Cloud console **during this validation**, not inferred
  from the pre-existing connection. Google Calendar API enablement is shown directly by the
  successful `Hone Appointments` calendar creation in this validation; the completed incremental
  consent is current functional proof of the OAuth Web client, the redirect URI, and the
  Testing test-user gate.

**Vercel Production (names only — values never read)**
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`,
  `GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION` all present. **Encryption key version = 1** (existing
  encrypted secret rows exist → key **not** rotated). No `HONE_E2E_FAKE_GOOGLE` / test run-id
  in production (the synthetic-Google provider cannot activate; the fake authorize route is
  inaccessible; the real Google transport is selected). No redeploy was needed (no env var changed).

**Controlled Sam connection + dedicated destination result**
- One controlled Sam test studio; `google_calendar_connection_enabled` was already `true`
  (not toggled). The pre-existing discovery-only connection was preserved (connected, discovery
  scopes only, encrypted refresh token, key version 1).
- Owner completed the `dedicated_app_created` flow (incremental consent requested **only**
  `calendar.app.created`). After a designed pre/post-boundary **provisioning-pending** halt on
  the first attempt (grant safely stored, no calendar, no orphan, no false metadata), the built
  **idempotent** "Create the Hone Appointments calendar" retry converged: **exactly one** empty
  `Hone Appointments` secondary calendar was created and adopted.
- Verified read-only: `destination_mode = dedicated_app_created`, app-created calendar id
  populated, `write_calendar_id` = the app-created calendar, `selected_calendar_display_name =
  Hone Appointments`, `destination_configured_at` set, `destination_provisioning_ambiguous_at`
  null; derived readiness = destination-ready; **zero appointment events created**; refresh/re-entry
  is stable (no duplicate calendar, no re-consent).
- Exact grant counts across all connections: `calendar.app.created` = **1**, `calendar.events.owned`
  = **0**, broad `calendar.events` = **0**.

**Dormancy preserved throughout**
- `calendar_sync_control.worker_enabled` **OFF**; outbound / inbound / two-way sync flags **OFF**
  for every studio; `calendar_sync_outbox` = **0**; `calendar_event_links` = **0**; no appointment
  or Google **event** mutation occurred; **Willow remains unconnected**.

**Testing-mode limitation (expected, not a defect)**
- The OAuth app is in **Testing**; Testing-mode Calendar refresh tokens may expire after
  ~7 days. A later `reconnect_required` state around that window is **expected** — not encryption
  failure, token corruption, worker failure, or a regression. The app was **not** published.

**Explicitly NOT done (require separate authorization)**
- `existing_owned` was **not** validated against a real Google calendar.
- No synchronization was enabled (no worker / outbound / inbound / two-way / cron).
- Willow was not connected or added as a Google test user; the app was not published or submitted
  for verification.

**Publication-preparation items (Testing-mode is fine without these; needed only to publish later)**
- `https://hone.care`, `/privacy`, and `/terms` are publicly reachable (HTTP 200). Google Cloud
  homepage/privacy-policy URLs, domain-ownership verification, and app publication/verification
  were **not** pursued in this controlled Testing-mode validation.
