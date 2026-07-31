import { test, expect, type Page } from "@playwright/test";
import { loginAsOwner } from "../e2e/helpers/flows";
import {
  seedEligiblePaymentWithLogin,
  cleanupPaymentScenario,
  adminQuery,
  closePool,
  type PaymentSeed,
} from "./helpers/payment-fixture";
import { expectPreparedDurable, sessionPaymentRegion } from "./helpers/checkout-flow";

// F-PAY-001. The browser used to decide payment_charge_attempts.amount_cents:
// the prepare action read `amount_dollars` off the form and inserted it, so a
// tampered request preparing $1.00 against a $145.00 service became a real
// chargeable row. These prove the amount is now a SERVER decision.
//
// No real provider is reached: the payment lane uses the fake Stripe stack.

const PRICE = 14500;

async function attempts(sessionId: string) {
  const r = await adminQuery(
    `select status, amount_cents from public.payment_charge_attempts where session_id = $1`,
    [sessionId],
  );
  return r.rows as Array<{ status: string; amount_cents: number }>;
}

async function openSession(page: Page, seed: PaymentSeed) {
  await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
  const region = sessionPaymentRegion(page);
  await expect(region).toBeVisible({ timeout: 20_000 });
  return region;
}

async function seed(label: string, priceCents?: number) {
  const s: PaymentSeed = await seedEligiblePaymentWithLogin({
    label,
    bookedService: { name: `AUTH ${label}`, priceCents: priceCents ?? PRICE },
  });
  // Remove the historical session price so it cannot mask a missing authority.
  await adminQuery(`update public.sessions set price_paid_cents = null where id = $1`, [
    s.sessionId,
  ]);
  return s;
}

function suite(label: string, viewport: { width: number; height: number }, isMobile: boolean) {
  test.describe(label, () => {
    test.use({ viewport, isMobile, hasTouch: isMobile });

    test("the authoritative amount is shown, not editable, and is what gets prepared", async ({
      page,
    }) => {
      const s = await seed("shown");
      await loginAsOwner(page, s);
      const region = await openSession(page, s);

      await expect(region.getByTestId("authoritative-amount")).toHaveText("$145.00");
      await expect(region.getByTestId("amount-source")).toHaveText("Booked service price.");
      await expect(region.getByText(/Booked service: AUTH shown/)).toBeVisible();
      // THE fix: there is no amount input at all.
      await expect(page.getByLabel("Amount in Canadian dollars")).toHaveCount(0);

      await region.getByRole("button", { name: /prepare session payment/i }).click();
      await expectPreparedDurable(region);

      const rows = await attempts(s.sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("ready");
      expect(Number(rows[0].amount_cents)).toBe(PRICE);
      await cleanupPaymentScenario(s.studioId);
    });

    test("a crafted amount_dollars cannot create or alter an attempt", async ({ page }) => {
      const s = await seed("tamper");
      await loginAsOwner(page, s);
      const region = await openSession(page, s);

      // Inject the old contract's field into the live form and submit it.
      await region.evaluate((el) => {
        const form = el.querySelector("form");
        const inj = document.createElement("input");
        inj.name = "amount_dollars";
        inj.value = "1.00";
        form?.appendChild(inj);
      });
      await region.getByRole("button", { name: /prepare session payment/i }).click();
      await expectPreparedDurable(region);

      const rows = await attempts(s.sessionId);
      expect(rows).toHaveLength(1);
      // The server amount, never the injected $1.00.
      expect(Number(rows[0].amount_cents)).toBe(PRICE);
      await cleanupPaymentScenario(s.studioId);
    });

    test("a tampered expected_amount_cents (lower OR higher) prepares NOTHING", async ({
      page,
    }) => {
      for (const tampered of ["100", "999900"]) {
        const s = await seed(`expect-${tampered}`);
        await loginAsOwner(page, s);
        const region = await openSession(page, s);

        await region.evaluate((el, value) => {
          const f = el.querySelector<HTMLInputElement>('input[name="expected_amount_cents"]');
          if (f) f.value = value;
        }, tampered);
        await region.getByRole("button", { name: /prepare session payment/i }).click();

        await expect(region.getByText(/The price changed/i)).toBeVisible({ timeout: 20_000 });
        expect(await attempts(s.sessionId)).toHaveLength(0);
        await cleanupPaymentScenario(s.studioId);
      }
    });

    test("a price that changes after render blocks, then prepares at the NEW amount", async ({
      page,
    }) => {
      const s = await seed("stale");
      await loginAsOwner(page, s);
      const region = await openSession(page, s);
      await expect(region.getByTestId("authoritative-amount")).toHaveText("$145.00");

      // The studio raises the price while the page is open.
      await adminQuery(
        `update public.services set price_cents = 15000 where studio_id = $1 and name = $2`,
        [s.studioId, "AUTH stale"],
      );

      await region.getByRole("button", { name: /prepare session payment/i }).click();
      await expect(region.getByText(/The price changed/i)).toBeVisible({ timeout: 20_000 });
      // Nothing was prepared at either price.
      expect(await attempts(s.sessionId)).toHaveLength(0);

      // After reviewing the new amount, a second explicit press prepares 15000.
      await page.reload();
      const fresh = sessionPaymentRegion(page);
      await expect(fresh.getByTestId("authoritative-amount")).toHaveText("$150.00", {
        timeout: 20_000,
      });
      await fresh.getByRole("button", { name: /prepare session payment/i }).click();
      await expectPreparedDurable(fresh);
      const rows = await attempts(s.sessionId);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].amount_cents)).toBe(15000);
      await cleanupPaymentScenario(s.studioId);
    });

    test("a client-specific price wins and is labelled truthfully", async ({ page }) => {
      const s = await seed("custom");
      await adminQuery(
        `insert into public.client_pricing (id, studio_id, client_id, service_name, price_cents, notes, effective_from)
         values (gen_random_uuid(), $1, $2, $3, 12000, 'Package rate', current_date - 1)`,
        [s.studioId, s.clientId, "AUTH custom"],
      );
      await loginAsOwner(page, s);
      const region = await openSession(page, s);

      await expect(region.getByTestId("authoritative-amount")).toHaveText("$120.00");
      await expect(region.getByTestId("amount-source")).toHaveText(
        "Client-specific price for this service.",
      );
      await region.getByRole("button", { name: /prepare session payment/i }).click();
      await expectPreparedDurable(region);
      expect(Number((await attempts(s.sessionId))[0].amount_cents)).toBe(12000);
      await cleanupPaymentScenario(s.studioId);
    });

    test("conflicting current client prices BLOCK preparation", async ({ page }) => {
      const s = await seed("conflict");
      for (const cents of [12000, 13000]) {
        await adminQuery(
          `insert into public.client_pricing (id, studio_id, client_id, service_name, price_cents, notes, effective_from)
           values (gen_random_uuid(), $1, $2, $3, $4, null, current_date - 1)`,
          [s.studioId, s.clientId, "AUTH conflict", cents],
        );
      }
      await loginAsOwner(page, s);
      const region = await openSession(page, s);

      await expect(region.getByTestId("pricing-blocked")).toContainText(
        /conflicting|more than one current/i,
      );
      await expect(
        region.getByRole("button", { name: /prepare session payment/i }),
      ).toHaveCount(0);
      await expect(region.getByTestId("authoritative-amount")).toHaveCount(0);
      expect(await attempts(s.sessionId)).toHaveLength(0);
      await cleanupPaymentScenario(s.studioId);
    });

    test("no configured price BLOCKS preparation with a clear reason", async ({ page }) => {
      const s = await seed("noprice");
      await adminQuery(
        `update public.services set price_cents = null where studio_id = $1 and name = $2`,
        [s.studioId, "AUTH noprice"],
      );
      await loginAsOwner(page, s);
      const region = await openSession(page, s);

      await expect(region.getByTestId("pricing-blocked")).toContainText(/No price is configured/i);
      await expect(
        region.getByRole("button", { name: /prepare session payment/i }),
      ).toHaveCount(0);
      expect(await attempts(s.sessionId)).toHaveLength(0);
      await cleanupPaymentScenario(s.studioId);
    });

    test("a blank internal note still stores NULL", async ({ page }) => {
      const s = await seed("note");
      await loginAsOwner(page, s);
      const region = await openSession(page, s);
      await region.getByRole("button", { name: /prepare session payment/i }).click();
      await expectPreparedDurable(region);
      const r = await adminQuery(
        `select internal_note from public.payment_charge_attempts where session_id = $1`,
        [s.sessionId],
      );
      expect(r.rows[0].internal_note).toBeNull();
      await cleanupPaymentScenario(s.studioId);
    });


    test("a malformed or missing expected amount blocks and inserts nothing", async ({
      page,
    }) => {
      for (const value of ["", "abc", "-1", "14500.5"]) {
        const s = await seed(`malformed-${value || "empty"}`);
        await loginAsOwner(page, s);
        const region = await openSession(page, s);
        await region.evaluate((el, v) => {
          const f = el.querySelector<HTMLInputElement>('input[name="expected_amount_cents"]');
          if (f) f.value = v;
        }, value);
        await region.getByRole("button", { name: /prepare session payment/i }).click();
        await expect(region.getByText(/The price changed/i)).toBeVisible({ timeout: 20_000 });
        expect(await attempts(s.sessionId), `value=${value}`).toHaveLength(0);
        await cleanupPaymentScenario(s.studioId);
      }
    });

    test("a CLIENT price changed after render blocks", async ({ page }) => {
      const s = await seed("client-stale");
      await adminQuery(
        `insert into public.client_pricing (id, studio_id, client_id, service_name, price_cents, notes, effective_from)
         values (gen_random_uuid(), $1, $2, $3, 12000, null, current_date - 1)`,
        [s.studioId, s.clientId, "AUTH client-stale"],
      );
      await loginAsOwner(page, s);
      const region = await openSession(page, s);
      await expect(region.getByTestId("authoritative-amount")).toHaveText("$120.00");
      // The studio renegotiates while the page is open.
      await adminQuery(
        `update public.client_pricing set price_cents = 13000 where studio_id = $1 and client_id = $2`,
        [s.studioId, s.clientId],
      );
      await region.getByRole("button", { name: /prepare session payment/i }).click();
      await expect(region.getByText(/The price changed/i)).toBeVisible({ timeout: 20_000 });
      expect(await attempts(s.sessionId)).toHaveLength(0);
      await cleanupPaymentScenario(s.studioId);
    });

    test("identical equally-current client prices RESOLVE deterministically", async ({
      page,
    }) => {
      const s = await seed("tie");
      for (let i = 0; i < 2; i++) {
        await adminQuery(
          `insert into public.client_pricing (id, studio_id, client_id, service_name, price_cents, notes, effective_from)
           values (gen_random_uuid(), $1, $2, $3, 12500, null, current_date - 1)`,
          [s.studioId, s.clientId, "AUTH tie"],
        );
      }
      await loginAsOwner(page, s);
      const region = await openSession(page, s);
      await expect(region.getByTestId("authoritative-amount")).toHaveText("$125.00");
      await region.getByRole("button", { name: /prepare session payment/i }).click();
      await expectPreparedDurable(region);
      expect(Number((await attempts(s.sessionId))[0].amount_cents)).toBe(12500);
      await cleanupPaymentScenario(s.studioId);
    });

    test("an authoritative price above the ceiling BLOCKS and never clamps", async ({
      page,
    }) => {
      const s = await seed("ceiling");
      await adminQuery(
        `update public.services set price_cents = 500000 where studio_id = $1 and name = $2`,
        [s.studioId, "AUTH ceiling"],
      );
      await loginAsOwner(page, s);
      const region = await openSession(page, s);
      await region.getByRole("button", { name: /prepare session payment/i }).click();
      // Blocked with the ceiling error; nothing prepared, and NOT reduced.
      await expect(region.getByText(/above the supported session-payment limit/i).first()).toBeVisible({
        timeout: 20_000,
      });
      expect(await attempts(s.sessionId)).toHaveLength(0);
      await cleanupPaymentScenario(s.studioId);
    });

    test("a non-empty internal note is preserved verbatim", async ({ page }) => {
      const s = await seed("realnote");
      await loginAsOwner(page, s);
      const region = await openSession(page, s);
      await region
        .getByPlaceholder(/note explaining the session payment/i)
        .fill("Package session 3 of 6");
      await region.getByRole("button", { name: /prepare session payment/i }).click();
      await expectPreparedDurable(region);
      const r = await adminQuery(
        `select internal_note from public.payment_charge_attempts where session_id = $1`,
        [s.sessionId],
      );
      expect(r.rows[0].internal_note).toBe("Package session 3 of 6");
      await cleanupPaymentScenario(s.studioId);
    });

    test("a rapid double-click prepares exactly ONE attempt", async ({ page }) => {
      const s = await seed("double");
      await loginAsOwner(page, s);
      const region = await openSession(page, s);
      const btn = region.getByRole("button", { name: /prepare session payment/i });
      await Promise.all([btn.click(), btn.click().catch(() => {})]);
      await expectPreparedDurable(region);
      const rows = await attempts(s.sessionId);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].amount_cents)).toBe(PRICE);
      await cleanupPaymentScenario(s.studioId);
    });

    test("an existing active attempt blocks a second preparation", async ({ page }) => {
      const s = await seed("dupe");
      await loginAsOwner(page, s);
      const region = await openSession(page, s);
      await region.getByRole("button", { name: /prepare session payment/i }).click();
      await expectPreparedDurable(region);
      // The form is gone; the ready panel owns the surface.
      await expect(
        region.getByRole("button", { name: /prepare session payment/i }),
      ).toHaveCount(0);
      expect(await attempts(s.sessionId)).toHaveLength(1);
      await cleanupPaymentScenario(s.studioId);
    });

    test("changing the price AFTER preparation does not rewrite the attempt", async ({
      page,
    }) => {
      const s = await seed("immutable");
      await loginAsOwner(page, s);
      const region = await openSession(page, s);
      await region.getByRole("button", { name: /prepare session payment/i }).click();
      await expectPreparedDurable(region);
      expect(Number((await attempts(s.sessionId))[0].amount_cents)).toBe(PRICE);

      await adminQuery(
        `update public.services set price_cents = 19900 where studio_id = $1 and name = $2`,
        [s.studioId, "AUTH immutable"],
      );
      await page.reload();
      // Preparation is the pricing boundary: the persisted attempt is unchanged.
      const rows = await attempts(s.sessionId);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].amount_cents)).toBe(PRICE);
      await cleanupPaymentScenario(s.studioId);
    });

    test("layout holds and the CTA is touch-sized", async ({ page }) => {
      const s = await seed("layout");
      await loginAsOwner(page, s);
      const region = await openSession(page, s);
      await expect(region.getByTestId("authoritative-amount")).toBeVisible();
      await expect(region.getByTestId("amount-source")).toBeVisible();
      const box = await region
        .getByRole("button", { name: /prepare session payment/i })
        .boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      const d = await page.evaluate(() => ({
        s: document.documentElement.scrollWidth,
        c: document.documentElement.clientWidth,
      }));
      expect(d.s).toBeLessThanOrEqual(d.c + 1);
      await cleanupPaymentScenario(s.studioId);
    });
  });
}

suite("iPhone 390px", { width: 390, height: 844 }, true);
suite("desktop", { width: 1280, height: 900 }, false);

test.afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
// PR #494 workflow non-regression: chart → Finish appointment → payment.
// The payment card sits BELOW Finish and unlocks once the appointment is
// completed; this proves the authoritative amount appears there and that the
// Finish states survive preparing a payment.
// ---------------------------------------------------------------------------
function workflowSuite(
  label: string,
  viewport: { width: number; height: number },
  isMobile: boolean,
) {
  test.describe(`PR #494 workflow — ${label}`, () => {
    test.use({ viewport, isMobile, hasTouch: isMobile });

    test("complete the appointment, then prepare payment below Finish", async ({
      page,
    }) => {
      const s = await seed("workflow");
      await loginAsOwner(page, s);
      await page.goto(`/clients/${s.clientId}/sessions/${s.sessionId}`);

      const finish = page.getByTestId("finish-appointment");
      await expect(finish).toBeVisible({ timeout: 20_000 });

      await test.step("page order: charting → Finish → payment", async () => {
        const fBox = await finish.boundingBox();
        const pBox = await page.locator("#session-payment").boundingBox();
        expect(fBox && pBox && pBox.y > fBox.y).toBe(true);
      });

      await test.step("charting never offers no-show", async () => {
        await expect(page.getByRole("button", { name: /no-show/i })).toHaveCount(0);
      });

      // NOTE: this fixture's appointment is ALREADY completed — that is what
      // makes it payment-eligible. Driving completion and the aftercare stamp
      // from scratch is proven by the merged PR #494 spec
      // (e2e/finish-appointment-mobile.spec.ts, 24 tests). What is NEW here,
      // and what this proves, is that the authoritative amount appears in the
      // payment card BELOW Finish and that the Finish states survive preparing
      // a payment.
      await test.step("the appointment reads Completed and Finish is intact", async () => {
        await expect(page.getByTestId("finish-completion-status")).toHaveText(
          "Completed",
          { timeout: 20_000 },
        );
        await expect(page.getByTestId("finish-charting-status")).toBeVisible();
        await expect(page.getByTestId("finish-aftercare-status")).toBeVisible();
      });

      await test.step("payment unlocks below Finish with the authoritative amount", async () => {
        const region = sessionPaymentRegion(page);
        await expect(region.getByTestId("authoritative-amount")).toHaveText("$145.00", {
          timeout: 20_000,
        });
        await expect(region.getByTestId("amount-source")).toHaveText(
          "Booked service price.",
        );
        await expect(page.getByLabel("Amount in Canadian dollars")).toHaveCount(0);
        const cta = region.getByRole("button", { name: /prepare session payment/i });
        const box = await cta.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        await cta.click();
        await expectPreparedDurable(region);
        expect(Number((await attempts(s.sessionId))[0].amount_cents)).toBe(PRICE);
      });

      await test.step("the Finish states survive preparing a payment", async () => {
        await expect(page.getByTestId("finish-completion-status")).toHaveText("Completed");
        await expect(page.getByTestId("finish-aftercare-status")).toBeVisible();
        await expect(finish.getByText("Postcare email")).toBeVisible();
        await expect(
          finish.getByRole("button", { name: /Done — back to client/ }),
        ).toBeVisible();
      });

      await test.step("no horizontal overflow, nothing clipped", async () => {
        const d = await page.evaluate(() => ({
          s: document.documentElement.scrollWidth,
          c: document.documentElement.clientWidth,
        }));
        expect(d.s).toBeLessThanOrEqual(d.c + 1);
      });

      await cleanupPaymentScenario(s.studioId);
    });
  });
}

workflowSuite("iPhone 390px", { width: 390, height: 844 }, true);
workflowSuite("desktop", { width: 1280, height: 900 }, false);
