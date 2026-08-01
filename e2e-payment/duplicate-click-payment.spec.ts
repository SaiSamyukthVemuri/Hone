import { test, expect, type Request } from "@playwright/test";
import { loginAsOwner } from "../e2e/helpers/flows";
import {
  seedEligiblePaymentWithLogin,
  getSessionPaymentAttemptRows,
  readClinicalIntegritySnapshot,
  idempotencySelectorForAttempt,
  cleanupPaymentScenario,
  adminQuery,
  closePool,
  type PaymentSeed,
  type ClinicalIntegritySnapshot,
} from "./helpers/payment-fixture";
import {
  resetFakeStripeLedger,
  clearFakeStripeOutcome,
  configureFakeStripeOutcome,
  countInvocationsForAccount,
  countEffectsForAccount,
  callsForAccount,
  cleanupFakeStripeLedger,
} from "./helpers/fake-stripe-ledger-e2e";
import { openCheckout, prepareInModal, closeModal, armReady } from "./helpers/checkout-flow";

// ===========================================================================
// Duplicate-click browser case (PR #419).
// ===========================================================================
//
// A genuine rapid double-click on the final charge control must move money at
// most ONCE. The financial guarantee (exactly one processor EFFECT, one succeeded
// attempt) is enforced server-side by the claim RPC + the deterministic
// idempotency key + the active-attempt unique constraint — never by the fake.
//
// INVOCATION vs EFFECT: the fake records every adapter call, so a duplicate
// app-level request cannot hide behind one synthetic result. We assert the
// financial invariants HARD and REPORT the exact invocation count.

let seed: PaymentSeed;
let clinicalBefore: ClinicalIntegritySnapshot;
const stripeNetworkRequests: string[] = [];

test.beforeAll(async () => {
  resetFakeStripeLedger();
  clearFakeStripeOutcome();
  // F-PAY-001: this is a SUCCESSFUL payment journey, so it must start from
  // resolvable authoritative pricing. It previously had no booked service at
  // all and leaned on sessions.price_paid_cents to populate an editable amount
  // field — the historical fallback this PR retires. Without a priced service
  // the card now (correctly) renders its blocked state and withdraws the
  // prepare form, which is why this spec failed before ever reaching Prepare.
  seed = await seedEligiblePaymentWithLogin({
    label: "dupclick",
    bookedService: { name: "Duplicate Click Service", priceCents: 22500 },
  });
  // Pre-browser guard: a future fixture change cannot silently return this
  // success journey to the blocked-pricing path.
  {
    const svcRow = await adminQuery(
      `select s.price_cents from public.appointments a
         join public.services s on s.id = a.service_id
        where a.id = $1`,
      [seed.appointmentId],
    );
    expect(Number(svcRow.rows[0]?.price_cents)).toBe(22500);
  }
});

test.afterAll(async () => {
  try {
    await cleanupPaymentScenario(seed.studioId);
  } finally {
    cleanupFakeStripeLedger();
    await closePool();
  }
});

test("rapid duplicate-click charges exactly once (one attempt, one effect)", async ({
  page,
}, testInfo) => {
  page.on("request", (req: Request) => {
    if (/api\.stripe\.com/.test(req.url())) stripeNetworkRequests.push(req.url());
  });

  clinicalBefore = await readClinicalIntegritySnapshot(seed.sessionId);
  expect(clinicalBefore.started).toBe(true);

  await loginAsOwner(page, seed);
  await page.goto("/dashboard");

  // Prepare through the real action → exactly one 'ready' attempt.
  const modal = await openCheckout(page);
  await prepareInModal(modal);
  const prepared = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(prepared).toHaveLength(1);
  expect(prepared[0].status).toBe("ready");
  const selector = idempotencySelectorForAttempt(prepared[0].id);
  configureFakeStripeOutcome(selector, "success");
  await closeModal(page);

  // Reopen to the Ready panel and arm the explicit confirmation.
  const { modal: armed, confirm } = await armReady(page);

  // DUPLICATE INTERACTION — a genuine rapid double-click on the final charge
  // control (Playwright locator.dblclick(): two real click events in quick
  // succession on the rendered "Confirm: run charge" button). No server action is
  // called directly; no React handler is invoked directly.
  await confirm.dblclick();

  // The control must resolve (not remain indefinitely stuck): terminal Paid.
  const paidLine = armed.getByTestId("payment-summary-paid");
  await expect(paidLine).toBeVisible({ timeout: 30_000 });
  await expect(paidLine).toContainText(/Paid · \$225\.00/);

  // Persisted invariants: exactly one attempt, succeeded, no 2nd ready/pending.
  const rows = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("succeeded");
  expect(
    rows.filter((r) => r.status === "ready" || r.status === "pending_stripe"),
  ).toHaveLength(0);

  // Measurement (scoped to THIS scenario's connected account).
  const invocations = countInvocationsForAccount(seed.connectedAccountId);
  const effects = countEffectsForAccount(seed.connectedAccountId);
  testInfo.annotations.push({
    type: "duplicate-click",
    description: `invocations=${invocations} effects=${effects}`,
  });
  console.log(`[duplicate-click] invocations=${invocations} effects=${effects}`);
  // FINANCIAL GUARANTEE: exactly one processor effect (one real charge).
  expect(effects).toBe(1);
  // The fake never hides a duplicate app call. A rapid double-click yields 1 (the
  // UI pending-disable caught the 2nd) or 2 (the 2nd raced through and collapsed
  // to one effect via the idempotency key) — both financially safe. Exact count
  // is reported above.
  expect(invocations).toBeGreaterThanOrEqual(1);
  expect(invocations).toBeLessThanOrEqual(2);
  // No refund path, no real Stripe network.
  expect(
    callsForAccount(seed.connectedAccountId).filter((c) => c.method === "refund_create"),
  ).toHaveLength(0);
  expect(stripeNetworkRequests).toEqual([]);

  // Reload persists Paid; no second charge is offered.
  await page.goto("/dashboard");
  await expect(page.getByTestId("appointment-payment-paid")).toBeVisible();
  await expect(page.getByTestId("checkout-button")).toHaveCount(0);

  // Clinical record unchanged; payment never finalized charting.
  const after = await readClinicalIntegritySnapshot(seed.sessionId);
  expect(after).toEqual(clinicalBefore);
  const fin = (
    await adminQuery(`select finalized_at from public.sessions where id = $1`, [
      seed.sessionId,
    ])
  ).rows[0] as { finalized_at: string | null };
  expect(fin.finalized_at).toBeNull();

  // Counts stable after reload.
  expect(countEffectsForAccount(seed.connectedAccountId)).toBe(1);
});
