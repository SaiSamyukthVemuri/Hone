import { test, expect, type Request, type Locator } from "@playwright/test";
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

// CLN-006 "focus outside re-enters": put focus on a real, visible control
// OUTSIDE the dialog (the state a stray click or script leaves behind), and
// prove it left the dialog before the next key is pressed.
async function focusOutsideDialog(dialog: Locator) {
  const moved = await dialog.evaluate((dlg) => {
    const outside = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).find((el) => !dlg.contains(el) && el.offsetParent !== null);
    outside?.focus();
    return outside !== undefined && document.activeElement === outside && !dlg.contains(document.activeElement);
  });
  expect(moved, "focus moved to a control outside the dialog").toBe(true);
}

// ===========================================================================
// Quick-checkout payment — the iPad success journey (PR #419).
// ===========================================================================
//
// Drives the COMPLETE browser charge flow through the guarded fake-Stripe
// boundary: dashboard → quick checkout → prepare → explicit confirmation →
// execute → persisted Paid state, then proves the charge is idempotent, moved
// no real money, and left the clinical record untouched.
//
// The eligibility chain is the untouched, CI-proven fixture (the REAL
// getSessionPaymentEligibility resolver governs it — see the DB-integration
// lane tests/db/quick-checkout-eligibility.db.test.ts). Here the browser
// re-confirms it through the live server action (the modal shows the Prepare
// form only when the resolver returns eligible), then charges through the fake.

const AMOUNT_LABEL = /Paid · \$225\.00/;

let seed: PaymentSeed;
let clinicalBefore: ClinicalIntegritySnapshot;
const stripeNetworkRequests: string[] = [];

test.beforeAll(async () => {
  // A clean fake ledger for this run (survives a Playwright retry).
  resetFakeStripeLedger();
  clearFakeStripeOutcome();
  // F-PAY-001: this success journey must have a REAL booked service priced at
  // the amount it charges. It previously carried no service at all and relied
  // on the historical sessions.price_paid_cents fallback to populate the field
  // — the exact fallback this change removed, because a past payment is not an
  // authority for what to charge today.
  seed = await seedEligiblePaymentWithLogin({
    label: "success",
    bookedService: { name: "Quick Checkout Success", priceCents: 22500 },
  });
});

test.afterAll(async () => {
  try {
    await cleanupPaymentScenario(seed.studioId);
  } finally {
    cleanupFakeStripeLedger();
    await closePool();
  }
});

test("iPad success journey: dashboard → prepare → confirm → execute → persisted Paid", async ({
  page,
}) => {
  // Fail loudly if the browser ever tries to reach Stripe directly (belt; the
  // substantive no-network proof is that the fake ledger recorded the call and
  // the real client was never constructed).
  page.on("request", (req: Request) => {
    if (/api\.stripe\.com/.test(req.url())) stripeNetworkRequests.push(req.url());
  });

  // --- Pre-browser: assert the eligibility INPUTS + capture baselines (step 2/4).
  const facts = (
    await adminQuery(
      `select
         a.status as appt_status,
         (s.started_at is not null) as session_started,
         (s.finalized_at is null) as not_finalized,
         cpm.status as card_status,
         cpm.stripe_livemode as card_livemode,
         (sps.stripe_account_status = 'enabled' and sps.stripe_charges_enabled) as connect_enabled,
         sps.stripe_livemode as connect_livemode,
         s.price_paid_cents as amount
       from public.sessions s
       join public.appointments a on a.id = s.appointment_id
       join public.client_payment_methods cpm on cpm.client_id = s.client_id and cpm.studio_id = s.studio_id
       join public.studio_payment_settings sps on sps.studio_id = s.studio_id
       where s.id = $1`,
      [seed.sessionId],
    )
  ).rows[0] as Record<string, unknown>;
  expect(facts.appt_status).toBe("completed");
  expect(facts.session_started).toBe(true);
  expect(facts.not_finalized).toBe(true);
  expect(facts.card_status).toBe("active");
  expect(facts.card_livemode).toBe(false); // test mode
  expect(facts.connect_enabled).toBe(true);
  expect(facts.connect_livemode).toBe(false); // test mode
  expect(Number(facts.amount)).toBe(seed.expectedAmountMinor); // 22500

  // No attempt yet, and the fake ledger is empty (step 3).
  expect(await getSessionPaymentAttemptRows(seed.sessionId)).toHaveLength(0);
  expect(readFakeStripeCalls()).toHaveLength(0);

  clinicalBefore = await readClinicalIntegritySnapshot(seed.sessionId);
  expect(clinicalBefore.exists).toBe(true);
  expect(clinicalBefore.started).toBe(true);

  // --- Log in as the real (magic-link) owner and open the dashboard (step 4/5).
  await loginAsOwner(page, seed);
  await page.goto("/dashboard");

  // --- Locate the fixture appointment; Checkout visible, Paid not (steps 6-8).
  const checkoutButton = page.getByTestId("checkout-button");
  await expect(checkoutButton).toBeVisible();
  await expect(page.getByTestId("appointment-payment-paid")).toHaveCount(0);

  // --- Open quick checkout; confirm context, amount, saved-card, no ids (9-13).
  await checkoutButton.click();
  const modal = page.getByTestId("quick-checkout-modal");
  await expect(modal).toBeVisible();
  await expect(modal.getByText(seed.clientName)).toBeVisible();
  // F-PAY-001 + F-PAY-002: the booked price is the server's decision, rendered
  // not edited — and quick checkout shows exactly what session detail shows.
  await expect(modal.getByTestId("authoritative-amount")).toHaveText("$225.00");
  // The FINAL charge is a separate, editable field defaulted to that reference.
  // This journey leaves it untouched, which is the ordinary checkout; the
  // adjusted-total journey lives in custom-final-amount-payment.spec.ts.
  await expect(modal.getByTestId("final-charge-input")).toHaveValue("225.00");
  // The legacy unguarded field never returns.
  await expect(modal.locator('input[name="amount_dollars"]')).toHaveCount(0);
  await expect(modal.getByText(/ending in 4242/i)).toBeVisible();
  // Processor identifiers are never shown by default (owner-only disclosure; and
  // there is no PaymentIntent yet anyway).
  await expect(modal.getByText(/pi_test_e2e/)).toHaveCount(0);

  // --- Prepare the payment (steps 14-15). The internal note is now OPTIONAL
  //     (Chloe workflow fix); we still fill one here to cover the with-note path.
  await modal
    .getByPlaceholder(/note explaining the session payment/i)
    .fill("E2E success-path session payment");
  await modal.getByRole("button", { name: /prepare session payment/i }).click();

  // --- Chloe workflow fix (CTA discoverability): the "Run charge" button now
  //     surfaces IN PLACE right after Prepare — no close/reopen. The modal
  //     silently re-resolves trusted context on a successful action, so the
  //     persisted 'ready' attempt drives the Ready panel without tearing the
  //     modal down. Waiting for Run charge also confirms the row committed.
  const runCharge = modal.getByRole("button", { name: /^run charge$/i });
  await expect(runCharge).toBeVisible();

  // --- Exactly one prepared attempt; ledger still empty (steps 16-18).
  const preparedRows = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(preparedRows).toHaveLength(1);
  expect(preparedRows[0].status).toBe("ready");
  expect(readFakeStripeCalls()).toHaveLength(0);

  // --- Configure fake success for THIS attempt's server-generated selector (19-20).
  const attemptId = preparedRows[0].id;
  const selector = idempotencySelectorForAttempt(attemptId);
  configureFakeStripeOutcome(selector, "success");

  // --- Execute the charge with the explicit two-click confirmation (21-23),
  //     WITHOUT any close/reopen dance.
  await runCharge.click(); // arms the confirm step
  const confirmCharge = modal.getByRole("button", { name: /confirm: run charge/i });
  await expect(confirmCharge).toBeVisible();
  await confirmCharge.click();

  // --- Persisted Paid (steps 24-25).
  const paidLine = modal.getByTestId("payment-summary-paid");
  await expect(paidLine).toBeVisible({ timeout: 30_000 });
  await expect(paidLine).toContainText(AMOUNT_LABEL);

  // --- Exactly one succeeded attempt (step 26).
  const chargedRows = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(chargedRows).toHaveLength(1);
  expect(chargedRows[0].status).toBe("succeeded");

  // --- One unconfirmed object and exactly one confirmation invocation/effect.
  expect(countInvocationsForAccount(seed.connectedAccountId)).toBe(1);
  expect(countEffectsForAccount(seed.connectedAccountId)).toBe(1);
  const piCall = readFakeStripeCalls().find((c) => c.method === "pi_create")!;
  expect(piCall.replay).toBe(false);
  // Object creation is separate from the one winner's money attempt.
  const confirmations = callsForAccount(seed.connectedAccountId).filter(c => c.method === "pi_confirm");
  expect(confirmations).toHaveLength(1);
  expect(confirmations[0]).toMatchObject({
    resultId: piCall.resultId, replay: false,
    idempotencyKey: `${selector.replace(/:create$/, ":confirm")}:${piCall.resultId}`,
  });

  expect(piCall.idempotencyKey).toBe(selector);
  expect(piCall.stripeAccount).toBe(`acct_test_e2e_${seed.scenario.runId}`);
  expect(piCall.amountCents).toBe(seed.expectedAmountMinor);
  expect(piCall.currency).toBe("cad");
  expect(piCall.resultId).toMatch(/^pi_test_e2e_/);

  // --- No real Stripe network request occurred (step 29 + no-network proof).
  expect(stripeNetworkRequests).toEqual([]);
  // The fake recorded the processor call; no refund path ran.
  expect(
    callsForAccount(seed.connectedAccountId).filter((c) => c.method === "refund_create"),
  ).toHaveLength(0);

  // --- Close the modal if it is still mounted (step 30). A successful in-place
  //     charge can auto-close the modal on its own: the dashboard re-renders the
  //     checkout cell into the persisted "Paid" badge, which unmounts the modal.
  //     So click Close only when it is still visible; skip it when the server
  //     refresh already closed it. The click itself stays UNGUARDED so a real
  //     interaction failure surfaces — we only avoid clicking an element that is
  //     no longer there. Either way the modal must end up gone.
  const closeButton = modal.getByTestId("quick-checkout-close");
  if (await closeButton.isVisible()) {
    await closeButton.click();
  }
  await expect(modal).toHaveCount(0);

  // --- Dashboard reflects the persisted Paid state after reload (steps 31-33).
  // (executeAction revalidates the session/clients paths, not /dashboard, so the
  // durable proof is the post-reload server render driven by the DB.)
  await page.goto("/dashboard");
  await expect(page.getByTestId("appointment-payment-paid")).toBeVisible();
  await expect(page.getByTestId("checkout-button")).toHaveCount(0);

  // --- Calendar surface shows the SAME persisted Paid; no charge affordance (34-37).
  await page.goto(`/calendar/${seed.appointmentId}`);
  await expect(page.getByTestId("appointment-payment-paid")).toBeVisible();
  await expect(page.getByTestId("checkout-button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /prepare session payment/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /run charge/i })).toHaveCount(0);

  // --- Attempt + fake call counts unchanged; no second charge (steps 38-39).
  const finalRows = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(finalRows).toHaveLength(1);
  expect(finalRows[0].status).toBe("succeeded");
  expect(countInvocationsForAccount(seed.connectedAccountId)).toBe(1);
  expect(countEffectsForAccount(seed.connectedAccountId)).toBe(1);

  // --- Clinical record untouched: before === after (step 40 / Section 6).
  const clinicalAfter = await readClinicalIntegritySnapshot(seed.sessionId);
  expect(clinicalAfter).toEqual(clinicalBefore);
  expect(clinicalAfter.started).toBe(true); // still started, never finalized by payment
  expect(clinicalAfter.blockCount).toBe(clinicalBefore.blockCount);
  expect(clinicalAfter.areaCount).toBe(clinicalBefore.areaCount);
  expect(clinicalAfter.consultationNoteCount).toBe(clinicalBefore.consultationNoteCount);
  expect(clinicalAfter.skinHairNoteCount).toBe(clinicalBefore.skinHairNoteCount);
  // The session is not clinically finalized by taking payment.
  const finalizedCheck = (
    await adminQuery(`select finalized_at from public.sessions where id = $1`, [
      seed.sessionId,
    ])
  ).rows[0] as { finalized_at: string | null };
  expect(finalizedCheck.finalized_at).toBeNull();
});


// CLN-006: native summary controls must remain reachable inside the shared
// modal trap. Existing synthetic fixture/real context loader only; no charge,
// receipt or refund action is invoked by either keyboard-only case.
for (const status of ["pending_stripe", "succeeded"] as const) {
  test(`quick checkout ${status}: keyboard reaches native details and wraps`, async ({ page }) => {
    const keyboardSeed = await seedEligiblePaymentWithLogin({
      label: `keyboard-${status}`,
      attempt: "ready",
      bookedService: { name: "Keyboard Checkout", priceCents: 22500 },
    });
    try {
      const before = await readClinicalIntegritySnapshot(keyboardSeed.sessionId);
      const [attempt] = await getSessionPaymentAttemptRows(keyboardSeed.sessionId);
      expect(attempt.status).toBe("ready");
      // An earlier failed attempt exposes the existing native history summary.
      await adminQuery(
        `insert into public.payment_charge_attempts
          (studio_id, charge_reason, client_id, session_id, appointment_id,
           created_by_practitioner_id, amount_cents, currency, status,
           stripe_livemode, client_payment_method_id, card_authorization_signature_id, created_at)
         select studio_id, charge_reason, client_id, session_id, appointment_id,
           created_by_practitioner_id, amount_cents, currency, 'failed',
           false, client_payment_method_id, card_authorization_signature_id, created_at - interval '1 day'
         from public.payment_charge_attempts where id = $1`,
        [attempt.id],
      );
      await loginAsOwner(page, keyboardSeed);
      await page.goto("/dashboard");
      const opener = page.getByTestId("checkout-button");
      await expect(opener).toBeVisible();
      // The existing dashboard still offers Checkout; the modal must read the
      // CURRENT pending/succeeded facts, not the older page's ready snapshot.
      await adminQuery(
        `update public.payment_charge_attempts set status = $2,
           stripe_payment_intent_id = $3,
           stripe_charge_id = case when $2 = 'succeeded' then $4 else null end,
           charged_at = case when $2 = 'succeeded' then now() else null end
         where id = $1`,
        [attempt.id, status, `pi_test_e2e_${keyboardSeed.scenario.runId}`,
          `ch_test_e2e_${keyboardSeed.scenario.runId}`],
      );
      const attemptsBefore = await getSessionPaymentAttemptRows(keyboardSeed.sessionId);
      await opener.click();
      const modal = page.getByTestId("quick-checkout-modal");
      const close = modal.getByTestId("quick-checkout-close");
      const technical = modal.getByTestId("technical-payment-details");
      const technicalSummary = technical.locator("summary");
      const historySummary = modal.locator("summary").filter({ hasText: /^Earlier attempts/ });
      await expect(modal.getByTestId(status === "pending_stripe"
        ? "payment-summary-processing" : "payment-summary-paid")).toBeVisible();
      await expect(technicalSummary).toBeVisible();
      await expect(historySummary).toHaveText("Earlier attempts (2)");
      await expect(close).toBeFocused();
      // Drive native Tab order, never focus() or click() the disclosures. The
      // pre-fix trap wraps before summaries and fails these reachability checks.
      for (let i = 0; i < 12 && !(await technicalSummary.evaluate((el) => el === document.activeElement)); i += 1) {
        await page.keyboard.press("Tab");
        expect(await modal.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      }
      await expect(technicalSummary).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(technical).toHaveAttribute("open", "");
      await page.keyboard.press("Enter");
      await expect(technical).not.toHaveAttribute("open", "");
      for (let i = 0; i < 12 && !(await historySummary.evaluate((el) => el === document.activeElement)); i += 1) {
        await page.keyboard.press("Tab");
        expect(await modal.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      }
      await expect(historySummary).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(historySummary.locator("..")).toHaveAttribute("open", "");
      await page.keyboard.press("Enter");
      await expect(historySummary.locator("..")).not.toHaveAttribute("open", "");
      await page.keyboard.press("Tab");
      await expect(close).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(historySummary).toBeFocused();
      // Focus outside re-enters: Tab to the first stop (close), Shift+Tab to the last.
      await focusOutsideDialog(modal);
      await page.keyboard.press("Tab");
      await expect(close).toBeFocused();
      await focusOutsideDialog(modal);
      await page.keyboard.press("Shift+Tab");
      await expect(historySummary).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0);
      await expect(opener).toBeFocused();
      expect(await getSessionPaymentAttemptRows(keyboardSeed.sessionId)).toEqual(attemptsBefore);
      expect(await readClinicalIntegritySnapshot(keyboardSeed.sessionId)).toEqual(before);
      expect(countInvocationsForAccount(keyboardSeed.connectedAccountId)).toBe(0);
      expect(countEffectsForAccount(keyboardSeed.connectedAccountId)).toBe(0);
    } finally {
      await cleanupPaymentScenario(keyboardSeed.studioId);
    }
  });
}
