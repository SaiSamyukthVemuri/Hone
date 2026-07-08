# Hone — Current Production State

**Canonical single source of truth for "what Hone is today."** When this doc and any
other doc disagree, this doc + the live verifier win. Re-verify against
`supabase migration list --linked` and `node scripts/verify-production.mjs` before
trusting any number here.

- **Last reconciled:** 2026-07-08
- **Production branch:** `claude/build-hone-saas-hOex7`
- **Production HEAD:** `2d4b809777d98a33981753312c13bfd40bfe0c92`
- **Production migration max:** **0112** (`0112_public_booking_horizon_expand.sql`) — local repo max == remote (all applied).
- **Stripe gates:** 15 PASS (`node scripts/check-stripe-gates.mjs`).
- **verify-production:** 11 PASS · 0 FAIL · 1 INCOMPLETE (the INCOMPLETE is the reminder-scheduler heartbeat, which reports INCOMPLETE only because `UPSTASH_REDIS_REST_URL/TOKEN` are unset in the *local* env used to run the script — it is not a production failure).
- **Hosting:** Vercel production (Node 24), deploys from the production branch HEAD.
- **Live customer:** Willow (Chloe) — one live studio with real clients.

See also: [migration-ledger.md](./migration-ledger.md) · [release-changelog.md](./release-changelog.md) ·
[../runbooks/migration-first-process.md](../runbooks/migration-first-process.md).

---

## Deployed major capabilities

- **Auth / tenancy:** invite-only practitioner auth (Supabase); studio resolved server-side
  (`getCurrentPractitionerWithStudio`); owner/member gating enforced server-side; RLS
  (`is_studio_member`) on all tenant tables. Assumes one active practitioner row per user
  (multi-studio user is not supported — see Known risks).
- **Public booking:** service selection, availability scan, cancel/reschedule/manage via
  hashed tokens, intake gating, compact marketing consent, confirmation/reminder emails.
- **Practitioner calendar:** week grid, exact clicked-time booking, blocked-time editing,
  appointment completion, studio time-format preference.
- **Client records:** profile, intake, versioned consent + signatures, treatment notes,
  imported treatment memory (read-model), record-keeping + audit.
- **Charting / treatment memory:** session blocks, observation chips, probe-lot suggestion,
  treatment areas, Before Today / Treatment Intelligence surfaces.
- **Photos:** private `treatment-images` bucket, service-role signed URLs, per-file EXIF
  stripping, tenant-scoped paths, multi-file upload.
- **Client portal:** passwordless magic-link login, portal tasks, practitioner send/copy
  link, portal CTA in appointment emails, append-only access-event log.
- **Postcare:** studio templates, manual send, opt-in auto-send on completion.
- **Payments (Stripe):** **supervised live owner-run session payments are live for approved
  studios** (Willow + Sam's controlled studio) — live Stripe Connect onboarding, live
  charges, live refunds, and live webhook processing are all proven; live/test isolation for
  cards + payment attempts is live; mode-aware dashboard/admin/payment copy is live. Card-on-file,
  receipts, and refunds work in both modes. **Broad self-serve live payments are not ready**
  (a new studio starts in test mode and is enabled per-studio only after supervised
  onboarding + approval). See "Still OFF / held" below for what remains disabled.
- **Messaging:** transactional email (Resend), reminder + postcare + portal emails; SMS
  opt-in with STOP/HELP (pilot scale).
- **Marketing/tracking:** per-studio marketing consent + encrypted provider token storage;
  provider-agnostic conversion service with a Meta CAPI adapter (inert per studio until a
  token is configured).
- **Admin/ops:** `/admin` surfaces (service-role), ops alerts, verifier + gate scripts,
  cron auth, migration-max tripwire.

---

## Recently shipped (0108 → 0112 and the surrounding UI wave)

| Area | Migration | Live status |
|---|---|---|
| Treatment observation chips | **0108** | Live. |
| SMS client-facing 12-hour time format | none (code) | Live. |
| Studio time-format preference (12h/24h) | **0109** | Live (default 12h). |
| Postcare automation (auto-send on completion) | **0110** | Live but **default OFF (`manual`)** — opt-in per studio. |
| Calendar/booking usability (drawer override + exact time, internal scroll + mobile sticky rail, owner-only blocked-time editing, calendar 12h) | none (code) | Live. |
| Client portal: practitioner send / copy login URL + resend rate limits | none (code) | Live. |
| Client portal: CTA in confirmation + reminder emails; login-page copy fix | none (code) | Live. |
| Multiple photo upload | none (code) | Live. |
| Compact marketing-consent UI on public booking | none (code) | Live. |
| Client portal access events + practitioner status card | **0111** | Live. |
| Public booking previous/next availability navigation | none (code) | Live. |
| Public booking horizon 1–12 months | **0112** | Live (default 3 months; existing studios unchanged). |

Details per PR in [release-changelog.md](./release-changelog.md).

---

## Live but default OFF / manual (say so honestly)

- **Postcare auto-send (0110):** shipped, but `studios.postcare_delivery_mode` defaults to
  `manual`. An owner must explicitly switch to `auto_on_complete`, and auto-send is skipped
  if `RESEND_API_KEY` is unset or postcare text is empty (fail-soft — never blocks
  appointment completion). Before enabling for a studio: confirm Resend key + aftercare text.
- **Marketing/tracking (0106/0107):** the framework is live but **inert per studio** — no
  data is sent until an owner configures a provider token. The Meta CAPI adapter *can* POST
  to the real Graph API once a token exists, so treat token configuration as an enablement
  step, not a default.
- **SMS:** live at **pilot scale** only; env-gated on `TWILIO_*`. Broad-SaaS SMS
  (A2P/10DLC registration, per-studio vs shared sender, rate-limiting) is not built.

## Payments — what IS live vs what is still OFF / held

**Live (for approved studios, supervised):** owner-run **session payments** in live mode —
live Stripe Connect onboarding, live charges, live refunds, live webhook processing, all
proven on Willow + Sam's controlled studio. Live/test isolation for cards and payment
attempts is live; mode-aware dashboard/admin/payment copy is live. Stripe gates remain 15 PASS.

**Still OFF / held (do not enable without a dedicated PR + approval):**
- **Broad self-serve live-payment rollout** — not complete. Live is enabled per-studio only
  after supervised onboarding + approval; a new studio starts in test mode.
- **Public booking card collection** — OFF (not wired; a Stripe gate proves the
  `set_studio_require_card_on_file` path has zero runtime occurrences).
- **Deposits / packages / partial payments** — not built.
- **Live manual no-show / late-cancel fees** — on a **server-side hard hold** in live mode
  (`lib/billing/live-charge-reason-allowlist.ts`); only `session_payment` charges live. Test
  mode is unaffected.
- **Public card collection at booking:** not wired (the `set_studio_require_card_on_file`
  path has zero runtime occurrences — a Stripe gate proves this).
- **Deposits / packages / partial payments:** not built.

---

## Known verifier state

`node scripts/verify-production.mjs` → **11 PASS, 0 FAIL, 1 INCOMPLETE**. The verifier is a
read-only production health check (not a pre-live gate). It confirms: remote migration max =
0112; `treatment-images` bucket private + RLS policies + integrity trigger; intake link +
reminder columns/indexes/RPC branches; RLS on 12/12 critical tables; 0 unresolved critical
payment ops alerts; Stripe gates pass. The lone INCOMPLETE is the reminder-scheduler
heartbeat (needs Upstash env to check; a standing local-run limitation, not a prod fault).

## Known risks (see the 2026-07-08 readiness audit for full detail)

- **Multi-studio practitioner not supported** — a user with 0 or 2+ active practitioner rows
  can 500 on login (`getCurrentPractitionerWithStudio`). P0 before any shared practitioner or
  a second studio for the same owner.
- **Portal verify-page copy** says "expire after 30 minutes" (`app/portal/verify/[token]/page.tsx`);
  the actual TTL is 60 minutes (the login page was corrected; this sibling page was missed).
- **No admin-action audit** — operator service-role writes via `/admin` are unlogged.
- **Rate limiters fail OPEN** — if Upstash is down/unset, portal + booking rate limits bypass.
- **Charting validation gaps** — free-text treatment area (no canonical catalog), probe-lot
  number has no FK/CHECK, aftercare-explained is a reminder not a save-gate.
- **Docs beyond this set may be stale** — `docs/13` / `docs/14` are large historical per-PR
  logs, not maintained as current-state. Trust this doc + the verifier, not those.

## Next recommended work (not a commitment)

Per the 2026-07-08 audit: (1) this documentation repair; (2) portal verify-page copy fix;
(3) admin-action audit log (migration-first); (4) multi-studio-user robustness; (5) charting
validation hardening. Referral/conversion analytics and broad SMS hardening are later items.
