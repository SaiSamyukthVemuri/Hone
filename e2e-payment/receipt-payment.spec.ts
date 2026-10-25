import { test, expect, type Page } from "@playwright/test";
import { loginAsOwner, loginByMagicLink } from "../e2e/helpers/flows";
import { seedE2eMember } from "../e2e/helpers/seed";
import {
  seedEligiblePaymentWithLogin,
  getSessionPaymentAttemptRows,
  idempotencySelectorForAttempt,
  cleanupPaymentScenario,
  adminQuery,
  closePool,
  type PaymentSeed,
} from "./helpers/payment-fixture";
import {
  resetFakeStripeLedger,
  clearFakeStripeOutcome,
  configureFakeStripeOutcome,
  callsForAccount,
  effectsForAccount,
  countInvocationsForAccount,
  cleanupFakeStripeLedger,
} from "./helpers/fake-stripe-ledger-e2e";
import { openCheckout, prepareInModal } from "./helpers/checkout-flow";

// ===========================================================================
// Quick-checkout receipt: success, failure, and retry (#420).
// ===========================================================================
//
// The charge and its receipt are separate facts, and a receipt must NEVER be
// able to move money. Each journey charges once through the REAL quick-checkout
// modal, lets the automatic receipt (PAY-RECEIPT-AUTO-01) settle against the
// guarded fake Resend transport, and then proves from the fake-Stripe LEDGER's
// own charge records (not from the UI) that exactly one charge exists:
//   * one paymentIntents.create invocation, which is one effect (replay=false),
//     under this attempt's server-generated idempotency key and amount;
//   * no refund call, and no further Stripe call of any kind after the charge;
//   * exactly one payment_charge_attempts row, status 'succeeded'.
//
// The fake Resend outcome is chosen by the recipient's local-part prefix
// (lib/email/e2e-fake-resend.ts): `success+` accepts, `reject+` is a terminal
// provider refusal, `throw+` is a transport exception (delivery ambiguous).
// The seeded client has no email, so each journey sets its own. Nothing leaves
// this machine: the transport and the processor are both the guarded fakes.
//
// NEW spec only: the shared e2e-payment helpers, fixtures and config are used
// as they are.

const AMOUNT_LABEL = /Paid · \$225\.00/;

let success: PaymentSeed;
let failed: PaymentSeed;
let ambiguous: PaymentSeed;
let nonOwner: PaymentSeed;

async function setClientEmail(seed: PaymentSeed, mode: string): Promise<string> {
  const email = `${mode}+receipt-${seed.scenario.runId}@harness.local`;
  await adminQuery(`update public.clients set email = $2 where id = $1`, [
    seed.clientId,
    email,
  ]);
  return email;
}

async function receiptRow(sessionId: string) {
  const r = await adminQuery(
    `select status, receipt_status, receipt_email_to, receipt_failure_code
       from public.payment_charge_attempts
      where session_id = $1 and charge_reason = 'session_payment'`,
    [sessionId],
  );
  return r.rows as Array<{
    status: string;
    receipt_status: string | null;
    receipt_email_to: string | null;
    receipt_failure_code: string | null;
  }>;
}

async function settledReceiptStatus(sessionId: string, expected: string): Promise<void> {
  // The automatic receipt settles inside the execute action's bounded wait;
  // poll the persisted row rather than assume the response ordering.
  await expect
    .poll(async () => (await receiptRow(sessionId))[0]?.receipt_status ?? null, {
      timeout: 15_000,
    })
    .toBe(expected);
}

// Exactly one charge, read from the fake processor's ledger for THIS
// scenario's synthetic connected account. The WHOLE account-scoped ledger is
// checked (Codex P2 4301359791): every processor method is recorded there, so
// a receipt path that retrieved, cancelled or refunded anything fails here.
function expectExactlyOneCharge(seed: PaymentSeed, attemptId: string): void {
  expect(callsForAccount(seed.connectedAccountId).map((c) => c.method)).toEqual(["pi_create"]);
  expect(countInvocationsForAccount(seed.connectedAccountId)).toBe(1);
  const effects = effectsForAccount(seed.connectedAccountId);
  expect(effects).toHaveLength(1);
  expect(effects[0].idempotencyKey).toBe(idempotencySelectorForAttempt(attemptId));
  expect(effects[0].amountCents).toBe(seed.expectedAmountMinor);
  expect(effects[0].resultId).toMatch(/^pi_test_e2e_/);
}

async function expectOneSucceededAttempt(seed: PaymentSeed): Promise<void> {
  const rows = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("succeeded");
}

// Charge once from the dashboard through the real modal; returns the attempt id.
async function chargeOnce(page: Page, seed: PaymentSeed): Promise<string> {
  await loginAsOwner(page, seed);
  await page.goto("/dashboard");
  const modal = await openCheckout(page);
  await prepareInModal(modal);

  const prepared = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(prepared).toHaveLength(1);
  const attemptId = prepared[0].id;
  configureFakeStripeOutcome(idempotencySelectorForAttempt(attemptId), "success");

  await modal.getByRole("button", { name: /^run charge$/i }).click();
  await modal.getByRole("button", { name: /confirm: run charge/i }).click();
  // The paid line can be replaced by the dashboard's Paid badge as the server
  // refresh unmounts the modal; either is the persisted success.
  await expect(
    modal
      .getByTestId("payment-summary-paid")
      .or(page.getByTestId("appointment-payment-paid"))
      .first(),
  ).toBeVisible({ timeout: 30_000 });
  return attemptId;
}

// The session-detail payment card: the surface that carries the receipt
// sub-panel and its retry. `kind` is the summary the card must show: a paid
// charge whose receipt failed is its own kind, still headed "Paid".
async function openSessionPayment(
  page: Page,
  seed: PaymentSeed,
  kind: "paid" | "paid_receipt_failed" = "paid",
) {
  await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
  const paidLine = page.getByTestId(`payment-summary-${kind}`);
  await expect(paidLine).toBeVisible();
  await expect(paidLine).toContainText(AMOUNT_LABEL);
  return page;
}

test.beforeAll(async () => {
  resetFakeStripeLedger();
  clearFakeStripeOutcome();
  const bookedService = { name: "Receipt Journey", priceCents: 22500 };
  success = await seedEligiblePaymentWithLogin({ label: "receipt-ok", bookedService });
  failed = await seedEligiblePaymentWithLogin({ label: "receipt-fail", bookedService });
  ambiguous = await seedEligiblePaymentWithLogin({ label: "receipt-amb", bookedService });
  nonOwner = await seedEligiblePaymentWithLogin({ label: "receipt-member", bookedService });
});

test.afterAll(async () => {
  try {
    for (const s of [success, failed, ambiguous, nonOwner]) {
      if (!s) continue;
      // The refused and ambiguous journeys each raise a critical receipt
      // alert. ops_alerts keeps its row on studio delete (ON DELETE SET NULL),
      // so remove THIS scenario's alerts first, or every green run leaves
      // orphaned critical alerts behind (Codex P2 4301505448).
      await adminQuery(`delete from public.ops_alerts where studio_id = $1`, [s.studioId]);
      await cleanupPaymentScenario(s.studioId);
    }
  } finally {
    cleanupFakeStripeLedger();
    await closePool();
  }
});

test("receipt success: the charge sends one receipt automatically, and exactly one charge exists", async ({
  page,
}) => {
  const email = await setClientEmail(success, "success");
  const attemptId = await chargeOnce(page, success);
  await settledReceiptStatus(success.sessionId, "sent");

  const [row] = await receiptRow(success.sessionId);
  expect(row.status).toBe("succeeded");
  expect(row.receipt_status).toBe("sent");
  expect(row.receipt_email_to).toBe(email);

  const view = await openSessionPayment(page, success);
  const sentLine = view.getByText(/^Receipt sent to /);
  await expect(sentLine).toBeVisible();
  // The practitioner's receipt line is masked. The full address is INTENDED to
  // appear only in the owner-only, collapsed "Technical payment details"
  // disclosure (PR #418, components/payment/technical-payment-details.tsx); the
  // non-owner journey below proves the other side of that gate.
  await expect(sentLine).not.toContainText(email);
  await expect(view.getByTestId("technical-payment-details")).toContainText(email);
  // Sent is final: there is no button to send it again.
  await expect(view.getByRole("button", { name: /^send receipt$/i })).toHaveCount(0);

  expectExactlyOneCharge(success, attemptId);
  await expectOneSucceededAttempt(success);
});

test("receipt success, non-owner view: NO Session payment region at all, and no receipt address or processor id reaches the browser", async ({
  page,
}) => {
  // HON-44 (Sam decision 12): card charges, and therefore the payment card and its
  // receipt panel, are owner-only. This used to prove the masked-receipt branch for
  // a practitioner who could SEE the card; now she cannot, which is a stronger
  // statement: nothing about the payment is rendered, and (closing the gap this test
  // used to flag) nothing about it is serialized into her page either.
  //
  // Its OWN paid session: charged here by the owner so this test runs alone and
  // survives a retry in a fresh worker. Then seen by an active practitioner who is
  // NOT the owner. The masked-receipt and Technical-details branches inside the card
  // stay as a second render gate; they have no browser path now (the guard is a
  // source pin in tests/app/hon-44-owner-only-surfaces.test.ts).
  const email = await setClientEmail(nonOwner, "success");
  const attemptId = await chargeOnce(page, nonOwner);
  await settledReceiptStatus(nonOwner.sessionId, "sent");

  await page.context().clearCookies();
  const member = await seedE2eMember(nonOwner);
  await loginByMagicLink(page, member.email);
  await page.goto(`/clients/${nonOwner.clientId}/sessions/${nonOwner.sessionId}`);
  // The chart page itself rendered for her, so an absent payment area is not a blank page.
  await expect(page.getByText(/done, back to client|back to sessions/i).first()).toBeVisible({
    timeout: 20_000,
  });

  await expect(page.getByLabel("Session payment")).toHaveCount(0);
  await expect(page.getByText(/^Receipt sent to /)).toHaveCount(0);
  await expect(page.getByTestId("technical-payment-details")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^send receipt$/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /refund/i })).toHaveCount(0);

  // RENDERED text: the receipt address is not on the page.
  expect(await page.evaluate(() => document.body.innerText)).not.toContain(email);
  // SERIALIZED payload: the document carries the RSC flight data. The payment card
  // is not rendered for her and its loaders do not run, so the processor identifiers
  // the attempt summary used to carry to every practitioner are not in it either.
  const wire = await page.content();
  expect(wire).not.toMatch(/acct_test_e2e_|pm_test_e2e_|cus_test_e2e_|seti_test_e2e_|pi_test_e2e_/);

  // Viewing is not charging.
  expectExactlyOneCharge(nonOwner, attemptId);
  await expectOneSucceededAttempt(nonOwner);
});

test("receipt failure then retry: Paid stays Paid, the retry sends the receipt, and it never charges again", async ({
  page,
}) => {
  await setClientEmail(failed, "reject");
  const attemptId = await chargeOnce(page, failed);
  await settledReceiptStatus(failed.sessionId, "failed");

  // Terminal provider refusal: the receipt is failed, the charge is not.
  let [row] = await receiptRow(failed.sessionId);
  expect(row.status).toBe("succeeded");
  expect(row.receipt_status).toBe("failed");
  expect(row.receipt_failure_code).not.toBeNull();
  expectExactlyOneCharge(failed, attemptId);
  const ledgerAfterCharge = callsForAccount(failed.connectedAccountId);

  const view = await openSessionPayment(page, failed, "paid_receipt_failed");
  await expect(view.getByText("Receipt send failed.")).toBeVisible();
  // No charge control is offered on a paid session whose receipt failed.
  await expect(view.getByRole("button", { name: /run charge/i })).toHaveCount(0);
  await expect(
    view.getByRole("button", { name: /prepare session payment/i }),
  ).toHaveCount(0);

  // The practitioner corrects the address, then retries the receipt.
  const corrected = await setClientEmail(failed, "success");
  await view.getByRole("button", { name: /^send receipt$/i }).click();
  await expect(view.getByText(/^Receipt sent to /)).toBeVisible({ timeout: 20_000 });

  [row] = await receiptRow(failed.sessionId);
  expect(row.receipt_status).toBe("sent");
  expect(row.receipt_email_to).toBe(corrected);

  // Persisted across a reload, still final.
  const reloaded = await openSessionPayment(page, failed);
  await expect(reloaded.getByText(/^Receipt sent to /)).toBeVisible();
  await expect(reloaded.getByRole("button", { name: /^send receipt$/i })).toHaveCount(0);

  // The retry made NO processor call at all, and the ledger still holds one charge.
  expect(callsForAccount(failed.connectedAccountId)).toEqual(ledgerAfterCharge);
  expectExactlyOneCharge(failed, attemptId);
  await expectOneSucceededAttempt(failed);
});

test("receipt ambiguous: an unknown delivery is held, never retried, and never charges again", async ({
  page,
}) => {
  await setClientEmail(ambiguous, "throw");
  const attemptId = await chargeOnce(page, ambiguous);
  await settledReceiptStatus(ambiguous.sessionId, "sending");
  // 'sending' is ALSO the in-flight claim, so it alone does not prove the
  // ambiguous branch ran (Codex P2 4301419880). Wait for that branch's own
  // durable record: the critical "claim held" ops alert for THIS attempt.
  await expect
    .poll(
      async () =>
        (
          await adminQuery(
            `select count(*)::int as n from public.ops_alerts
              where event = 'payment_receipt_send_ambiguous_claim_held'
                and severity = 'critical'
                and safe_details->>'attempt_id' = $1
                and (safe_details->>'delivery_unknown')::boolean
                and not (safe_details->>'claim_released')::boolean`,
            [attemptId],
          )
        ).rows[0].n as number,
      { timeout: 20_000 },
    )
    .toBe(1);

  // Delivery cannot be ruled out, so the claim is held at 'sending'.
  const [row] = await receiptRow(ambiguous.sessionId);
  expect(row.status).toBe("succeeded");
  expect(row.receipt_status).toBe("sending");

  const view = await openSessionPayment(page, ambiguous);
  await expect(view.getByText(/A receipt send is in flight/)).toBeVisible();
  // Still held after the page load: nothing released or retried it.
  expect((await receiptRow(ambiguous.sessionId))[0].receipt_status).toBe("sending");
  // No send button while delivery is unknown (a resend could duplicate it), and no charge control.
  await expect(view.getByRole("button", { name: /^send receipt$/i })).toHaveCount(0);
  await expect(view.getByRole("button", { name: /run charge/i })).toHaveCount(0);

  expectExactlyOneCharge(ambiguous, attemptId);
  await expectOneSucceededAttempt(ambiguous);
});
