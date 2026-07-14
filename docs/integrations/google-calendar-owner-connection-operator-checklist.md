# Google Calendar owner connection — operator setup checklist

Phase B1 (owner connection + integration status) is **code-complete and dormant**.
The Settings → Integrations → Google Calendar surface exists, but the connect flow
**fails closed** until the operator provisions the values below. **No hosted Google
Cloud or Vercel change is performed by this PR** — this is a manual checklist for a
later, deliberate enablement. Do **not** enable any `google_calendar_*` sync flag,
the worker, or connect a real account as part of this checklist.

## 1. Google Cloud OAuth client (one-time)

- Create an **OAuth 2.0 Client ID** (type: Web application) in the Hone Google
  Cloud project.
- **Authorized redirect URIs** — add the EXACT callback URL for each environment
  (no wildcards; the app builds this server-side from the app origin):
  - Production: `https://hone.care/api/google-calendar/oauth/callback`
  - Preview: `https://<preview-domain>/api/google-calendar/oauth/callback` (only if
    OAuth is exercised on a preview deployment; otherwise omit)
- **Scopes** requested by the app (least privilege):
  - Connection (Phase A): `openid`, `.../auth/userinfo.email`,
    `.../auth/calendar.calendarlist.readonly` — account identity + calendar list
    for selection only. **No event read/write at connection time.**
  - Event write (future upgrade, not this PR): `.../auth/calendar.events` — the
    single narrow scope for Hone-owned events, requested via incremental auth.
    (The reviewed contract targets `calendar.events.owned`; scope alignment is a
    separate follow-up. This PR requests no event scope.)
- The client stays in **Testing** mode until Google app verification is completed
  for the sensitive calendar scope (Willow is blocked on this).

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
