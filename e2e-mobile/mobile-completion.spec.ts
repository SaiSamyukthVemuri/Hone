import { test, expect, type Page, type Request } from "@playwright/test";
import { loginAsOwner } from "../e2e/helpers/flows";
import {
  seedEligiblePaymentWithLogin,
  getSessionPaymentAttemptRows,
  idempotencySelectorForAttempt,
  cleanupPaymentScenario,
  adminQuery,
  closePool,
  type PaymentSeed,
} from "../e2e-payment/helpers/payment-fixture";
import {
  resetFakeStripeLedger,
  clearFakeStripeOutcome,
  configureFakeStripeOutcome,
  countInvocationsForAccount,
  countEffectsForAccount,
  callsForAccount,
  cleanupFakeStripeLedger,
} from "../e2e-payment/helpers/fake-stripe-ledger-e2e";

// ===========================================================================
// Mobile completion + payment journey (Chloe workflow fix) — Chromium at iPhone
// dimensions (iPhone 13 viewport + iOS UA + hasTouch) + a Pixel 5 control.
// ===========================================================================
//
// Reproduces and proves the fix for Chloe's iPhone-Safari failure: the "Mark
// completed" native window.confirm() could be silently suppressed by iOS Safari
// (returns false with nothing shown), which the old code treated as a Cancel,
// so the appointment never advanced and could never be charged. The fix routes
// the confirmation through an in-DOM ConfirmDialog (standard markup, no engine-
// specific APIs).
//
// ENGINE NOTE. The reproduction target is iOS Safari (WebKit), but this lane
// runs the Chromium engine at iPhone dimensions. The repo E2E harness is
// hard-wired to a plain-http http://localhost:3111 origin, and a real WebKit
// context upgrades every localhost subresource to https (no hydration) and drops
// Secure cookies over http (auth fails) — so a real-WebKit lane needs an HTTPS
// E2E harness (a separate follow-up). Chromium emulation is NOT equivalent to
// Safari validation; a supervised manual pass on a real iPhone Safari against
// the HTTPS Vercel preview is a required release gate before merge/staging.
//
// It proves:
//   * Phase 2 — the confirmation is an accessible in-DOM dialog (role=alertdialog,
//     aria-modal), with separate copy for complete vs no-show, and Cancel sends
//     NO request.
//   * Phase 3 — the internal note is OPTIONAL; a blank note persists as NULL.
//   * Phase 4 — after Prepare the "Run charge" CTA surfaces IN PLACE (no
//     close/reopen), the charge succeeds, and the canonical "Send receipt" action
//     is exposed on the durable billing surface.
//
// Provider-effect ledger (Phase 5): the whole journey moves ZERO real money and
// sends ZERO email/SMS. We assert exactly ONE fake Stripe charge for this
// scenario's connected account and — because Twilio has no fake transport and
// Resend is only faked on the welcome path — ZERO real egress to
// api.stripe.com / api.twilio.com / api.resend.com / googleapis.com via a
// page-level request monitor, plus DB emptiness. The seeded studio uses the
// default postcare mode (manual) and no SMS consent, so marking complete
// triggers no postcare email and no SMS structurally.

type Egress = {
  stripe: string[];
  twilio: string[];
  resend: string[];
  google: string[];
};

function installEgressMonitors(page: Page): Egress {
  const e: Egress = { stripe: [], twilio: [], resend: [], google: [] };
  page.on("request", (req: Request) => {
    const url = req.url();
    if (/api\.stripe\.com/.test(url)) e.stripe.push(url);
    if (/api\.twilio\.com/.test(url)) e.twilio.push(url);
    if (/api\.resend\.com/.test(url)) e.resend.push(url);
    if (/googleapis\.com|oauth2\.googleapis\.com|accounts\.google\.com/.test(url))
      e.google.push(url);
  });
  return e;
}

function expectNoProviderEgress(e: Egress) {
  // Fake Stripe never touches the network; Twilio/Resend/Google must be zero.
  expect(e.stripe).toEqual([]);
  expect(e.twilio).toEqual([]);
  expect(e.resend).toEqual([]);
  expect(e.google).toEqual([]);
}

let seed: PaymentSeed | null = null;

test.beforeEach(() => {
  resetFakeStripeLedger();
  clearFakeStripeOutcome();
});

test.afterEach(async () => {
  if (seed) {
    try {
      await cleanupPaymentScenario(seed.studioId);
    } finally {
      seed = null;
    }
  }
});

test.afterAll(async () => {
  cleanupFakeStripeLedger();
  await closePool();
});

test("iPhone: Mark completed via accessible dialog → in-place checkout → one fake charge, zero other providers", async ({
  page,
}) => {
  const egress = installEgressMonitors(page);

  // Chloe's exact starting state: a CONFIRMED appointment whose end time has
  // passed (the seed sets ends_at 30 min ago), with a session + saved card +
  // connected account — but NOT yet marked complete.
  // F-PAY-001: this journey promises "one fake charge", so it needs a REAL
  // priced booked service. It previously had appointment.service_id = NULL and
  // no service row, and relied on sessions.price_paid_cents to populate an
  // editable amount field — the historical fallback that is now retired,
  // because a past payment is not an authority for what to charge today.
  seed = await seedEligiblePaymentWithLogin({
    label: "mobile-complete",
    appointmentStatus: "confirmed",
    bookedService: { name: "Mobile Completion Service", priceCents: 22500 },
  });
  // Fixture guard: the success journey MUST start from resolvable pricing, so a
  // future fixture change cannot silently return this test to the blocked path.
  const svc = await adminQuery(
    `select s.price_cents from public.appointments a
       join public.services s on s.id = a.service_id
      where a.id = $1`,
    [seed.appointmentId],
  );
  expect(Number(svc.rows[0]?.price_cents)).toBe(22500);
  expect(await getSessionPaymentAttemptRows(seed.sessionId)).toHaveLength(0);

  await loginAsOwner(page, seed);
  await page.goto(`/calendar/${seed.appointmentId}`);

  // --- Mark completed is available because the appointment has ended.
  const markCompleted = page.getByRole("button", { name: /^mark completed$/i });
  await expect(markCompleted).toBeVisible();
  await expect(markCompleted).toBeEnabled();

  // --- Clicking opens the ACCESSIBLE in-DOM dialog — NOT native window.confirm
  //     (which WebKit can suppress). This is the core iPhone fix.
  await markCompleted.click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("role", "alertdialog");
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(
    dialog.getByText(/mark this appointment completed\?/i),
  ).toBeVisible();

  // --- Confirm runs the trusted server action once; appointment → completed.
  await page.getByTestId("confirm-dialog-confirm").click();
  await expect(dialog).toHaveCount(0);

  const apptStatus = (
    await adminQuery(`select status from public.appointments where id=$1`, [
      seed.appointmentId,
    ])
  ).rows[0].status;
  expect(apptStatus).toBe("completed");

  // --- The Checkout entry surfaces in place (status flipped to completed).
  const checkoutButton = page.getByTestId("checkout-button");
  await expect(checkoutButton).toBeVisible();

  // --- Open quick checkout. The internal note is OPTIONAL now — leave it blank.
  await checkoutButton.click();
  const modal = page.getByTestId("quick-checkout-modal");
  await expect(modal).toBeVisible();
  // The booked REFERENCE price is the SERVER's decision, rendered and never
  // typed into. The editable Final charge is asserted separately below.
  await expect(modal.getByTestId("authoritative-amount")).toHaveText("$225.00");
  await expect(modal.getByTestId("amount-source")).toHaveText("Booked service price.");
  // Scoped to the payment CARD: the modal's own header line also names the
  // booked service, so an unscoped match resolves to two elements and would be
  // asserting the modal chrome rather than the card's booked-service reminder.
  await expect(
    modal
      .getByRole("region", { name: "Session payment" })
      .getByText(/Mobile Completion Service/),
  ).toBeVisible();
  // The legacy unguarded field never returns.
  await expect(modal.locator('input[name="amount_dollars"]')).toHaveCount(0);
  await expect(modal.locator('input[name="expected_amount_cents"]')).toHaveValue("22500");
  await expect(modal.getByTestId("pricing-blocked")).toHaveCount(0);

  // F-PAY-002. The FINAL charge is editable ON A PHONE, with a real touch
  // target and a decimal keyboard — this is the control Chloe uses with a
  // client in the chair, so the mobile ergonomics are asserted here and not
  // inferred from the desktop layout.
  const finalCharge = modal.getByTestId("final-charge-input");
  await expect(finalCharge).toBeVisible();
  await expect(finalCharge).toBeEnabled();
  await expect(finalCharge).toHaveValue("225.00");
  expect(await finalCharge.getAttribute("inputmode")).toBe("decimal");
  const finalBox = await finalCharge.boundingBox();
  expect(finalBox!.height).toBeGreaterThanOrEqual(44);
  // Typing on the phone reveals the reason field at a usable size too.
  await finalCharge.fill("200.00");
  const reason = modal.getByTestId("adjustment-reason-input");
  await expect(reason).toBeVisible();
  const reasonBox = await reason.boundingBox();
  expect(reasonBox!.height).toBeGreaterThanOrEqual(44);
  // This journey charges the booked price; put it back before preparing.
  await finalCharge.fill("225.00");
  await expect(reason).toHaveCount(0);

  const prepareCta = modal.getByRole("button", { name: /prepare session payment/i });
  await expect(prepareCta).toBeVisible();
  const ctaBox = await prepareCta.boundingBox();
  expect(ctaBox!.height).toBeGreaterThanOrEqual(44);

  const note = modal.getByPlaceholder(/note explaining the session payment/i);
  await expect(note).toBeVisible();
  expect(await note.getAttribute("required")).toBeNull(); // optional, not required
  await modal.getByRole("button", { name: /prepare session payment/i }).click();

  // --- Phase 4: "Run charge" surfaces IN PLACE right after Prepare (no
  //     close/reopen). Waiting for it also confirms the 'ready' row committed.
  const runCharge = modal.getByRole("button", { name: /^run charge$/i });
  await expect(runCharge).toBeVisible();

  // --- Exactly one prepared attempt, stored with a NULL internal note (blank
  //     input became null; no fabricated placeholder).
  const prepared = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(prepared).toHaveLength(1);
  expect(prepared[0].status).toBe("ready");
  const noteRow = (
    await adminQuery(
      `select internal_note from public.payment_charge_attempts where id=$1`,
      [prepared[0].id],
    )
  ).rows[0] as { internal_note: string | null };
  expect(noteRow.internal_note).toBeNull();

  // --- Configure the fake charge to succeed for THIS attempt's server selector.
  const selector = idempotencySelectorForAttempt(prepared[0].id);
  configureFakeStripeOutcome(selector, "success");

  // --- Execute with the explicit two-click confirmation.
  await runCharge.click(); // arms the confirm step
  await modal.getByRole("button", { name: /confirm: run charge/i }).click();

  // --- Charge succeeded: the calendar/[id] page auto-refreshes (server action)
  //     and the checkout cell becomes the persisted "Paid" badge. (The modal is
  //     replaced by that badge on this surface — expected, not a regression.)
  await expect(page.getByTestId("appointment-payment-paid")).toBeVisible({
    timeout: 30_000,
  });

  // --- Exactly one succeeded attempt.
  const charged = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(charged).toHaveLength(1);
  expect(charged[0].status).toBe("succeeded");

  // --- Phase 4: the canonical receipt action is exposed + refresh-safe on the
  //     durable billing surface. We deliberately do NOT send it (Resend stays 0).
  await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
  await expect(
    page.getByRole("button", { name: /send receipt/i }),
  ).toBeVisible();

  // --- Provider-effect ledger: exactly ONE fake Stripe charge; nothing else.
  expect(countInvocationsForAccount(seed.connectedAccountId)).toBe(1);
  expect(countEffectsForAccount(seed.connectedAccountId)).toBe(1);
  expect(
    callsForAccount(seed.connectedAccountId).filter(
      (c) => c.method === "refund_create",
    ),
  ).toHaveLength(0);
  expectNoProviderEgress(egress);
});

test("iPhone: Cancel in the confirm dialog sends NO request (appointment stays confirmed)", async ({
  page,
}) => {
  const egress = installEgressMonitors(page);
  seed = await seedEligiblePaymentWithLogin({
    label: "mobile-cancel",
    appointmentStatus: "confirmed",
  });
  await loginAsOwner(page, seed);
  await page.goto(`/calendar/${seed.appointmentId}`);

  await page.getByRole("button", { name: /^mark completed$/i }).click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();

  // Cancel closes the dialog and must send NO request.
  await page.getByTestId("confirm-dialog-cancel").click();
  await expect(dialog).toHaveCount(0);

  // No mutation: still confirmed, no attempt, no checkout entry, no egress.
  const status = (
    await adminQuery(`select status from public.appointments where id=$1`, [
      seed.appointmentId,
    ])
  ).rows[0].status;
  expect(status).toBe("confirmed");
  expect(await getSessionPaymentAttemptRows(seed.sessionId)).toHaveLength(0);
  await expect(page.getByTestId("checkout-button")).toHaveCount(0);
  expect(countInvocationsForAccount(seed.connectedAccountId)).toBe(0);
  expectNoProviderEgress(egress);
});

test("iPhone: Mark no-show via the accessible dialog (separate copy); zero providers", async ({
  page,
}) => {
  const egress = installEgressMonitors(page);
  seed = await seedEligiblePaymentWithLogin({
    label: "mobile-noshow",
    appointmentStatus: "confirmed",
  });
  await loginAsOwner(page, seed);
  await page.goto(`/calendar/${seed.appointmentId}`);

  const noShow = page.getByRole("button", { name: /^mark no-show$/i });
  await expect(noShow).toBeVisible();
  await noShow.click();

  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  // Separate, truthful copy from the completed dialog.
  await expect(
    dialog.getByText(/mark this client as a no-show\?/i),
  ).toBeVisible();

  await page.getByTestId("confirm-dialog-confirm").click();
  await expect(dialog).toHaveCount(0);

  const status = (
    await adminQuery(`select status from public.appointments where id=$1`, [
      seed.appointmentId,
    ])
  ).rows[0].status;
  expect(status).toBe("no_show");
  // No checkout for a no-show; no payment attempt; no provider egress.
  await expect(page.getByTestId("checkout-button")).toHaveCount(0);
  expect(await getSessionPaymentAttemptRows(seed.sessionId)).toHaveLength(0);
  expect(countInvocationsForAccount(seed.connectedAccountId)).toBe(0);
  expectNoProviderEgress(egress);
});
