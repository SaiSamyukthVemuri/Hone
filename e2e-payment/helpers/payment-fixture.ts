import type { E2eSeed } from "../../e2e/helpers/seed";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "../../e2e/helpers/local-env";
import { timezoneWithLocalMorning } from "../../e2e/helpers/timezone";
import { adminQuery, closePool } from "../../tests/db/helpers/harness";
export { adminQuery } from "../../tests/db/helpers/harness";
import {
  seedEligibleQuickCheckoutScenario,
  readClinicalIntegritySnapshot,
  getSessionPaymentAttempts,
  cleanupPaymentScenario,
  type PaymentScenario,
  type SeedOptions,
  type ClinicalIntegritySnapshot,
} from "../../tests/db/helpers/payment-seed";

// ===========================================================================
// Playwright bridge for the quick-checkout payment browser E2E.
// ===========================================================================
//
// The browser spec needs TWO things the DB-integration lane did not:
//   1. A login-capable owner. seedStudio (tests/db/helpers/harness.ts) inserts a
//      BARE auth.users row directly — perfect for the node-pg `asUser` JWT
//      simulation, but NOT a GoTrue user that can complete a real magic-link
//      login. So after seeding the proven eligible scenario we create a real
//      GoTrue user (invite-only handle_new_user creates NOTHING for it) and
//      RE-POINT the already-seeded owner practitioner at it. No new studio, no
//      duplicated payment inserts — the eligibility chain is 100% the proven
//      fixture (seedEligibleQuickCheckoutScenario).
//   2. A deterministic "today" so the completed appointment (starts 90 min ago)
//      lands on the Dashboard roster regardless of the CI clock — we set the
//      studio timezone to a fixed-offset zone whose local time reads ~09:00.
//
// Everything else (studio_payment_settings / card / customer / consent / session /
// appointment) is the untouched fixture, so the REAL getSessionPaymentEligibility
// resolver still governs eligibility.

export { readClinicalIntegritySnapshot, getSessionPaymentAttempts, cleanupPaymentScenario, closePool };
export type { PaymentScenario, ClinicalIntegritySnapshot };

export type PaymentSeed = E2eSeed & {
  scenario: PaymentScenario;
  studioId: string;
  clientId: string;
  appointmentId: string;
  sessionId: string;
  expectedAmountMinor: number;
};

async function createLoginUser(email: string): Promise<string> {
  const res = await fetch(`${E2E_SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: E2E_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, email_confirm: true }),
  });
  if (!res.ok) {
    throw new Error(
      `local GoTrue admin createUser failed: ${res.status} ${await res.text()}`,
    );
  }
  const created = (await res.json()) as { id?: string };
  if (!created.id) throw new Error("local GoTrue admin createUser returned no id");
  return created.id;
}

// Seed the proven eligible scenario, then make its owner login-capable. Returns a
// full E2eSeed (so loginAsOwner works unchanged) plus the payment ids.
export async function seedEligiblePaymentWithLogin(
  opts: SeedOptions = {},
): Promise<PaymentSeed> {
  const scenario = await seedEligibleQuickCheckoutScenario(opts);
  if (!scenario.sessionId) {
    throw new Error("seedEligiblePaymentWithLogin: fixture did not seed a session");
  }

  // Deterministic "today" for the Dashboard roster.
  await adminQuery(`update public.studios set timezone = $2 where id = $1`, [
    scenario.studioId,
    timezoneWithLocalMorning(),
  ]);

  // Real GoTrue user + re-point the seeded owner practitioner at it.
  const ownerEmail = `e2e-qc-owner-${scenario.runId}@harness.local`;
  const loginUserId = await createLoginUser(ownerEmail);
  await adminQuery(
    `update public.practitioners set user_id = $2, email = $3 where id = $1`,
    [scenario.practitionerId, loginUserId, ownerEmail],
  );
  await adminQuery(`update public.studios set owner_email = $2 where id = $1`, [
    scenario.studioId,
    ownerEmail,
  ]);

  // The modal renders the REAL client name from the DB (seedStudio names it
  // "Client <label>"), so read it back rather than fabricating one.
  const clientRow = (
    await adminQuery(`select name from public.clients where id = $1`, [
      scenario.clientId,
    ])
  ).rows[0] as { name: string };

  return {
    runId: scenario.runId,
    studioId: scenario.studioId,
    slug: `qc-${scenario.runId}`,
    studioName: `QC Studio ${scenario.runId}`,
    ownerEmail,
    serviceName: `QC Service ${scenario.runId}`,
    clientName: clientRow.name,
    clientEmail: `e2e-qc-client-${scenario.runId}@harness.local`,
    scenario,
    clientId: scenario.clientId,
    appointmentId: scenario.appointmentId,
    sessionId: scenario.sessionId,
    expectedAmountMinor: scenario.expectedAmountMinor,
  };
}

// The deterministic fake-outcome selector for a prepared attempt. Mirrors
// buildIdempotencyKey() in lib/billing/session-payment-charge.ts EXACTLY: the
// fake outcome is keyed by the attempt's server-generated idempotency key, never
// by any browser input.
export function idempotencySelectorForAttempt(attemptId: string): string {
  return `hone:session_payment:${attemptId}:v1`;
}

// Read the session's payment attempts WITH their ids (the DB-lane reader omits the
// id; the browser spec needs it to compute the idempotency selector + to assert an
// exact attempt count). Test-safe columns only.
export async function getSessionPaymentAttemptRows(
  sessionId: string,
): Promise<Array<{ id: string; status: string }>> {
  const r = await adminQuery(
    `select id, status from public.payment_charge_attempts
      where session_id = $1 and charge_reason = 'session_payment'
      order by created_at`,
    [sessionId],
  );
  return r.rows as Array<{ id: string; status: string }>;
}
