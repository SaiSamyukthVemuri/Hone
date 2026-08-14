import { test, expect, type Request, type Route } from "@playwright/test";
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
// Two-context concurrent-charge browser case (PR #419).
// ===========================================================================
//
// The SAME authorized practitioner, in two independent browser contexts (Context
// A = dashboard checkout, Context B = calendar checkout), charges the SAME
// prepared attempt with both final requests released simultaneously by a request
// barrier. The financial invariant, exactly ONE processor EFFECT / one succeeded
// attempt / no duplicate persisted charge, is enforced server-side (claim RPC +
// deterministic idempotency key + active-attempt unique constraint) and asserted
// HARD. The exact adapter INVOCATION count is measured and reported: the fake can
// never hide a duplicate application-level request behind one synthetic result.

let seed: PaymentSeed;
let clinicalBefore: ClinicalIntegritySnapshot;
const stripeNetworkRequests: string[] = [];

test.beforeAll(async () => {
  resetFakeStripeLedger();
  clearFakeStripeOutcome();
  // F-PAY-001: this is a SUCCESSFUL payment journey, so it must start from
  // resolvable authoritative pricing. It previously had no booked service at
  // all and leaned on sessions.price_paid_cents to populate an editable amount
  // field, the historical fallback this PR retires. Without a priced service
  // the card now (correctly) renders its blocked state and withdraws the
  // prepare form, which is why this spec failed before ever reaching Prepare.
  seed = await seedEligiblePaymentWithLogin({
    label: "twoctx",
    bookedService: { name: "Two Context Service", priceCents: 22500 },
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

test("two contexts charge the same attempt concurrently: one effect, one succeeded", async ({
  browser,
}, testInfo) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const monitor = (req: Request) => {
    if (/api\.stripe\.com/.test(req.url())) stripeNetworkRequests.push(req.url());
  };
  pageA.on("request", monitor);
  pageB.on("request", monitor);

  clinicalBefore = await readClinicalIntegritySnapshot(seed.sessionId);
  expect(clinicalBefore.started).toBe(true);

  // Log in the SAME owner in both contexts (sequential so the single-use magic
  // links don't race).
  await loginAsOwner(pageA, seed);
  await loginAsOwner(pageB, seed);

  // Context A (dashboard): prepare the single attempt, configure fake success,
  // reopen to Ready, arm the confirm.
  await pageA.goto("/dashboard");
  const modalA = await openCheckout(pageA);
  await prepareInModal(modalA);
  const prepared = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(prepared).toHaveLength(1);
  expect(prepared[0].status).toBe("ready");
  const selector = idempotencySelectorForAttempt(prepared[0].id);
  configureFakeStripeOutcome(selector, "success");
  await closeModal(pageA);
  const { confirm: confirmA } = await armReady(pageA);

  // Context B (calendar): the SAME appointment/session/attempt; confirm B displays
  // the same Ready state (the prepared attempt), then arm.
  await pageB.goto(`/calendar/${seed.appointmentId}`);
  const { confirm: confirmB } = await armReady(pageB);

  // --- Request barrier on the execute-charge POST in BOTH contexts. Hold the
  //     first matching request until the second is observed, then release both,
  //     so both server actions run as concurrently as possible. Matches on stable
  //     metadata only (POST + the Next server-action header); never inspects or
  //     logs the request body.
  let requestsSeen = 0;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  // Fallback: if only ONE execute request arrives (the other UI disabled/refreshed
  // before submit), release the single request so it still completes.
  const fallback = setTimeout(() => releaseGate(), 6000);
  const barrier = async (route: Route) => {
    const req = route.request();
    if (req.method() === "POST" && req.headers()["next-action"]) {
      requestsSeen += 1;
      if (requestsSeen >= 2) {
        clearTimeout(fallback);
        releaseGate();
      }
      await gate;
    }
    await route.continue();
  };
  await pageA.route("**/dashboard**", barrier);
  await pageB.route("**/calendar/**", barrier);

  // Trigger both final charges as concurrently as Playwright permits.
  await Promise.all([confirmA.click(), confirmB.click()]);

  // Wait for the race to settle: the single attempt reaches succeeded.
  await expect
    .poll(
      async () => (await getSessionPaymentAttemptRows(seed.sessionId))[0]?.status,
      { timeout: 30_000 },
    )
    .toBe("succeeded");
  clearTimeout(fallback);

  // Immediate per-context response (informational): one context may receive a
  // safe stale/already-completed message during the race.
  const immediate = async (page: typeof pageA) =>
    (await page.getByTestId("payment-summary-paid").count()) > 0
      ? "paid"
      : (await page.getByRole("alert").count()) > 0
        ? "safe-message"
        : "other";
  const immediateA = await immediate(pageA);
  const immediateB = await immediate(pageB);

  // --- Persisted invariants (HARD): one attempt, succeeded, no duplicate.
  const rows = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("succeeded");
  expect(
    rows.filter((r) => r.status === "ready" || r.status === "pending_stripe"),
  ).toHaveLength(0);

  // --- Measurement: exactly one processor EFFECT (financial guarantee); the exact
  //     INVOCATION count is reported (1 or 2, both financially safe; the fake
  //     never hides a duplicate app request).
  const invocations = countInvocationsForAccount(seed.connectedAccountId);
  const effects = countEffectsForAccount(seed.connectedAccountId);
  testInfo.annotations.push({
    type: "two-context-concurrency",
    description: `executeRequestsObserved=${requestsSeen} invocations=${invocations} effects=${effects} immediateA=${immediateA} immediateB=${immediateB}`,
  });
  console.log(
    `[two-context] executeRequestsObserved=${requestsSeen} invocations=${invocations} effects=${effects} immediateA=${immediateA} immediateB=${immediateB}`,
  );
  expect(effects).toBe(1);
  expect(invocations).toBeGreaterThanOrEqual(1);
  expect(invocations).toBeLessThanOrEqual(2);
  expect(
    callsForAccount(seed.connectedAccountId).filter((c) => c.method === "refund_create"),
  ).toHaveLength(0);
  expect(stripeNetworkRequests).toEqual([]);

  await pageA.unroute("**/dashboard**", barrier).catch(() => {});
  await pageB.unroute("**/calendar/**", barrier).catch(() => {});

  // --- Browser convergence: reload BOTH contexts → both show persisted Paid, no
  //     Prepare/Charge affordance, and no raw processor error.
  await pageA.goto("/dashboard");
  await expect(pageA.getByTestId("appointment-payment-paid")).toBeVisible();
  await expect(pageA.getByTestId("checkout-button")).toHaveCount(0);

  await pageB.goto(`/calendar/${seed.appointmentId}`);
  await expect(pageB.getByTestId("appointment-payment-paid")).toBeVisible();
  await expect(pageB.getByTestId("checkout-button")).toHaveCount(0);
  await expect(pageB.getByRole("button", { name: /prepare session payment/i })).toHaveCount(0);
  await expect(pageB.getByRole("button", { name: /run charge/i })).toHaveCount(0);

  // Counts unchanged after convergence.
  expect(countEffectsForAccount(seed.connectedAccountId)).toBe(1);
  expect(countInvocationsForAccount(seed.connectedAccountId)).toBe(invocations);

  // --- Clinical record unchanged; payment never finalized charting.
  const after = await readClinicalIntegritySnapshot(seed.sessionId);
  expect(after).toEqual(clinicalBefore);
  const fin = (
    await adminQuery(`select finalized_at from public.sessions where id = $1`, [
      seed.sessionId,
    ])
  ).rows[0] as { finalized_at: string | null };
  expect(fin.finalized_at).toBeNull();

  await ctxA.close();
  await ctxB.close();
});
