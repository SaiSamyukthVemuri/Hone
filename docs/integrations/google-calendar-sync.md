# Google Calendar Two-Way Sync — Architecture

Canonical design for Hone's Google Calendar integration across all phases. **Only
Phase A (connection & OAuth foundation) is implemented today.** Everything after
"Phase B" is design intent, not shipped. When this doc and the code disagree, the
code + the migration ledger win.

- **Status:** Phase A implemented (migrations 0121/0122, dormant). All Google
  flags default **OFF**. No event sync exists. No production connection created.
- **Willow:** not connected. Willow is never used for initial integration
  testing (see §Rollout).

---

## 1. Product constraint: Hone scheduling is studio-wide today

Hone computes public availability at the **studio** level, not per practitioner.
All unavailability (appointments + timed blocks + full-day blockouts + recurring
breaks) is mirrored by DB triggers into one studio-scoped shadow table,
`studio_calendar_reservations` (migration 0030), guarded by a **per-studio GiST
exclusion** that forbids any overlap. There is no per-practitioner or
per-appointment timezone; the single source is `studios.timezone`.

Consequence for this integration:

- The connection schema is **practitioner-scoped** (OAuth is a per-user grant;
  `practitioners.calendar_feed_token_hash` is already per-practitioner) so it is
  future-proof.
- But during the current studio-wide model, Hone designates **exactly one**
  practitioner connection as the studio's calendar owner
  (`calendar_connections.is_studio_calendar_owner`, at most one active per studio).
  That owner's connected calendar will be the future **write target** and, once
  inbound busy ships, its imported busy time will block the **whole studio**.
- **Calendar-owner and write-target are the SAME designation today** — modeled as
  one boolean, `is_studio_calendar_owner`, deliberately not two. They may split
  later when Hone becomes practitioner-resource-aware (see §Future).

**Google busy integration must not ship** until either (A) it intentionally
blocks the whole studio for the designated calendar owner, or (B) Hone's booking
becomes practitioner-resource-aware. This is a hard gate on Phase C.

### Future migration to practitioner-aware scheduling

When Hone adds per-practitioner booking resources, availability computation
(`lib/booking/slots.ts::getAvailableSlots`) will filter reservations + external
busy by the practitioner being booked, and the single `is_studio_calendar_owner`
designation can be joined by a separate `is_write_target` role. The Phase A
schema already carries per-practitioner rows and per-practitioner busy scope, so
that transition is additive.

---

## 2. Dependency choice: direct REST via `fetch` (not `googleapis`)

Chosen: **Option B — direct OAuth + Calendar REST via server-side `fetch`.**
Rationale:

| Criterion | `fetch` (chosen) | `googleapis` |
|---|---|---|
| Bundle / audit surface | zero new deps; native to Node runtime | tens of MB, hundreds of transitive types + a new audit surface |
| Token refresh | explicit; matches our encrypt-at-rest + worker model | implicit auto-refresh hides token state we must manage |
| Testability | mock one thin `fetch` client | heavier client-object mocking |
| Type safety | narrow declared types for the fields we consume | large mostly-unused type surface |
| Maintenance | ~4 hand-written request builders | library upgrades |

Trade-off accepted: we hand-write the request builders (`lib/google-calendar/oauth.ts`).
Revisit only if a later phase needs batch/watch ergonomics the library materially
simplifies.

---

## 3. Data model (Phase A)

Migrations **0121** (connection foundation) + **0122** (OAuth state). All additive,
dormant, default-deny where secret.

- **`calendar_connections`** — per-practitioner, NON-SECRET metadata: google
  account id/email, `write_calendar_id`, `connection_status`, `granted_scopes`,
  `token_expires_at` (operational only), `is_studio_calendar_owner`, health
  fields. Member-readable (`is_studio_member` SELECT); writes service-role only.
  Uniques: one per practitioner; at most one owner per studio (partial); companion
  `(id, studio_id)` for child composite FKs. Same-studio composite FK to
  `practitioners(id, studio_id)`.
- **`calendar_connection_secrets`** — the ONLY place ciphertext lives.
  `encrypted_refresh_token`, `refresh_token_last4`, `encryption_key_version`.
  **RLS on + NO browser-role policy + explicit REVOKE** = a same-studio peer can
  never read another practitioner's token (the explicit close of the 0116
  raw-feed-token peer-read lesson). Token expiry is NOT stored here (it is
  operational metadata on `calendar_connections`); the access token is not
  persisted at all in Phase A.
- **`google_oauth_states`** — single-use OAuth binding: state stored hash-only,
  session nonce stored hash-only (raw nonce is an httpOnly cookie), PKCE verifier
  **encrypted**, 10-min TTL, `consumed_at` CAS, same-studio composite FK.
  Default-deny (RLS + REVOKE), service-role only.

Deliberately NOT created in Phase A: `calendar_event_links`,
`external_calendar_busy_events`, any outbox, webhook/watch tables.

---

## 4. Token encryption & key rotation

Reuses the AES-256-GCM primitive of `lib/conversion/token-crypto.ts` but with a
**dedicated key** and a **versioned, self-describing ciphertext**
(`lib/google-calendar/token-crypto.ts`):

```
v1:<keyVersion>:<base64(iv)>:<base64(tag)>:<base64(ciphertext)>
```

- Key: `GOOGLE_TOKEN_ENCRYPTION_KEY` (32 bytes, hex or base64) +
  `GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION` (positive integer). A dedicated key
  decouples the blast radius / rotation of Google credentials from tracking tokens.
- `import "server-only"`; the key is read from `process.env` only inside server
  modules; decryption happens only in the OAuth callback + (future) sync worker,
  under the service-role client. Fail-closed everywhere (never throws, never logs
  a token or the raw crypto error).
- The refresh token and the PKCE verifier are encrypted (replayable). The access
  token is not stored. The watch-channel token (future) will be **hashed** (it is
  only ever compared, never replayed).

**Key rotation:** the format carries a key version, but Phase A has a single
active key (no previous-key slot). Rotating the key makes existing ciphertext
`decrypt_failed`; because a refresh token is recoverable only by re-consent, a
rotation forces every practitioner to **reconnect**. This is an accepted,
documented operational cost for a small install base. A future change can add a
`GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS` slot for dual-decrypt re-wrap without
changing the stored format.

**Deploy-time gate:** `scripts/check-production-env-gates.mjs` Gate 3 validates
the Google config **shape if present** (32-byte key, positive version, all four
vars set together) — a partial/malformed config FAILS the production build; total
absence PASSES (dormant). The connect action also fails closed at runtime via
`isGoogleTokenCryptoConfigured()`.

---

## 5. OAuth 2.0 security

Authorization-code flow with PKCE (S256), server-side token exchange, and a
single-use state bound to the exact authenticated practitioner + studio + browser
session:

- **Start** (`startGoogleCalendarConnectAction`): authenticated, resolves
  practitioner + studio, **requires the connection flag ON server-side**, requires
  crypto/OAuth configured, mints state (hash stored) + nonce (hash stored, raw in
  an httpOnly cookie) + PKCE (verifier encrypted), redirects to Google.
- **Nonce cookie:** `HttpOnly`, `Secure` in production, **`SameSite=Lax`** (never
  Strict — Google returns via a top-level cross-site redirect and Strict cookies
  would not be sent, failing every valid callback), path `/`, TTL aligned to the
  10-min state.
- **Refresh-token issuance:** `access_type=offline` + `include_granted_scopes=true`
  always; `prompt=consent` only on first connect / `reconnect_required` / when no
  usable refresh token is stored (not forced on a healthy reconnect). If the
  callback returns no refresh token, an existing stored token is **preserved**; if
  none exists, the connection is marked `reconnect_required` (never healthy without
  a usable token).
- **Callback** (`app/api/google-calendar/oauth/callback`): Node runtime,
  force-dynamic, **not** allow-listed anonymous (it carries the session). It:
  requires an authenticated user → **atomically consumes** the state (validates
  hash, expiry, nonce cookie, and `user.id == state.user_id`) → re-checks the
  practitioner is active + belongs to the bound studio + user → exchanges the code
  with the PKCE verifier → verifies granted scopes include calendar-list discovery
  → verifies the Google account identity server-side (userinfo) → encrypts the
  refresh token → persists metadata + ciphertext in **separate** tables → clears
  the nonce cookie → redirects to a fixed `/settings/profile?gcal=…` status (never
  an arbitrary request-supplied redirect).
- **Threat coverage:** state fixation / cross-studio attach (state binding + CAS +
  user re-assert), CSRF (PKCE + double-submit nonce cookie), calendar-id swap
  (write calendar resolved server-side from the connection's own list; selection
  validated against Google's list), peer token read (secret side table
  default-deny), open redirect (fixed allow-listed return paths), plaintext at
  rest (encrypt-before-store, fail if encryption fails), token in logs (hard rule:
  never log code/state/tokens/verifier).

### Incremental authorization strategy

Phase A requests the **minimum** scopes: `openid`, `userinfo.email`, and
`calendar.calendarlist.readonly` (the narrowest official scope that makes calendar
selection possible — grants NO event access). Phase B will add
`calendar.events` (write Hone-owned events) and `calendar.readonly` (read busy)
via **incremental authorization** (`include_granted_scopes=true`). Sam's
controlled connection will require exactly **one** additional consent/reconnect
when Phase B ships. Requesting event access before event sync exists would violate
least privilege.

---

## 6. Privacy defaults (reserved for later phases)

When outbound sync ships, event content is a **pure function over an allow-list**:
default titles `"Hone appointment"` / `"Blocked time"`, `visibility=private`,
`location = studios.address` (already public), start/end = the human
`[starts_at, ends_at)` (never the buffered `blocked_ends_at`). A studio-controlled
`google_event_include_client_name` (default OFF, explicit PHI warning) may add a
first name only. **Never sent:** last name/email/phone, service/modality, notes/
reason, any clinical/session/chart/snapshot data, payment/price/buffer, intake/
consent, internal ids/tokens. No PHI in any log or ops alert. This preserves the
PHI-free posture of the existing iCal feed.

---

## 7. Later phases (design intent, NOT implemented)

- **Phase B — Hone → Google:** durable `calendar_sync_outbox` enqueued at the DB
  commit point (inside the cancel/complete/no_show/reschedule RPCs + the 0030
  mirror trigger for creates/blocks); a drain worker (`/api/cron/calendar-sync`,
  riding the external 15-min scheduler) with exponential backoff + dead-letter;
  `calendar_event_links` mapping; reschedule handled as a linked delete(old) +
  create(new). Booking never blocks on a Google call.
- **Phase C — Google → Hone busy:** `external_calendar_busy_events` (per-
  practitioner, separate from the GiST-excluded shadow), merged into
  `getAvailableSlots`; initial + incremental sync with `singleEvents=true` to
  sidestep Hone's RRULE-less model. **Gated on the studio-wide constraint in §1.**
- **Phase D — Push + reconciliation:** `events.watch` channels (validated by a
  stored channel_id + hashed channel token + resource_id, never headers alone),
  a webhook that validates→enqueues→acks fast, incremental sync via `syncToken`,
  channel renewal + a staleness heartbeat/ops-alert.
- **Phase E — Controlled two-way edits:** a new in-place reschedule RPC applies a
  Google time change only when a studio opts in; a Google deletion of a Hone
  appointment is never a silent delete (conflict state + alert).

### Conflict ownership (later phases)

Hone-linked appointment → **Hone canonical** (Google may change time only if
explicitly permitted; Google deletion → conflict + alert, never silent delete;
Google content edits ignored). Google-originated event → **Google canonical**,
mirrored as external busy, never becomes a Hone appointment. Hone block linked to
Google → **Hone canonical, no sync-back** (justified by hard-delete + no-RRULE +
TZ-reprojection semantics). Loop prevention: a transaction-local origin GUC +
`etag`/`updated`/`last_pushed_version` compare-before-write.

### Fail-closed behavior (reserved for the inbound phase)

Availability is fail-**open** today (a swallowed read error yields more slots).
For **inbound Google busy** this inverts to **fail-closed**: if a practitioner's
Google sync is stale beyond a threshold, Hone does not offer slots it cannot
verify (a missed booking is recoverable; a double-book with a real client is not),
surfaces a staleness banner + ops alert, and never silently claims Google is
current. This is a Phase C concern, not Phase A.

---

## 8. Rollout & Willow gates

1. Apply 0121 + 0122 (additive, dormant). Deploy code. Keep
   `google_calendar_connection_enabled` **OFF**. Do not create a production
   connection.
2. Separate approval → enable the connection flag for **Sam's controlled studio
   only**, connect Sam's controlled Google account, validate the foundation
   (state single-use, secret unreadable by a peer, no token in logs), then
   disable.
3. Each later phase repeats the Sam-only, flag-gated, validate-then-disable
   pattern before any broader enablement.
4. **Willow remains OFF** through every phase until each is proven on Sam's studio
   AND separately approved. Two-way sync is never enabled for Willow without
   separate approval.

---

## 9. Known `reschedule_appointment` status (audit follow-up)

The Phase-audit flagged that `reschedule_appointment` might still reference the
pre-0091 raw `cancellation_token` column. **Investigated and refuted:** the
function was re-created **hash-only in migration 0091** (which drops the raw
column *after* re-creating the RPC), and the **deployed** function references only
`cancellation_token_hash` (`raw column exists = 0`, `references raw = false`,
verified read-only against production). The audit had read the superseded **0029**
definition. **No live defect, no latent defect — no remediation PR is required.**
Phase A does not touch this function. (If a later phase edits it for outbound
sync, re-verify at that time.)
