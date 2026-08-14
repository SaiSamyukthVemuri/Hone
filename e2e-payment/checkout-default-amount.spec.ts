import { test, expect, type Page } from "@playwright/test";
import { loginAsOwner } from "../e2e/helpers/flows";
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
// detail, while quick checkout, which already used the bare-table
// `service:services(...)` form, kept working. That is exactly "the amount does
// not RELIABLY populate": it depended on which surface you opened.
//
// These specs are the end-to-end proof that never existed: no unit, DB or
// browser test had ever booked a PRICED service and asserted the prefill. The
// historical fixture books no service at all, so the only prefill any test saw
// came from the sessions.price_paid_cents fallback.
//
// They also pin that the internal note is OPTIONAL on BOTH payment surfaces and
// that a blank note persists as NULL, the belief that it is mandatory comes
// from the separate manual no-show FEE card, which genuinely requires one.
//
// Local-only lane: guarded fake Stripe, sk_test_dummy, no real provider egress.
// Nothing here prepares or executes a charge; it only reads the prepare form.

const SERVICE_NAME_PREFIX = "Checkout Default";
const SERVICE_PRICE_CENTS = 14500; // $145.00
const CUSTOM_PRICE_CENTS = 11000; // $110.00

// F-PAY-001: the amount is no longer an input. It is the server's decision,
// RENDERED. These read it rather than typing into it.
const amountField = (scope: Page | ReturnType<typeof modalOf>) =>
  scope.getByTestId("authoritative-amount");
const noteField = (scope: Page | ReturnType<typeof modalOf>) =>
  scope.getByPlaceholder(/note explaining the session payment/i);

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
    await expect(amountField(page)).toHaveText("$145.00");
    await expect(page.getByText(/Booked service: Checkout Default Priced/)).toBeVisible();
    await expect(page.getByTestId("amount-source")).toHaveText("Booked service price.");
    // The old invitation to edit is gone: the amount is authoritative.
    await expect(page.getByText("You can adjust before preparing.")).toHaveCount(0);
    // The "no price configured" state must NOT appear when a price resolved.
    await expect(page.getByTestId("session-payment-no-default-amount")).toHaveCount(0);
  });

  test("the amount stays editable", async ({ page }) => {
    await loginAsOwner(page, seed);
    await openSessionDetail(page, seed);
    // THE security assertion, inverted by this PR: the amount CANNOT be edited.
    await expect(page.getByLabel("Amount in Canadian dollars")).toHaveCount(0);
    await expect(page.locator('input[name="amount_dollars"]')).toHaveCount(0);
    // ...and the value the server decided is what is submitted back for the
    // stale check only.
    await expect(
      page.locator('input[name="expected_amount_cents"]'),
    ).toHaveValue("14500");
  });

  test("quick checkout prefills identically: the two surfaces agree", async ({ page }) => {
    await loginAsOwner(page, seed);
    await page.goto("/dashboard");
    await page.getByTestId("checkout-button").first().click();
    const modal = modalOf(page);
    await expect(modal).toBeVisible({ timeout: 20_000 });
    await expect(amountField(modal)).toHaveText("$145.00");
    await expect(modal.getByText(/Booked service: Checkout Default Priced/)).toBeVisible();
  });

  test("reopening quick checkout re-applies the default (no stale blank)", async ({ page }) => {
    await loginAsOwner(page, seed);
    await page.goto("/dashboard");
    await page.getByTestId("checkout-button").first().click();
    let modal = modalOf(page);
    await expect(amountField(modal)).toHaveText("$145.00");
    // Nothing to fill: the amount is not an input any more.
    await modal.getByTestId("quick-checkout-close").click();
    await expect(modal).toHaveCount(0);
    await page.getByTestId("checkout-button").first().click();
    modal = modalOf(page);
    await expect(amountField(modal)).toHaveText("$145.00");
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
    await expect(amountField(page)).toHaveText("$110.00");
    await expect(page.getByTestId("amount-source")).toHaveText(
      "Client-specific price for this service.",
    );
    await expect(page.getByText(/Custom pricing reminder: Long-standing package rate/)).toBeVisible();
    // The future-dated 250.00 row must NOT win.
    await expect(amountField(page)).not.toHaveText("$250.00");
    // Non-editable, and the displayed amount is what gets submitted back for
    // the stale check only.
    await expect(page.getByLabel("Amount in Canadian dollars")).toHaveCount(0);
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
      // amount and no Prepare action, and nothing is inserted.
      await expect(amountField(page)).toHaveCount(0);
      await expect(page.getByTestId("pricing-blocked")).toContainText(
        /No price is configured/i,
      );
      await expect(page.getByLabel("Amount in Canadian dollars")).toHaveCount(0);
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
      await expect(amountField(page)).toHaveCount(0);
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
      await expect(amountField(page)).toHaveText("$145.00");
      await expect(page.getByTestId("amount-source")).toHaveText("Booked service price.");
      await expect(page.getByText(/Booked service: .*Renamed/)).toBeVisible();
      await expect(page.getByLabel("Amount in Canadian dollars")).toHaveCount(0);
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
    // Exactly one attempt: no duplicate from a double submit.
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe("ready");
    // Blank note persists as NULL, never an auto-generated placeholder.
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
