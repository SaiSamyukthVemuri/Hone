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
  readFakeStripeCalls,
  callsForAccount,
  countInvocationsForAccount,
  countEffectsForAccount,
  cleanupFakeStripeLedger,
} from "./helpers/fake-stripe-ledger-e2e";
import { openCheckout, prepareInModal, closeModal, armReady } from "./helpers/checkout-flow";

// ===========================================================================
// Ambiguous-response recovery browser case (PR — Issue #420).
// ===========================================================================
//
// Proves the exact "committed payment, lost response" scenario: the browser
// submits the charge, the REAL server claims the attempt + the fake succeeds +
// the success is PERSISTED, but the successful server-action response never
// reaches the browser (an ambiguous network failure). On reload the persisted
// state is Paid, with NO second attempt and NO second processor effect.
//
// Interception technique: a Playwright route handler on the execute-charge
// server-action POST calls route.fetch() so the request reaches the real Next
// server (the payment commits upstream), waits for that response, then
// route.abort()s the BROWSER-facing response. No production code simulates this;
// no fake delay/failure is added to the payment action; the request body is never
// inspected or logged.

const AMOUNT_LABEL = /Paid · \$225\.00/;

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
    label: "ambig",
    bookedService: { name: "Ambiguous Response Service", priceCents: 22500 },
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

test("committed charge with a lost response recovers to Paid on reload (no duplicate)", async ({
  page,
}, testInfo) => {
  page.on("request", (req: Request) => {
    if (/api\.stripe\.com/.test(req.url())) stripeNetworkRequests.push(req.url());
  });

  // --- Pre-browser baselines.
  clinicalBefore = await readClinicalIntegritySnapshot(seed.sessionId);
  expect(clinicalBefore.exists).toBe(true);
  expect(clinicalBefore.started).toBe(true);
  expect(await getSessionPaymentAttemptRows(seed.sessionId)).toHaveLength(0);
  expect(countInvocationsForAccount(seed.connectedAccountId)).toBe(0);
  expect(countEffectsForAccount(seed.connectedAccountId)).toBe(0);

  // --- Prepare normally through the browser.
  await loginAsOwner(page, seed);
  await page.goto("/dashboard");
  const modal = await openCheckout(page);
  await expect(modal.getByText(/ending in 4242/i)).toBeVisible(); // correct context
  await prepareInModal(modal);
  const prepared = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(prepared).toHaveLength(1);
  expect(prepared[0].status).toBe("ready");
  const selector = idempotencySelectorForAttempt(prepared[0].id);
  configureFakeStripeOutcome(selector, "success");
  expect(countInvocationsForAccount(seed.connectedAccountId)).toBe(0); // no charge yet
  await closeModal(page);

  // Reopen to Ready + arm the confirm (the context fetch completes BEFORE the
  // interception is installed, so only the execute POST is intercepted).
  const { confirm } = await armReady(page);

  // --- Interception: forward the execute request upstream, confirm the server
  //     committed, then drop the browser-facing response.
  let upstreamStatus = -1; // set to the real upstream status inside the handler
  let dbSucceededAtAbort = false;
  let invocationsAtAbort = -1;
  let effectsAtAbort = -1;
  let resolveAbort: () => void = () => {};
  const aborted = new Promise<void>((r) => {
    resolveAbort = r;
  });
  const handler = async (route: Route) => {
    const req = route.request();
    if (!(req.method() === "POST" && req.headers()["next-action"])) {
      await route.continue();
      return;
    }
    try {
      const response = await route.fetch(); // reaches the REAL server
      upstreamStatus = response.status();
      await response.body().catch(() => {}); // ensure fully received
      const rows = await getSessionPaymentAttemptRows(seed.sessionId);
      dbSucceededAtAbort = rows.length === 1 && rows[0].status === "succeeded";
      invocationsAtAbort = countInvocationsForAccount(seed.connectedAccountId);
      effectsAtAbort = countEffectsForAccount(seed.connectedAccountId);
    } finally {
      await route.abort("failed").catch(() => {}); // browser loses the response
      resolveAbort();
    }
  };
  await page.route("**/dashboard**", handler);

  await confirm.click(); // submit the charge
  await aborted; // upstream committed + browser-facing response dropped
  await page.unroute("**/dashboard**", handler);

  // --- The payment COMMITTED upstream before the browser lost the response.
  expect(upstreamStatus).toBeGreaterThanOrEqual(200); // -1 sentinel → set upstream
  expect(upstreamStatus).toBeLessThan(400);
  expect(dbSucceededAtAbort).toBe(true);
  expect(invocationsAtAbort).toBe(1);
  expect(effectsAtAbort).toBe(1);

  // --- Immediate browser behaviour (recorded; must not auto-retry or claim
  //     definite failure / show a raw stack).
  await page.waitForTimeout(500); // let React settle after the failed action
  const immediateText = (await page.evaluate(() => document.body.innerText).catch(
    () => "(page unavailable)",
  )) as string;
  const immediatePaid = await page.getByTestId("payment-summary-paid").count().catch(() => 0);
  const immediateAlert = await page.getByRole("alert").count().catch(() => 0);
  testInfo.annotations.push({
    type: "ambiguous-immediate",
    description: `upstream=${upstreamStatus} paidVisible=${immediatePaid} alertVisible=${immediateAlert} text="${immediateText.slice(0, 180).replace(/\s+/g, " ")}"`,
  });
  console.log(
    `[ambiguous] upstream=${upstreamStatus} dbSucceeded=${dbSucceededAtAbort} invAtAbort=${invocationsAtAbort} immediatePaid=${immediatePaid} immediateAlert=${immediateAlert}`,
  );
  expect(immediateText.toLowerCase()).not.toMatch(
    /declined|charge failed|payment failed|card was declined/,
  );
  expect(immediateText).not.toMatch(/TypeError|\.tsx:|\bat Object\.|webpack-internal/);
  // No automatic second charge: still exactly one attempt + one invocation.
  {
    const rows = await getSessionPaymentAttemptRows(seed.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("succeeded");
    expect(countInvocationsForAccount(seed.connectedAccountId)).toBe(1);
  }

  // --- Recovery: reload the dashboard → persisted Paid, no Checkout.
  await page.goto("/dashboard");
  await expect(page.getByTestId("appointment-payment-paid")).toBeVisible();
  await expect(page.getByTestId("checkout-button")).toHaveCount(0);

  // Full "Paid · $225.00" (trusted amount) via the session-detail surface — a
  // paid appointment shows only a "Paid" badge on the roster, so the amount is
  // re-read here from the persisted succeeded row.
  await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
  const paidLine = page.getByTestId("payment-summary-paid");
  await expect(paidLine).toBeVisible();
  await expect(paidLine).toContainText(AMOUNT_LABEL);
  await expect(page.getByRole("button", { name: /prepare session payment/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^run charge$/i })).toHaveCount(0);

  // Calendar surface → same persisted Paid; no charge affordance.
  await page.goto(`/calendar/${seed.appointmentId}`);
  await expect(page.getByTestId("appointment-payment-paid")).toBeVisible();
  await expect(page.getByTestId("checkout-button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /prepare session payment/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /run charge/i })).toHaveCount(0);

  // --- Hard persisted invariants.
  const rows = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("succeeded");
  expect(
    rows.filter((r) => r.status === "ready" || r.status === "pending_stripe"),
  ).toHaveLength(0);
  expect(countInvocationsForAccount(seed.connectedAccountId)).toBe(1);
  expect(countEffectsForAccount(seed.connectedAccountId)).toBe(1);

  const piCreates = callsForAccount(seed.connectedAccountId).filter(
    (c) => c.method === "pi_create",
  );
  expect(piCreates).toHaveLength(1);
  expect(new Set(piCreates.map((c) => c.resultId)).size).toBe(1); // one synthetic PI
  const pi = piCreates[0];
  expect(pi.idempotencyKey).toBe(selector);
  expect(pi.stripeAccount).toBe(seed.connectedAccountId);
  expect(pi.amountCents).toBe(seed.expectedAmountMinor);
  expect(pi.currency).toBe("cad");
  expect(pi.resultId).toMatch(/^pi_test_e2e_/);
  expect(pi.replay).toBe(false);
  expect(
    callsForAccount(seed.connectedAccountId).filter((c) => c.method === "refund_create"),
  ).toHaveLength(0);

  // --- No delayed retry: wait, then re-query.
  await page.waitForTimeout(2000);
  expect(await getSessionPaymentAttemptRows(seed.sessionId)).toHaveLength(1);
  expect(countInvocationsForAccount(seed.connectedAccountId)).toBe(1);
  expect(countEffectsForAccount(seed.connectedAccountId)).toBe(1);

  // --- No real Stripe network.
  expect(stripeNetworkRequests).toEqual([]);

  // --- Clinical record unchanged; payment never finalized charting.
  const after = await readClinicalIntegritySnapshot(seed.sessionId);
  expect(after).toEqual(clinicalBefore);
  const clinical = (
    await adminQuery(
      `select finalized_at, record_status from public.sessions where id = $1`,
      [seed.sessionId],
    )
  ).rows[0] as { finalized_at: string | null; record_status: string };
  expect(clinical.finalized_at).toBeNull();
  expect(clinical.record_status).toBe("draft");
});
