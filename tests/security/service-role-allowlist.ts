// PR #313: Service-role (createAdminClient) inventory + allowlist.
//
// createAdminClient() BYPASSES RLS. Every runtime call site under app/ and lib/
// MUST appear here with a purpose, an RLS-bypass justification, and a scopeGuard
// symbol/string that actually appears in the file. The companion test
// (service-role-allowlist.test.ts) enforces: the live call-site set == the paths
// below, every entry has purpose/why/scopeGuard, and each scopeGuard is present in
// its file. Adding/removing a usage requires editing this list.
//
// This is an INVENTORY + DRIFT gate — it proves each site HAS a guard symbol, not
// that every query is perfectly scoped. High-risk areas still need deeper audits.

export type ServiceRoleAllowlistEntry = {
  path: string;
  purpose: string;
  why: string;
  scopeGuard: string;
  justificationOnly?: true;
};

export const SERVICE_ROLE_ALLOWLIST: ServiceRoleAllowlistEntry[] = [
  {
    path: "app/(app)/calendar/[id]/manual-fee-actions.ts",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "app/(app)/calendar/actions.ts",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "app/api/google-calendar/oauth/callback/route.ts",
    purpose: "Google Calendar Phase A OAuth callback (authenticated, browser-called with the session).",
    why: "After auth.getUser() + single-use state consumption, the practitioner is re-checked and the connection persisted scoped to the state-bound studio/practitioner/user; every admin query filters those ids.",
    scopeGuard: '.eq("studio_id", consumed.studioId)',
  },
  {
    path: "lib/google-calendar/connection.ts",
    purpose: "Google Calendar Phase A connection metadata + service-role writes (ciphertext table is browser-inaccessible).",
    why: "Callers pass the authenticated studio_id + practitioner_id (resolved via getCurrentPractitionerWithStudio in the actions/callback); every read/write is scoped to both ids so a row can never cross studios.",
    scopeGuard: '.eq("studio_id", studioId)',
  },
  {
    path: "lib/google-calendar/state.ts",
    purpose: "Google Calendar Phase A OAuth state/PKCE store (default-deny table, service-role only).",
    why: "State is looked up by the SHA-256 state hash and consumed single-use only after the nonce + calling user match the stored binding (user_mismatch reject); no browser role can read the table.",
    scopeGuard: "user_mismatch",
  },
  {
    path: "lib/google-calendar/sync/connection-store.ts",
    purpose: "Google Calendar Phase B2.1 worker ConnectionStore — service-role reads/writes of the connection + ciphertext for the background sync worker (dormant; not activated).",
    why: "Every read/write is re-derived by (connectionId, studioId) — the worker never trusts a job payload's ids alone — so a connection/secret can never cross studios; the ciphertext table stays browser-inaccessible.",
    scopeGuard: '.eq("studio_id", studioId)',
  },
  {
    path: "lib/google-calendar/sync/link-transition-store.ts",
    purpose: "Google Calendar Phase B2.3-c1 worker link store — service-role reads of calendar_event_links/appointments + the transactional calendar_event_link_transition RPC (dormant; not activated, no route).",
    why: "Link/appointment reads are studio-scoped and the transition RPC itself re-validates studio/connection/entity binding + the claim token in one transaction; it never transitions the outbox (record_calendar_sync_result stays the sole outbox authority).",
    scopeGuard: '.eq("studio_id", studioId)',
  },
  {
    path: "app/(app)/calendar/postcare-auto-send.ts",
    purpose: "Fail-soft postcare auto-send helper (migration 0110), called from the completion actions after the caller's studio is already resolved.",
    why: "Service-role read/claim/record for the postcare send-state columns; the studioId is passed in by the authenticated completion action and EVERY query is scoped to it.",
    scopeGuard: '.eq("studio_id", studioId)',
  },
  {
    path: "app/(app)/clients/[id]/images/actions.ts",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "app/(app)/clients/[id]/images/page.tsx",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "app/(app)/clients/[id]/intake/actions.ts",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "app/(app)/clients/[id]/portal-messages-actions.ts",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "app/(app)/clients/[id]/sessions/new/actions.ts",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "app/(app)/settings/availability/actions.ts",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "app/(app)/settings/consent/actions.ts",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "app/(app)/settings/payments/actions.ts",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "app/(app)/settings/payments/return/page.tsx",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "app/(auth)/login/actions.ts",
    purpose: "Pre-auth practitioner magic-link request.",
    why: "No studio context exists yet. The service-role read is a constant-response practitioner-existence check that prevents account enumeration; it writes nothing and sends the link via signInWithOtp.",
    scopeGuard: "signInWithOtp",
  },
  {
    path: "app/admin/actions.ts",
    purpose: "Operator-only admin console surface.",
    why: "No practitioner session; gated by the ADMIN_EMAILS/isAdmin operator check. Cross-studio access is intentional for support/ops, so service-role is required.",
    scopeGuard: "isAdmin",
  },
  {
    path: "lib/audit/admin-actions.ts",
    purpose: "Admin action audit log — sole writer + reader of admin_action_events (migration 0113).",
    why: "admin_action_events is RLS-locked to service-role (a cross-studio, append-only OPERATOR audit log — no tenant scope by design; there is no is_admin() SQL function). Called only from isAdmin-gated /admin server code; it records/reads audit rows and stores no secrets/PII (metadata is allowlisted + redacted before insert).",
    scopeGuard: "admin_action_events",
  },
  {
    path: "app/admin/ops-alerts/actions.ts",
    purpose: "Operator-only admin console surface.",
    why: "No practitioner session; gated by the ADMIN_EMAILS/isAdmin operator check. Cross-studio access is intentional for support/ops, so service-role is required.",
    scopeGuard: "isAdmin",
  },
  {
    path: "app/admin/ops-alerts/page.tsx",
    purpose: "Operator-only admin console surface.",
    why: "No practitioner session; gated by the ADMIN_EMAILS/isAdmin operator check. Cross-studio access is intentional for support/ops, so service-role is required.",
    scopeGuard: "isAdmin",
  },
  {
    path: "app/admin/page.tsx",
    purpose: "Operator-only admin console surface.",
    why: "No practitioner session; gated by the ADMIN_EMAILS/isAdmin operator check. Cross-studio access is intentional for support/ops, so service-role is required.",
    scopeGuard: "isAdmin",
  },
  {
    path: "app/admin/payments/manual-review/page.tsx",
    purpose: "Operator-only admin console surface.",
    why: "No practitioner session; gated by the ADMIN_EMAILS/isAdmin operator check. Cross-studio access is intentional for support/ops, so service-role is required.",
    scopeGuard: "isAdmin",
  },
  {
    path: "app/admin/studios/[id]/page.tsx",
    purpose: "Operator-only admin console surface.",
    why: "No practitioner session; gated by the ADMIN_EMAILS/isAdmin operator check. Cross-studio access is intentional for support/ops, so service-role is required.",
    scopeGuard: "isAdmin",
  },
  {
    path: "app/admin/studios/new/actions.ts",
    purpose: "Operator-only admin console surface.",
    why: "No practitioner session; gated by the ADMIN_EMAILS/isAdmin operator check. Cross-studio access is intentional for support/ops, so service-role is required.",
    scopeGuard: "isAdmin",
  },
  {
    path: "app/admin/studios/new/page.tsx",
    purpose: "Operator-only admin console surface.",
    why: "No practitioner session; gated by the ADMIN_EMAILS/isAdmin operator check. Cross-studio access is intentional for support/ops, so service-role is required.",
    scopeGuard: "isAdmin",
  },
  {
    path: "app/api/cron/appointment-reminders/route.ts",
    purpose: "Scheduled, session-less cron / heartbeat.",
    why: "Runs with no user session; authorized by the CRON_SECRET bearer. Service-role is required; each row is studio-scoped in-query.",
    scopeGuard: "isAuthorizedCronRequest",
  },
  {
    path: "app/api/cron/materialize-recurring-breaks/route.ts",
    purpose: "Scheduled, session-less cron / heartbeat.",
    why: "Runs with no user session; authorized by the CRON_SECRET bearer. Service-role is required; each row is studio-scoped in-query.",
    scopeGuard: "isAuthorizedCronRequest",
  },
  {
    path: "app/api/cron/calendar-reconcile/route.ts",
    purpose: "Google Calendar Phase B2.3-b reconciliation sweep (session-less; dormant — no cron registration).",
    why: "Runs with no user session; authorized by the CRON_SECRET bearer (isAuthorizedCronRequest). Never trusts a browser-supplied id — the eligible studio set is derived server-side and every reconcile read/actuation is studio-scoped; it only orchestrates the existing repair RPCs + prunes PHI-free telemetry, never enabling the worker or any flag.",
    scopeGuard: "isAuthorizedCronRequest",
  },
  {
    path: "app/api/stripe/webhook/route.ts",
    purpose: "Stripe webhook handler.",
    why: "No user session; authenticated by Stripe signature verification (constructEvent). Rows are resolved by the verified event's ids.",
    scopeGuard: "constructEvent",
  },
  {
    path: "app/api/twilio/inbound-sms/route.ts",
    purpose: "Twilio inbound-SMS webhook.",
    why: "No user session; authenticated by the Twilio signature (x-twilio-signature). The client is resolved by the sending phone number.",
    scopeGuard: "x-twilio-signature",
  },
  {
    path: "app/book/[slug]/actions.ts",
    purpose: "Public, unauthenticated token-scoped route/query.",
    why: "No session; the bearer signed/hashed token is verified (verifyCancellationToken) and resolves the exact appointment/intake/portal row. Scope comes from the verified token, so service-role is required.",
    scopeGuard: "verifyCancellationToken",
  },
  {
    path: "app/book/[slug]/page.tsx",
    purpose: "Public booking / portal / token-scoped read.",
    why: "Session-less or portal-session path that cannot satisfy member RLS; the query is explicitly studio/client scoped (see scopeGuard). Service-role reads the tenant-scoped rows.",
    scopeGuard: '.eq("studio_id"',
  },
  {
    path: "app/calendar-feed/[token]/route.ts",
    purpose: "Public, unauthenticated token-scoped route/query.",
    why: "No session; the bearer signed/hashed token is verified (token_hash) and resolves the exact appointment/intake/portal row. Scope comes from the verified token, so service-role is required.",
    scopeGuard: "token_hash",
  },
  {
    path: "app/cancel/[token]/actions.ts",
    purpose: "Public, unauthenticated token-scoped route/query.",
    why: "No session; the bearer signed/hashed token is verified (verifyCancellationToken) and resolves the exact appointment/intake/portal row. Scope comes from the verified token, so service-role is required.",
    scopeGuard: "verifyCancellationToken",
  },
  {
    path: "app/intake/[token]/actions.ts",
    purpose: "Public, unauthenticated token-scoped route/query.",
    why: "No session; the bearer signed/hashed token is verified (verifyIntakeToken) and resolves the exact appointment/intake/portal row. Scope comes from the verified token, so service-role is required.",
    scopeGuard: "verifyIntakeToken",
  },
  {
    path: "app/intake/[token]/page.tsx",
    purpose: "Public, unauthenticated token-scoped route/query.",
    why: "No session; the bearer signed/hashed token is verified (verifyIntakeToken) and resolves the exact appointment/intake/portal row. Scope comes from the verified token, so service-role is required.",
    scopeGuard: "verifyIntakeToken",
  },
  {
    path: "app/manage/[token]/actions.ts",
    purpose: "Public, unauthenticated token-scoped route/query.",
    why: "No session; the bearer signed/hashed token is verified (verifyCancellationToken) and resolves the exact appointment/intake/portal row. Scope comes from the verified token, so service-role is required.",
    scopeGuard: "verifyCancellationToken",
  },
  {
    path: "app/portal/consent-actions.ts",
    purpose: "Payment / consent ledger helper.",
    why: "Invoked by authenticated actions and the signature-verified webhook; uses service-role for the payment_charge_attempts / consent RPCs and write-throughs. Scoped by the caller-supplied studio_id/client_id/appointment_id.",
    scopeGuard: '.eq("studio_id"',
  },
  {
    path: "app/portal/login/actions.ts",
    purpose: "Public, unauthenticated token-scoped route/query.",
    why: "No session; the bearer signed/hashed token is verified (hashToken) and resolves the exact appointment/intake/portal row. Scope comes from the verified token, so service-role is required.",
    scopeGuard: "hashToken",
  },
  {
    path: "app/portal/payment-method-actions.ts",
    purpose: "Payment / consent ledger helper.",
    why: "Invoked by authenticated actions and the signature-verified webhook; uses service-role for the payment_charge_attempts / consent RPCs and write-throughs. Scoped by the caller-supplied studio_id/client_id/appointment_id.",
    scopeGuard: '.eq("studio_id"',
  },
  {
    path: "app/portal/portal-message-actions.ts",
    purpose: "Public booking / portal / token-scoped read.",
    why: "Session-less or portal-session path that cannot satisfy member RLS; the query is explicitly studio/client scoped (see scopeGuard). Service-role reads the tenant-scoped rows.",
    scopeGuard: '.eq("studio_id"',
  },
  {
    path: "app/portal/verify/[token]/actions.ts",
    purpose: "Public, unauthenticated token-scoped route/query.",
    why: "No session; the bearer signed/hashed token is verified (hashToken) and resolves the exact appointment/intake/portal row. Scope comes from the verified token, so service-role is required.",
    scopeGuard: "hashToken",
  },
  {
    path: "app/portal/verify/[token]/page.tsx",
    purpose: "Public, unauthenticated token-scoped route/query.",
    why: "No session; the bearer signed/hashed token is verified (hashToken) and resolves the exact appointment/intake/portal row. Scope comes from the verified token, so service-role is required.",
    scopeGuard: "hashToken",
  },
  {
    path: "app/reschedule/[token]/actions.ts",
    purpose: "Public, unauthenticated token-scoped route/query.",
    why: "No session; the bearer signed/hashed token is verified (verifyCancellationToken) and resolves the exact appointment/intake/portal row. Scope comes from the verified token, so service-role is required.",
    scopeGuard: "verifyCancellationToken",
  },
  {
    path: "lib/billing/manual-fee-eligibility.ts",
    purpose: "Payment / consent ledger helper.",
    why: "Invoked by authenticated actions and the signature-verified webhook; uses service-role for the payment_charge_attempts / consent RPCs and write-throughs. Scoped by the caller-supplied studio_id/client_id/appointment_id.",
    scopeGuard: '.eq("studio_id"',
  },
  {
    path: "lib/billing/payment-receipt.ts",
    purpose: "Payment / consent ledger helper.",
    why: "Invoked by authenticated actions and the signature-verified webhook; uses service-role for the payment_charge_attempts / consent RPCs and write-throughs. Scoped by the caller-supplied studio_id/client_id/appointment_id.",
    scopeGuard: '.eq("studio_id"',
  },
  {
    path: "lib/billing/payment-refund.ts",
    purpose: "Payment / consent ledger helper.",
    why: "Invoked by authenticated actions and the signature-verified webhook; uses service-role for the payment_charge_attempts / consent RPCs and write-throughs. Scoped by the caller-supplied studio_id/client_id/appointment_id.",
    scopeGuard: '.eq("studio_id"',
  },
  {
    path: "lib/billing/payment-webhook-reconciliation.ts",
    purpose: "Payment / consent ledger helper.",
    why: "Invoked by authenticated actions and the signature-verified webhook; uses service-role for the payment_charge_attempts / consent RPCs and write-throughs. Scoped by the caller-supplied studio_id/client_id/appointment_id.",
    scopeGuard: '.eq("id",',
  },
  {
    path: "lib/billing/session-payment-charge.ts",
    purpose: "Payment / consent ledger helper.",
    why: "Invoked by authenticated actions and the signature-verified webhook; uses service-role for the payment_charge_attempts / consent RPCs and write-throughs. Scoped by the caller-supplied studio_id/client_id/appointment_id.",
    scopeGuard: '.eq("studio_id"',
  },
  {
    path: "lib/billing/session-payment-eligibility.ts",
    purpose: "Payment / consent ledger helper.",
    why: "Invoked by authenticated actions and the signature-verified webhook; uses service-role for the payment_charge_attempts / consent RPCs and write-throughs. Scoped by the caller-supplied studio_id/client_id/appointment_id.",
    scopeGuard: '.eq("studio_id"',
  },
  {
    path: "lib/booking/queries.ts",
    purpose: "Public booking / portal / token-scoped read.",
    why: "Session-less or portal-session path that cannot satisfy member RLS; the query is explicitly studio/client scoped (see scopeGuard). Service-role reads the tenant-scoped rows.",
    scopeGuard: '.eq("studio_id"',
  },
  {
    path: "lib/consent/current-card-authorization.ts",
    purpose: "Payment / consent ledger helper.",
    why: "Invoked by authenticated actions and the signature-verified webhook; uses service-role for the payment_charge_attempts / consent RPCs and write-throughs. Scoped by the caller-supplied studio_id/client_id/appointment_id.",
    scopeGuard: '.eq("studio_id"',
  },
  {
    path: "lib/consent/queries.ts",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "lib/cron/reminder-heartbeat.ts",
    purpose: "Scheduled, session-less cron / heartbeat.",
    why: "Runs with no user session; authorized by the CRON_SECRET bearer. Service-role is required; each row is studio-scoped in-query.",
    scopeGuard: "CRON_SECRET",
  },
  {
    path: "lib/google-calendar/sync/reconcile-heartbeat.ts",
    purpose: "Google Calendar Phase B2.3-b reconcile-sweep heartbeat health alert (session-less; NOT wired to a cron in this phase).",
    why: "Reads ONLY the non-tenant ops_alerts table filtered by event for dedupe (no studio/client data) and records a PHI-free stale/missing alert via recordOpsAlert; fail-open, write-mostly, no cross-studio read.",
    scopeGuard: '.is("resolved_at", null)',
  },
  {
    path: "lib/intake/queries.ts",
    purpose: "Public booking / portal / token-scoped read.",
    why: "Session-less or portal-session path that cannot satisfy member RLS; the query is explicitly studio/client scoped (see scopeGuard). Service-role reads the tenant-scoped rows.",
    scopeGuard: '.eq("studio_id"',
  },
  {
    path: "lib/notifications/practitioner-notifications.ts",
    purpose: "Operational practitioner-notification writer.",
    why: "Called from anonymous / token-bearing flows that cannot satisfy the is_studio_member RLS predicate; writes a notification stamped with the caller-supplied studio_id (no cross-studio read).",
    scopeGuard: "studio_id: input.studioId",
  },
  {
    path: "lib/ops/alerts.ts",
    purpose: "Append-only operator ops-alert log.",
    why: "Written from any surface (including session-less paths); details are redacted (redactSafeDetails) to keep PII/secrets out. Write-only, no cross-studio read.",
    scopeGuard: "redactSafeDetails",
  },
  {
    path: "lib/payment-methods/queries.ts",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "lib/payment-methods/refresh-card-authorization-pointer.ts",
    purpose: "Payment / consent ledger helper.",
    why: "Invoked by authenticated actions and the signature-verified webhook; uses service-role for the payment_charge_attempts / consent RPCs and write-throughs. Scoped by the caller-supplied studio_id/client_id/appointment_id.",
    scopeGuard: '.eq("studio_id"',
  },
  {
    path: "lib/portal-messages/queries.ts",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "lib/portal-messages/replies-queries.ts",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "lib/portal/queries.ts",
    purpose: "Public booking / portal / token-scoped read.",
    why: "Session-less or portal-session path that cannot satisfy member RLS; the query is explicitly studio/client scoped (see scopeGuard). Service-role reads the tenant-scoped rows.",
    scopeGuard: '.eq("studio_id"',
  },
  {
    path: "app/(app)/clients/[id]/portal-link-actions.ts",
    purpose: "Practitioner 'Send portal link' — issue a portal magic link for a known client.",
    why: "Authenticated practitioner action (studio resolved via getCurrentPractitionerWithStudio); the client lookup + magic-link insert are explicitly scoped to that studio.id — a client in another studio is not found.",
    scopeGuard: '.eq("studio_id", studio.id)',
  },
  {
    path: "lib/portal/session.ts",
    purpose: "Public, unauthenticated token-scoped route/query.",
    why: "No session; the bearer signed/hashed token is verified (hashToken) and resolves the exact appointment/intake/portal row. Scope comes from the verified token, so service-role is required.",
    scopeGuard: "hashToken",
  },
  {
    path: "lib/stripe/account.ts",
    purpose: "Authenticated practitioner server action/query.",
    why: "Service-role write/read-through after the caller's studio is resolved via getCurrentPractitionerWithStudio(); every query is scoped to that studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "lib/treatment-time/queries.ts",
    purpose: "Public booking / portal / token-scoped read.",
    why: "Session-less or portal-session path that cannot satisfy member RLS; the query is explicitly studio/client scoped (see scopeGuard). Service-role reads the tenant-scoped rows.",
    scopeGuard: '.eq("studio_id"',
  },
  {
    path: "lib/conversion/dispatch.ts",
    purpose: "Fire-and-forget booking-conversion dispatch from the public (session-less) booking action.",
    why: "Reads the studio's enabled tracking providers + writes delivery status, all explicitly scoped to the booking's studio_id. Sends nothing unless consent + an enabled provider config + a decryptable token all hold; never throws.",
    scopeGuard: '.eq("studio_id"',
  },
  {
    path: "app/(app)/settings/tracking/actions.ts",
    purpose: "Authenticated OWNER settings action.",
    why: "Owner-gated via getCurrentPractitionerWithStudio() (role === 'owner'); every write is scoped to that studio.id. Encrypts the provider token before storing; never persists a raw token.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
  {
    path: "app/(app)/settings/tracking/page.tsx",
    purpose: "Authenticated OWNER settings page (redacted status read).",
    why: "Owner-gated via getCurrentPractitionerWithStudio(); reads only redacted provider status (never encrypted_server_token) scoped to studio.id.",
    scopeGuard: "getCurrentPractitionerWithStudio",
  },
];
