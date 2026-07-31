import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eTiedServices,
  getStudioServiceOrder,
  getOwnerPractitionerId,
  seedServiceEligibility,
  getPublicBookingServiceOrder,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Service menu order + colour hierarchy (Chloe production feedback) — real
// browser, real local stack, DB rows as ground truth.
//
// REPRODUCED DEFECT. Every seeded service starts at the legacy
// `sort_order = 100` — the real production shape, because 0021's default is 100
// and the "next" allocator is scoped per modality. Against the old two-update
// swap the arrows moved the wrong row or silently did nothing. Here one tap must
// equal exactly one position, and "Move to top" must reach the top in one tap.

const T = 20_000;

const CONSULT = "Client Consultation";

async function openServices(page: Page) {
  await page.goto("/settings/services");
  await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible({
    timeout: T,
  });
}

// The visible order as the SCREEN shows it (service name per row, in DOM order).
async function screenOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="service-row-"] article button[aria-expanded] span.truncate')
    .allTextContents();
}

test.describe("service reorder", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("one tap = one position; Move to top reaches the top in ONE tap", async ({ page }) => {
    const seed = await seedE2eStudio();
    const ids = await seedE2eTiedServices(seed.studioId, [
      "AAA First Alphabetically",
      "Electrolysis 30",
      "Electrolysis 60",
      CONSULT,
    ]);
    // The public booking menu only offers services a practitioner is eligible
    // for, so make all four bookable — otherwise the parity step would compare
    // a one-item list and prove nothing.
    const ownerPractitionerId = await getOwnerPractitionerId(seed.studioId);
    for (const serviceId of Object.values(ids)) {
      await seedServiceEligibility(seed.studioId, serviceId, ownerPractitionerId);
    }
    await loginAsOwner(page, seed);
    await openServices(page);

    // seedE2eStudio already creates the studio's booking service, so the list is
    // the four seeded here PLUS that one — deliberately not hardcoded.
    const total = (await getStudioServiceOrder(seed.studioId)).length;
    const expectedPositions = Array.from({ length: total }, (_, i) => (i + 1) * 10);

    await test.step("the seeded studio really is tied at the legacy default", async () => {
      const rows = await getStudioServiceOrder(seed.studioId);
      // Every service this spec seeded sits on the legacy 100 — the shape that
      // made the old arrows resolve ties in heap order.
      expect(rows.filter((r) => r.sort_order === 100).length).toBeGreaterThanOrEqual(4);
    });

    const consultId = ids[CONSULT];

    await test.step("Move to top puts Client Consultation first — in one tap", async () => {
      await page.getByTestId(`move-top-${consultId}`).click();
      await expect
        .poll(async () => (await getStudioServiceOrder(seed.studioId))[0]?.name, { timeout: T })
        .toBe(CONSULT);
      await expect(await screenOrder(page)).toContain(CONSULT);
    });

    await test.step("positions are normalized to unique 10, 20, 30 …", async () => {
      const rows = await getStudioServiceOrder(seed.studioId);
      expect(rows.map((r) => r.sort_order)).toEqual(expectedPositions);
      expect(new Set(rows.map((r) => r.sort_order)).size).toBe(rows.length);
    });

    const positionOf = async (name: string) =>
      (await getStudioServiceOrder(seed.studioId)).findIndex((r) => r.name === name);

    await test.step("Move down moves exactly ONE position — not two, not zero", async () => {
      const before = (await getStudioServiceOrder(seed.studioId)).map((r) => r.name);
      const from = before.indexOf(CONSULT);
      await page.getByTestId(`move-down-${consultId}`).click();
      await expect.poll(() => positionOf(CONSULT), { timeout: T }).toBe(from + 1);
      // Only the swapped pair changed; every other row held its place.
      const after = (await getStudioServiceOrder(seed.studioId)).map((r) => r.name);
      const expected = [...before];
      [expected[from], expected[from + 1]] = [expected[from + 1], expected[from]];
      expect(after).toEqual(expected);
    });

    await test.step("Move up returns it, exactly one position", async () => {
      const from = await positionOf(CONSULT);
      await page.getByTestId(`move-up-${consultId}`).click();
      await expect.poll(() => positionOf(CONSULT), { timeout: T }).toBe(from - 1);
    });

    await test.step("Move to bottom, then back to top, round-trips", async () => {
      await page.getByTestId(`move-bottom-${consultId}`).click();
      await expect
        .poll(async () => (await getStudioServiceOrder(seed.studioId)).at(-1)?.name, { timeout: T })
        .toBe(CONSULT);
      await page.getByTestId(`move-top-${consultId}`).click();
      await expect
        .poll(async () => (await getStudioServiceOrder(seed.studioId))[0]?.name, { timeout: T })
        .toBe(CONSULT);
    });

    await test.step("the boundary controls are disabled at the ends", async () => {
      await expect(page.getByTestId(`move-top-${consultId}`)).toBeDisabled();
      await expect(page.getByTestId(`move-up-${consultId}`)).toBeDisabled();
      await expect(page.getByTestId(`move-down-${consultId}`)).toBeEnabled();
    });

    await test.step("the public booking query resolves to the SAME order", async () => {
      // PARITY AT THE QUERY LEVEL, deliberately. The public booking FORM filters
      // by practitioner eligibility and availability before it renders options,
      // so a UI-list comparison would be asserting the eligibility model, not
      // the ordering contract this PR changes. Instead assert the thing that
      // actually regressed: the ORDER the public page's own query returns must
      // equal the settings order. `getPublicBookingServiceOrder` issues the
      // page's exact select + ORDER BY (sort_order, name, id).
      const settingsOrder = (await getStudioServiceOrder(seed.studioId)).map((r) => r.name);
      const bookingOrder = await getPublicBookingServiceOrder(seed.studioId);
      expect(bookingOrder).toEqual(settingsOrder);
    });
  });

  test("hiding and re-showing never collides with the normalized sequence", async ({ page }) => {
    const seed = await seedE2eStudio();
    const ids = await seedE2eTiedServices(seed.studioId, ["Alpha", "Beta", "Gamma"]);
    await loginAsOwner(page, seed);
    await openServices(page);

    await page.getByTestId(`move-top-${ids["Gamma"]}`).click();
    await expect
      .poll(async () => (await getStudioServiceOrder(seed.studioId))[0]?.name, { timeout: T })
      .toBe("Gamma");

    // Hide Beta, then show it again.
    const betaRow = page.locator(`[data-testid="service-row-${ids["Beta"]}"]`);
    await betaRow.getByRole("button", { name: /hide from booking/i }).click();
    await expect
      .poll(async () => (await getStudioServiceOrder(seed.studioId)).some((r) => r.name === "Beta"), {
        timeout: T,
      })
      .toBe(false);
    await betaRow.getByRole("button", { name: /show in booking/i }).click();
    await expect
      .poll(async () => (await getStudioServiceOrder(seed.studioId)).some((r) => r.name === "Beta"), {
        timeout: T,
      })
      .toBe(true);

    const rows = await getStudioServiceOrder(seed.studioId);
    expect(rows.map((r) => r.sort_order)).toEqual(
      Array.from({ length: rows.length }, (_, i) => (i + 1) * 10),
    );
    expect(new Set(rows.map((r) => r.sort_order)).size).toBe(rows.length);
    expect(rows.at(-1)?.name).toBe("Beta"); // re-slotted at the END, no collision
  });
});

test.describe("iPhone profile", () => {
  // ENGINE NOTE: iPhone dimensions on the Chromium engine (the repo E2E engine),
  // not real iOS Safari/WebKit.
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("move controls are tappable at 390px and the row shows its colour + position", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const ids = await seedE2eTiedServices(seed.studioId, ["Alpha", "Beta", "Gamma"]);
    await loginAsOwner(page, seed);
    await openServices(page);

    const overflow = await page.evaluate(() => ({
      s: document.documentElement.scrollWidth,
      c: document.documentElement.clientWidth,
    }));
    expect(overflow.s, "no horizontal overflow at 390px").toBeLessThanOrEqual(overflow.c);

    // Every move control meets the 36px touch target and sits inside the viewport.
    for (const move of ["top", "up", "down", "bottom"]) {
      const btn = page.getByTestId(`move-${move}-${ids["Beta"]}`);
      await expect(btn).toBeVisible();
      const box = await btn.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height, `${move} touch target`).toBeGreaterThanOrEqual(36);
      expect(box!.width, `${move} touch target`).toBeGreaterThanOrEqual(36);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }

    await test.step("a tap moves the row and persists", async () => {
      await page.getByTestId(`move-top-${ids["Gamma"]}`).tap();
      await expect
        .poll(async () => (await getStudioServiceOrder(seed.studioId))[0]?.name, { timeout: T })
        .toBe("Gamma");
    });

    await test.step("the collapsed row is readable without opening it", async () => {
      const row = page.locator(`[data-testid="service-row-${ids["Gamma"]}"]`);
      const text = await row.innerText();
      expect(text).toContain("Gamma"); // name
      expect(text).toMatch(/\d+ min/); // duration
      expect(text).toMatch(/\$\d/); // price
      expect(text).toMatch(/Visible in booking/i); // status
      expect(text).toMatch(/Position 1 of \d+/); // position, as a NUMBER not a colour
    });

    await test.step("colour is never the only identifier", async () => {
      const row = page.locator(`[data-testid="service-row-${ids["Gamma"]}"]`);
      // A coloured left accent + swatch dot exist…
      await expect(row.locator("article")).toHaveClass(/border-l-/);
      // …and the colour is ALSO spelled out in words next to the name.
      const text = await row.innerText();
      expect(text.toLowerCase()).toMatch(/amber|emerald|teal|sky|indigo|violet|orange|lime|fuchsia|slate/);
    });

    await test.step("cards are visually separated, not flush", async () => {
      const boxes = await page
        .locator('[data-testid^="service-row-"] article')
        .evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
      expect(boxes.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < boxes.length; i += 1) {
        const gap = boxes[i].top - boxes[i - 1].bottom;
        expect(gap, `gap between card ${i - 1} and ${i}`).toBeGreaterThanOrEqual(16);
      }
    });
  });

  test("all ten colour choices are offered, and none of them is red/rose/pink", async ({ page }) => {
    const seed = await seedE2eStudio();
    const ids = await seedE2eTiedServices(seed.studioId, ["Alpha"]);
    await loginAsOwner(page, seed);
    await openServices(page);

    const row = page.locator(`[data-testid="service-row-${ids["Alpha"]}"]`);
    await row.getByRole("button", { name: "Edit" }).click();

    for (const key of [
      "amber",
      "emerald",
      "teal",
      "sky",
      "indigo",
      "violet",
      "orange",
      "lime",
      "fuchsia",
      "slate",
    ]) {
      await expect(row.getByRole("button", { name: `Calendar color: ${key}` })).toBeVisible();
    }
    for (const banned of ["red", "rose", "pink", "blue", "cyan"]) {
      // Not offered anywhere on the page, including the add-new-service card.
      await expect(page.getByRole("button", { name: `Calendar color: ${banned}` })).toHaveCount(0);
    }

    // Picking a NEW 0161 colour saves and round-trips.
    await row.getByRole("button", { name: "Calendar color: fuchsia" }).click();
    await row.getByRole("button", { name: /save changes/i }).click();
    await expect
      .poll(
        async () =>
          (await getStudioServiceOrder(seed.studioId)).find((r) => r.name === "Alpha")
            ?.calendar_color,
        { timeout: T },
      )
      .toBe("fuchsia");
  });
});
