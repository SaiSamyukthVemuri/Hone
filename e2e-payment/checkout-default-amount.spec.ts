import { test, expect, type Page } from "@playwright/test";
import { loginAsOwner, loginByMagicLink } from "../e2e/helpers/flows";
import { seedE2eMember } from "../e2e/helpers/seed";
import {
  seedEligiblePaymentWithLogin,
  cleanupPaymentScenario,
  adminQuery,
  closePool,
  type PaymentSeed,
} from "./helpers/payment-fixture";
import {
  modalOf,
  expectPreparedDurable,
  sessionPaymentRegion,
} from "./helpers/checkout-flow";

// ===========================================================================
// Checkout default amount + optional internal note (Chloe production feedback)
// ===========================================================================
//
// REPRODUCED REGRESSION. Migration 0151 replaced the single-column
// appointments.service_id FK with a composite (service_id, studio_id) FK.
// PostgREST resolves an `alias:<fk_column>(...)` embed hint only against a
// SINGLE-column FK, so the session-detail page's
// `services:service_id(name, price_cents)` started returning
// HTTP 400 / PGRST200 on every load. The page discarded the error, the booked
// service resolved to null, and the amount field was ALWAYS blank on session
// detail — while quick checkout, which already used the bare-table
// `service:services(...)` form, kept working. That is exactly "the amount does
// not RELIABLY populate": it depended on which surface you opened.
//
// These specs are the end-to-end proof that never existed: no unit, DB or
// browser test had ever booked a PRICED service and asserted the prefill. The
// historical fixture books no service at all, so the only prefill any test saw
// came from the sessions.price_paid_cents fallback.
//
// They also pin that the internal note is OPTIONAL on BOTH payment surfaces and
// that a blank note persists as NULL — the belief that it is mandatory comes
// from the separate manual no-show FEE card, which genuinely requires one.
//
// F-PAY-002 added §5 and §6: the booked price became the REFERENCE and the
// operator-authored final total became the thing that is charged. The
// editability assertions here were inverted twice, so each one now says which
// of the two numbers it is talking about rather than "the amount".
//
// Local-only lane: guarded fake Stripe, sk_test_dummy, no real provider egress.
// Some tests here PREPARE (a database row, no money moves); none executes a
// charge. Execution against fake Stripe lives in the payment journey specs.

const SERVICE_NAME_PREFIX = "Checkout Default";
const SERVICE_PRICE_CENTS = 14500; // $145.00
const CUSTOM_PRICE_CENTS = 11000; // $110.00

// F-PAY-001 then F-PAY-002. TWO numbers now, and keeping them apart is the
// point of this file:
//
//   referenceField — what the booked service (or this client's specific price)
//                    currently costs. Server-decided, RENDERED, never typed
//                    into. Read it; do not fill it.
//   finalChargeField — the operator-authored total that actually gets charged.
//                      Defaults to the reference and is editable by the owner.
const referenceField = (scope: Page | ReturnType<typeof modalOf>) =>
  scope.getByTestId("authoritative-amount");
const finalChargeField = (scope: Page | ReturnType<typeof modalOf>) =>
  scope.getByTestId("final-charge-input");
const reasonField = (scope: Page | ReturnType<typeof modalOf>) =>
  scope.getByTestId("adjustment-reason-input");
const noteField = (scope: Page | ReturnType<typeof modalOf>) =>
  scope.getByPlaceholder(/note explaining the session payment/i);

async function attemptsFor(sessionId: string) {
  const rows = await adminQuery(
    `select status, amount_cents, internal_note
       from public.payment_charge_attempts
      where session_id = $1
      order by created_at desc`,
    [sessionId],
  );
  return rows.rows as Array<{
    status: string;
    amount_cents: string | number;
    internal_note: string | null;
  }>;
}

async function openSessionDetail(page: Page, seed: PaymentSeed) {
  await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
  await expect(page.getByLabel("Session payment")).toBeVisible({ timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// 1. Priced booked service → BOTH surfaces default to the service price.
// ---------------------------------------------------------------------------
test.describe("priced booked service", () => {
  let seed: PaymentSeed;

  test.beforeAll(async () => {
    seed = await seedEligiblePaymentWithLogin({
      label: "default-priced",
      bookedService: { name: `${SERVICE_NAME_PREFIX} Priced`, priceCents: SERVICE_PRICE_CENTS },
    });
    // Remove the historical session-price fallback so the ONLY thing that can
    // populate the field is the booked-service default under test.
    await adminQuery(`update public.sessions set price_paid_cents = null where id = $1`, [
      seed.sessionId,
    ]);
  });

  test.afterAll(async () => {
    await cleanupPaymentScenario(seed.studioId);
    await closePool();
  });

  test("session detail prefills from the booked service and names the source", async ({
    page,
  }) => {
    await loginAsOwner(page, seed);
    await openSessionDetail(page, seed);

    // THE regression assertion. Pre-fix this field is empty on this surface.
    await expect(referenceField(page)).toHaveText("$145.00");
    await expect(page.getByText("Booked service", { exact: true })).toBeVisible();
    await expect(page.getByText(/Checkout Default Priced/)).toBeVisible();
    await expect(page.getByTestId("amount-source")).toHaveText("Booked service price.");
    // The pre-F-PAY-001 copy that framed the number as a mere suggestion to
    // tweak stays gone. The total IS editable again (see the next test), but it
    // is a named Final charge field, not an unlabelled nudge on the reference.
    await expect(page.getByText("You can adjust before preparing.")).toHaveCount(0);
    // The "no price configured" state must NOT appear when a price resolved.
    await expect(page.getByTestId("session-payment-no-default-amount")).toHaveCount(0);
  });

  test("the final charge is editable and defaults to the reference", async ({ page }) => {
    // Chloe: "I can't do a custom price... it's stuck as whatever the price of
    // the service is." This test's NAME and BODY finally agree again: under
    // F-PAY-001 it was called "the amount stays editable" while asserting the
    // exact opposite.
    await loginAsOwner(page, seed);
    await openSessionDetail(page, seed);

    const finalCharge = finalChargeField(page);
    await expect(finalCharge).toBeVisible();
    await expect(finalCharge).toBeEnabled();
    await expect(finalCharge).toHaveJSProperty("readOnly", false);
    await expect(finalCharge).toHaveValue("145.00");
    await expect(page.getByLabel("Final charge in Canadian dollars")).toBeVisible();

    // It really accepts typing.
    await finalCharge.fill("120.00");
    await expect(finalCharge).toHaveValue("120.00");
    // ...and a changed total asks for a reason, with an honest delta.
    await expect(reasonField(page)).toBeVisible();
    await expect(page.getByTestId("checkout-adjustment-delta")).toContainText(
      "Adjusted from $145.00 to $120.00",
    );

    // Back to the booked price: no reason is demanded for an ordinary checkout.
    await finalCharge.fill("145.00");
    await expect(reasonField(page)).toHaveCount(0);
    await expect(page.getByTestId("checkout-adjustment-delta")).toHaveCount(0);

    // The legacy unguarded field is still gone, and the reference is still
    // submitted back for the stale check only.
    await expect(page.locator('input[name="amount_dollars"]')).toHaveCount(0);
    await expect(
      page.locator('input[name="expected_amount_cents"]'),
    ).toHaveValue("14500");
  });

  test("quick checkout prefills identically — the two surfaces agree", async ({ page }) => {
    await loginAsOwner(page, seed);
    await page.goto("/dashboard");
    await page.getByTestId("checkout-button").first().click();
    const modal = modalOf(page);
    await expect(modal).toBeVisible({ timeout: 20_000 });
    await expect(referenceField(modal)).toHaveText("$145.00");
    // Scoped to the payment CARD. The modal's own header also names the booked
    // service, so an unscoped text match resolves to two elements and fails
    // strict mode — and would be asserting the modal chrome, not the card.
    await expect(
      modal.getByRole("region", { name: "Session payment" }).getByText(
        /Checkout Default Priced · 60 min/,
      ),
    ).toBeVisible();
    // The SAME editable total, from the SAME shared card — quick checkout
    // forks no pricing or payment logic of its own.
    await expect(finalChargeField(modal)).toHaveValue("145.00");
    await expect(finalChargeField(modal)).toBeEnabled();
  });

  test("reopening quick checkout re-applies the default (no stale edit)", async ({ page }) => {
    await loginAsOwner(page, seed);
    await page.goto("/dashboard");
    await page.getByTestId("checkout-button").first().click();
    let modal = modalOf(page);
    await expect(referenceField(modal)).toHaveText("$145.00");
    // Type an adjustment, then abandon it. Reopening must show the reference
    // again, never a half-finished total from a previous customer.
    await finalChargeField(modal).fill("99.00");
    await modal.getByTestId("quick-checkout-close").click();
    await expect(modal).toHaveCount(0);
    await page.getByTestId("checkout-button").first().click();
    modal = modalOf(page);
    await expect(referenceField(modal)).toHaveText("$145.00");
    await expect(finalChargeField(modal)).toHaveValue("145.00");
  });
});

// ---------------------------------------------------------------------------
// 2. Custom client pricing wins; future-dated custom pricing does not.
// ---------------------------------------------------------------------------
test.describe("custom client pricing precedence", () => {
  let seed: PaymentSeed;

  test.beforeAll(async () => {
    seed = await seedEligiblePaymentWithLogin({
      label: "default-custom",
      bookedService: { name: `${SERVICE_NAME_PREFIX} Custom`, priceCents: SERVICE_PRICE_CENTS },
      clientPricing: [
        {
          serviceName: `${SERVICE_NAME_PREFIX} Custom`,
          priceCents: CUSTOM_PRICE_CENTS,
          effectiveFrom: "2020-01-01",
          notes: "Long-standing package rate",
        },
        // Future-dated: must be ignored today.
        {
          serviceName: `${SERVICE_NAME_PREFIX} Custom`,
          priceCents: 25000,
          effectiveFrom: "2099-01-01",
        },
      ],
    });
    await adminQuery(`update public.sessions set price_paid_cents = null where id = $1`, [
      seed.sessionId,
    ]);
  });

  test.afterAll(async () => {
    await cleanupPaymentScenario(seed.studioId);
    await closePool();
  });

  test("the current custom price wins over the menu price, and says so", async ({ page }) => {
    await loginAsOwner(page, seed);
    await openSessionDetail(page, seed);
    await expect(referenceField(page)).toHaveText("$110.00");
    await expect(page.getByTestId("amount-source")).toHaveText(
      "Client-specific price for this service.",
    );
    await expect(page.getByText(/Custom pricing reminder: Long-standing package rate/)).toBeVisible();
    // The future-dated 250.00 row must NOT win.
    await expect(referenceField(page)).not.toHaveText("$250.00");
    // The client-specific price is the REFERENCE, so it is what the final
    // charge defaults to and what is submitted back for the stale check.
    await expect(finalChargeField(page)).toHaveValue("110.00");
    await expect(page.locator('input[name="expected_amount_cents"]')).toHaveValue(
      "11000",
    );
    await expect(
      page.getByRole("button", { name: /prepare session payment/i }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 3. Nothing resolvable → say so plainly instead of implying it auto-filled.
// ---------------------------------------------------------------------------
test.describe("no resolvable price", () => {
  test.afterAll(async () => {
    await closePool();
  });

  test("booked service with NO price says no price is configured", async ({ page }) => {
    const seed = await seedEligiblePaymentWithLogin({
      label: "default-unpriced",
      bookedService: { name: `${SERVICE_NAME_PREFIX} Unpriced`, priceCents: null },
    });
    await adminQuery(`update public.sessions set price_paid_cents = null where id = $1`, [
      seed.sessionId,
    ]);
    try {
      await loginAsOwner(page, seed);
      await openSessionDetail(page, seed);
      // F-PAY-001: an unresolvable price now BLOCKS preparation instead of
      // offering a blank editable field. There is no amount, no expected
      // amount and no Prepare action — and nothing is inserted.
      await expect(referenceField(page)).toHaveCount(0);
      await expect(page.getByTestId("pricing-blocked")).toContainText(
        /No price is configured/i,
      );
      // F-PAY-002: an unresolvable price offers no editable total either. A
      // custom amount is an adjustment TO a reference; with no reference there
      // is nothing to adjust and nothing may be charged.
      await expect(finalChargeField(page)).toHaveCount(0);
      await expect(
        page.locator('input[name="expected_amount_cents"]'),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /prepare session payment/i }),
      ).toHaveCount(0);
      await expect(page.getByText(/Defaulted from/)).toHaveCount(0);
      const rows = await adminQuery(
        `select id from public.payment_charge_attempts where session_id = $1`,
        [seed.sessionId],
      );
      expect(rows.rows).toHaveLength(0);
    } finally {
      await cleanupPaymentScenario(seed.studioId);
    }
  });

  test("appointment with NULL service_id says the same thing", async ({ page }) => {
    // No bookedService knob → the historical fixture shape: service_id NULL.
    const seed = await seedEligiblePaymentWithLogin({ label: "default-noservice" });
    expect(seed.scenario.serviceId).toBeNull();
    await adminQuery(`update public.sessions set price_paid_cents = null where id = $1`, [
      seed.sessionId,
    ]);
    try {
      await loginAsOwner(page, seed);
      await openSessionDetail(page, seed);
      // No booked service at all → blocked with its own precise reason.
      await expect(referenceField(page)).toHaveCount(0);
      await expect(finalChargeField(page)).toHaveCount(0);
      await expect(page.getByTestId("pricing-blocked")).toContainText(
        /no booked service/i,
      );
      await expect(
        page.getByRole("button", { name: /prepare session payment/i }),
      ).toHaveCount(0);
      const rows = await adminQuery(
        `select id from public.payment_charge_attempts where session_id = $1`,
        [seed.sessionId],
      );
      expect(rows.rows).toHaveLength(0);
    } finally {
      await cleanupPaymentScenario(seed.studioId);
    }
  });

  test("a service renamed after booking falls back to the menu price, not the stale custom row", async ({
    page,
  }) => {
    const seed = await seedEligiblePaymentWithLogin({
      label: "default-renamed",
      bookedService: { name: `${SERVICE_NAME_PREFIX} Renamed`, priceCents: SERVICE_PRICE_CENTS },
      // Custom pricing is matched by service NAME; this row names the OLD name.
      clientPricing: [
        {
          serviceName: `${SERVICE_NAME_PREFIX} Old Name`,
          priceCents: CUSTOM_PRICE_CENTS,
          effectiveFrom: "2020-01-01",
        },
      ],
    });
    await adminQuery(`update public.sessions set price_paid_cents = null where id = $1`, [
      seed.sessionId,
    ]);
    try {
      await loginAsOwner(page, seed);
      await openSessionDetail(page, seed);
      // Documents the KNOWN name-matching limitation: the negotiated rate is
      // silently dropped and the menu price is used. The label is honest about
      // which source won, so the practitioner can see it.
      await expect(referenceField(page)).toHaveText("$145.00");
      await expect(page.getByTestId("amount-source")).toHaveText("Booked service price.");
      await expect(page.getByText(/Renamed/)).toBeVisible();
      await expect(finalChargeField(page)).toHaveValue("145.00");
      await expect(page.locator('input[name="expected_amount_cents"]')).toHaveValue(
        "14500",
      );
    } finally {
      await cleanupPaymentScenario(seed.studioId);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Internal note is OPTIONAL on both surfaces, and blank persists as NULL.
// ---------------------------------------------------------------------------
test.describe("internal note is optional everywhere", () => {
  let seed: PaymentSeed;

  test.beforeAll(async () => {
    seed = await seedEligiblePaymentWithLogin({
      label: "note-optional",
      bookedService: { name: `${SERVICE_NAME_PREFIX} Note`, priceCents: SERVICE_PRICE_CENTS },
    });
  });

  test.afterAll(async () => {
    await cleanupPaymentScenario(seed.studioId);
    await closePool();
  });

  test("session detail: note is labelled optional and carries no required attribute", async ({
    page,
  }) => {
    await loginAsOwner(page, seed);
    await openSessionDetail(page, seed);
    await expect(page.getByText("Internal note (optional)")).toBeVisible();
    const note = noteField(page);
    await expect(note).toHaveJSProperty("required", false);
  });

  test("quick checkout: same optional note", async ({ page }) => {
    await loginAsOwner(page, seed);
    await page.goto("/dashboard");
    await page.getByTestId("checkout-button").first().click();
    const modal = modalOf(page);
    await expect(modal).toBeVisible({ timeout: 20_000 });
    await expect(modal.getByText("Internal note (optional)")).toBeVisible();
    await expect(noteField(modal)).toHaveJSProperty("required", false);
  });

  test("preparing with a BLANK note succeeds and persists NULL", async ({ page }) => {
    await loginAsOwner(page, seed);
    await openSessionDetail(page, seed);
    await expect(noteField(page)).toHaveValue("");
    await page.getByRole("button", { name: /prepare session payment/i }).click();
    // Synchronize on the DURABLE prepared state. The transient
    // "Session payment prepared." banner is replaced the instant
    // router.refresh() lands the persisted row, so waiting on it is a race that
    // fails while the payment is perfectly prepared.
    const region = sessionPaymentRegion(page);
    await expectPreparedDurable(region);

    const rows = await adminQuery(
      `select status, internal_note, amount_cents
         from public.payment_charge_attempts
        where session_id = $1
        order by created_at desc limit 1`,
      [seed.sessionId],
    );
    // Exactly one attempt — no duplicate from a double submit.
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe("ready");
    // Blank note persists as NULL — never an auto-generated placeholder.
    expect(rows.rows[0].internal_note).toBeNull();
    // The prepared amount is the booked-service default that populated the form.
    expect(Number(rows.rows[0].amount_cents)).toBe(SERVICE_PRICE_CENTS);
    // ...and the durable UI agrees with the row.
    await expect(region.getByRole("button", { name: /^run charge$/i })).toBeVisible();
    await expect(
      region.getByRole("button", { name: /prepare session payment/i }),
    ).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 5. F-PAY-002. The till: a deliberately authored total, its refusals, and the
//    row it finally produces — all on ONE seeded session, in the order Chloe
//    would actually hit them.
// ---------------------------------------------------------------------------
test.describe("an operator-authored final charge", () => {
  let seed: PaymentSeed;

  test.beforeAll(async () => {
    seed = await seedEligiblePaymentWithLogin({
      label: "final-amount",
      bookedService: {
        name: `${SERVICE_NAME_PREFIX} Adjust`,
        priceCents: SERVICE_PRICE_CENTS,
      },
    });
    await adminQuery(`update public.sessions set price_paid_cents = null where id = $1`, [
      seed.sessionId,
    ]);
  });

  test.afterAll(async () => {
    await cleanupPaymentScenario(seed.studioId);
    await closePool();
  });

  test("refuses $0 and an unexplained change, then prepares the discount", async ({
    page,
  }) => {
    // One test, one login, three outcomes, because each refusal must be proved
    // to leave the DATABASE untouched — and "no row" is only meaningful when
    // the very next step on the same session proves a row CAN be written.
    await loginAsOwner(page, seed);
    await openSessionDetail(page, seed);
    const region = sessionPaymentRegion(page);
    const finalCharge = finalChargeField(page);
    const prepare = page.getByRole("button", { name: /prepare session payment/i });

    // --- $0.00: calm, and nothing is prepared. -----------------------------
    await finalCharge.fill("0.00");
    // No reason is demanded for a total that will not be charged at all.
    await expect(reasonField(page)).toHaveCount(0);
    await expect(page.getByTestId("zero-charge-hint")).toBeVisible();
    await prepare.click();
    await expect(page.getByTestId("no-charge-required")).toContainText(
      /No charge is required at \$0\.00/i,
    );
    expect(await attemptsFor(seed.sessionId)).toHaveLength(0);

    // --- Changed total, no reason: refused. --------------------------------
    await finalCharge.fill("120.00");
    await expect(reasonField(page)).toBeVisible();
    // The browser's own `required` attribute would block submission before the
    // server ever saw it, which would prove nothing about the server. Strip it,
    // so this exercises the SERVER's refusal.
    await reasonField(page).evaluate((el) => el.removeAttribute("required"));
    await prepare.click();
    await expect(region.getByRole("alert")).toContainText(/reason for the adjustment/i);
    expect(await attemptsFor(seed.sessionId)).toHaveLength(0);

    // --- Changed total WITH a reason: prepared at the authored amount. -----
    await reasonField(page).fill("Client discount");
    await prepare.click();
    await expectPreparedDurable(region);

    const rows = await attemptsFor(seed.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ready");
    // THE assertion Chloe's report is about: $120, not the $145 menu price.
    expect(Number(rows[0].amount_cents)).toBe(12000);
    // The reference, the final amount and her words are all preserved.
    expect(rows[0].internal_note).toContain("$145.00");
    expect(rows[0].internal_note).toContain("$120.00");
    expect(rows[0].internal_note).toContain("Client discount");
    // ...and the durable UI charges what was prepared, not the menu price.
    await expect(region.getByText(/saved card will be charged \$120\.00/i)).toBeVisible();
    await expect(region.getByRole("button", { name: /^run charge$/i })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 6. F-PAY-002. A non-owner practitioner may still take payment at the booked
//    price, and may not author a different total. Enforced SERVER-side.
// ---------------------------------------------------------------------------
test.describe("a non-owner practitioner", () => {
  let seed: PaymentSeed;
  let memberEmail: string;

  test.beforeAll(async () => {
    seed = await seedEligiblePaymentWithLogin({
      label: "final-amount-member",
      bookedService: {
        name: `${SERVICE_NAME_PREFIX} Member`,
        priceCents: SERVICE_PRICE_CENTS,
      },
    });
    await adminQuery(`update public.sessions set price_paid_cents = null where id = $1`, [
      seed.sessionId,
    ]);
    const member = await seedE2eMember(seed);
    memberEmail = member.email;
  });

  test.afterAll(async () => {
    await cleanupPaymentScenario(seed.studioId);
    await closePool();
  });

  test("is refused a changed total, then prepares at the booked price", async ({
    page,
  }) => {
    await loginByMagicLink(page, memberEmail);
    await openSessionDetail(page, seed);
    const region = sessionPaymentRegion(page);
    const finalCharge = finalChargeField(page);
    const prepare = page.getByRole("button", { name: /prepare session payment/i });

    // The field is offered — preparing at the booked price is her job — but a
    // changed total tells her the truth instead of a reason box.
    await expect(finalCharge).toBeEnabled();
    await finalCharge.fill("120.00");
    await expect(page.getByTestId("owner-only-amount-hint")).toBeVisible();
    await expect(reasonField(page)).toHaveCount(0);

    // The UI hint is courtesy; the gate is the server's. Submit anyway.
    await prepare.click();
    await expect(region.getByRole("alert")).toContainText(
      /Only the studio owner can change the final charge/i,
    );
    expect(await attemptsFor(seed.sessionId)).toHaveLength(0);

    // ...and her ordinary checkout still works, unchanged.
    await finalCharge.fill("145.00");
    await prepare.click();
    await expectPreparedDurable(region);
    const rows = await attemptsFor(seed.sessionId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount_cents)).toBe(SERVICE_PRICE_CENTS);
  });
});
