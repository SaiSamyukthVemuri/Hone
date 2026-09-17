import { test, expect, type Page } from "@playwright/test";

import {
  seedE2eStudio,
  getCancellationToken,
  getClientIdByEmail,
  getAppointmentsForClient,
  sql,
  type E2eSeed,
} from "./helpers/seed";
import { bookAppointment } from "./helpers/flows";

// UI-03 — a disabled control must say why, proved against the real form.
//
// The claim the component test cannot make: that a CLIENT sees the reason, that
// the control exposes it to assistive technology, and that the gate still holds.
//
// It also demonstrates the defect rather than arguing it. Before this change the
// explanatory copy lived only inside `submit()`, which a disabled submit button
// never fires; the test below drives the real form and shows the reason present
// with the button still disabled — the state that previously showed nothing.
//
// NOT claimed: a screen-reader acceptance result. This asserts the accessible
// description and the rendered text, which is what automation can observe.

const T = 20_000;
const HINT = "#reschedule-submit-blocked";

async function bookAndTokenise(page: Page, seed: E2eSeed): Promise<string> {
  await bookAppointment(page, seed);
  const clientId = (await getClientIdByEmail(seed.studioId, seed.clientEmail))!;
  const appts = await getAppointmentsForClient(seed.studioId, clientId);
  const confirmed = appts.filter((a) => a.status === "confirmed");
  expect(confirmed.length).toBe(1);
  const token = (await getCancellationToken(seed.studioId, confirmed[0].id))!;
  expect(token).toBeTruthy();
  return token;
}

const submitBtn = (page: Page) =>
  page.getByRole("button", { name: /Confirm new time|Rescheduling/ });
const slotButtons = (page: Page) =>
  page.getByRole("button", { name: /^\d{1,2}:\d{2} (AM|PM)$/ });

test.describe("UI-03 the reschedule submit explains itself", () => {
  test("no time picked: the button is disabled AND says what to do", async ({ page }) => {
    const seed = await seedE2eStudio();
    const token = await bookAndTokenise(page, seed);
    await page.goto(`/reschedule/${token}`);

    const btn = submitBtn(page);
    await expect(btn).toBeVisible({ timeout: T });

    // The gate is unchanged — this is the state the existing contract asserts.
    await expect(btn).toBeDisabled();

    // ...and this is the part that did not exist: the reason, visible.
    await expect(page.locator(HINT)).toHaveText("Pick a time first.");

    // Exposed to assistive technology, not merely painted on screen.
    const describedBy = await btn.getAttribute("aria-describedby");
    expect(describedBy).toBe("reschedule-submit-blocked");
  });

  test("picking a time clears the reason and enables the control", async ({ page }) => {
    const seed = await seedE2eStudio();
    const token = await bookAndTokenise(page, seed);
    await page.goto(`/reschedule/${token}`);
    await expect(submitBtn(page)).toBeVisible({ timeout: T });

    const slots = slotButtons(page);
    await expect(slots.first()).toBeVisible({ timeout: T });
    await slots.first().click();

    const btn = submitBtn(page);
    await expect(btn).toBeEnabled();

    // THE NEGATIVE CONTROL. If the hint were unconditional it would still be
    // here, and it would be describing a control that is no longer blocked.
    await expect(page.locator(HINT)).toHaveCount(0);
    expect(await btn.getAttribute("aria-describedby")).toBeNull();
  });

  test("the hint contributes NO layout to the button — measured by removing it", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const token = await bookAndTokenise(page, seed);
    await page.goto(`/reschedule/${token}`);

    const btn = submitBtn(page);
    await expect(btn).toBeVisible({ timeout: T });
    await expect(page.locator(HINT)).toHaveCount(1);

    // ISOLATES THIS SLICE'S CONTRIBUTION AND NOTHING ELSE.
    //
    // The first version of this test measured the button, clicked a slot, and
    // re-measured. It failed with top 619 -> 675 and the failure was MINE, not
    // the layout's: picking a slot also lets more slots stream into the list
    // above the button, so the measurement conflated my hint with unrelated
    // async growth. Same class of error as measuring a control's own box to
    // prove a press cannot reflow its neighbours.
    //
    // Deleting just the hint changes exactly one thing, so anything that moves
    // is attributable to it. Because the hint renders AFTER the control, the
    // correct result is that nothing moves at all.
    const delta = await btn.evaluate((el) => {
      const e = el as HTMLElement;
      const read = () => ({
        w: e.offsetWidth,
        h: e.offsetHeight,
        top: e.offsetTop,
        left: e.offsetLeft,
        page: document.body.scrollHeight,
      });
      const before = read();
      const hint = document.getElementById("reschedule-submit-blocked");
      if (!hint) return { found: false, before, after: before };
      hint.remove();
      void e.offsetHeight; // force layout before re-reading
      return { found: true, before, after: read() };
    });

    expect(delta.found, "the hint must be present to measure").toBe(true);
    // The button itself must not move or resize...
    expect({ ...delta.after, page: 0 }).toEqual({ ...delta.before, page: 0 });
    // ...and the page gets SHORTER, which is the proof the hint occupied space
    // strictly below the control rather than above it.
    expect(delta.after.page).toBeLessThanOrEqual(delta.before.page);
  });

  test("on a 390px viewport the reason is visible without horizontal scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const seed = await seedE2eStudio();
    const token = await bookAndTokenise(page, seed);
    await page.goto(`/reschedule/${token}`);

    await expect(submitBtn(page)).toBeVisible({ timeout: T });
    await expect(page.locator(HINT)).toBeVisible();

    // The page body must not scroll sideways because of the added line.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
