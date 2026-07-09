# Admin Action Audit Log

Production infrastructure (migration **0113**, `admin_action_events`) that records
sensitive **admin/operator** actions — especially the service-role, cross-studio writes
reachable from `/admin` — so we can answer, for any operator action: **who** did it,
**what** they did, **which** studio/resource it affected, **when**, and **whether** it
succeeded, failed, or was blocked.

This is NOT a client feature. It exists for accountability and forensics as Hone adds studios.

## What is logged (PR 1)

Every event carries: `actor_user_id`, `actor_email` (the operator's own internal
ADMIN_EMAILS address), `actor_role`, `studio_id` (if any), `target_type`, `target_id`,
`action`, `outcome` (`started` / `succeeded` / `failed` / `blocked`), `source`,
`request_id`, and an **allowlisted + redacted** `metadata` jsonb, plus `created_at`.

Wired admin actions:

| Action | `action` | When it logs | Safe metadata |
|---|---|---|---|
| Create studio + owner invite (`app/admin/studios/new/actions.ts`) | `studio_created` | `blocked` (non-admin), `started` (before writes), `succeeded`, `failed` | `slug`, failure `reason` |
| Resolve an ops alert (`app/admin/ops-alerts/actions.ts`) | `ops_alert_resolved` | `blocked`, `succeeded`, `failed` | `has_resolution_note` (boolean) |
| Mark a demo request contacted (`app/admin/actions.ts`) | `demo_request_contacted` | `blocked`, `succeeded`, `failed` | — |

The single writer is `logAdminAction()` in `lib/audit/admin-actions.ts`.

## What is intentionally NOT logged

- **No secrets/tokens/URLs/cards/passwords/cookies/authorization headers.** The table has
  **no column** for any of these, and `sanitizeAdminAuditMetadata()` drops any metadata key
  that looks credential-shaped (`token`, `secret`, `password`, `key`/`api_key`, `url`,
  `card`, `cvc`, `authorization`, `cookie`, `bearer`, `jwt`, `magic`, …) and then runs the
  shared `redactOpsAlertDetails()` value-level scrubber (Stripe secrets, JWTs, signed URLs,
  emails, phones, high-entropy tokens).
- **No PHI / intake / clinical / payment detail.** Metadata keys like `email`, `phone`,
  `address`, `ssn`, `dob`, `note_text`, `body`, `payload` are dropped. Free-text operator
  input (e.g. an alert resolution note) is logged only as a boolean (`has_resolution_note`),
  never as text. The studio **owner's** email/name (entered by the operator when creating a
  studio) is deliberately not logged — only the public `slug`.
- **No read-only admin page views** (PR 1 logs mutations + blocked attempts only).
- `sendTestCriticalAlertAction` is deferred — it is already recorded via `recordOpsAlert`.

## Security / access model

- **RLS enabled, NO policies at all.** Normal authenticated users and anon are denied
  SELECT/INSERT/UPDATE/DELETE. There is no `is_admin()` SQL function (admin is app-level
  `ADMIN_EMAILS` via `lib/admin.ts`), and an operator is not a studio-member of the studios
  they act on — so RLS cannot express "admins may read." **Both writes and reads go only
  through the service-role client**, from server code that has already passed the `isAdmin`
  gate (the `/admin/audit` page re-checks `isAdmin` before reading).
- **Append-only.** No UPDATE/DELETE path for anyone but the service role; write grants are
  revoked from `authenticated` + `anon` (belt-and-suspenders). Operators cannot erase their
  own trail via the app.
- **Durability over referential integrity.** `studio_id` / `actor_user_id` / `target_id`
  have **no foreign key** — an audit event survives deletion of the studio/user it
  references (and never blocks such a delete) and keeps the raw id for forensics.

## Fail-soft (PR 1)

`logAdminAction()` is **fail-soft**: it never throws, so an audit-log outage (or the table
not existing pre-migration) can never break the admin action it records. A logging failure
emits a safe console marker (`admin_action_audit_log_failed` — no secrets) which can be
alerted on. For the highest-risk write (studio creation) a `started` event is logged before
the write so a trail exists even if the terminal event fails.

**Recommendation (future hardening, not PR 1):** audit-*before*-write **blocking** (refuse
to create a studio if the `started` audit row cannot be written) is intentionally NOT
enforced — blocking a legitimate operator action on an audit-infra hiccup is worse than a
missed row that is itself alerted. Revisit if a stricter compliance posture is required.

## How to inspect

- **In-app:** `/admin/audit` (admin-only) shows the 50 most recent events with safe columns
  (time, actor, action, outcome, studio, target, safe metadata) — no raw JSON dump. Linked
  from the `/admin` console "Operator references".
- **SQL (read-only, service-role):**
  `select created_at, actor_email, action, outcome, studio_id, target_type, target_id, metadata
   from public.admin_action_events order by created_at desc limit 50;`

## Remaining actions to wire (follow-up)

Future admin mutations (e.g. any admin billing/payment status change, per-studio payment
enablement, support edits to studio/client state) should call `logAdminAction()` on the same
pattern. PR 1 wires the three that exist today; new admin mutations must add a log call
(and the source-pin test in `tests/lib/audit/admin-actions.test.ts` should grow with them).
