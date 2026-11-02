import { test, expect, type Page } from "@playwright/test";
import {
  seedConfirmedAppointment,
  seedE2eDashboardMemoryClient,
  seedE2eIntake,
  seedE2eMember,
  seedE2eSecondAppointmentToday,
  seedE2eStudio,
  sql,
} from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";

// ===========================================================================
// #1308 phone fixes, proved in a browser (Sam, 2 Nov): an unbroken 95-character client name must not
// widen the Dashboard at 320 or 390, and tapping the appointment name on a touch phone must reach the
// appointment page every time. Not run locally (no stack here); Photos / CI own the run.
// ===========================================================================
// A page-level scrollWidth check cannot see overflow inside an overflow-hidden ancestor (the roster
// clips its cards), so this ALSO asserts every link and card's right edge against its own container
// and against the viewport.

const T = 15_000;
const LONG_NAME = "Abcdefghij".repeat(9) + "Klmno"; // 95 characters, no break opportunity

async function seedStudioWithLongName() {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eDashboardMemoryClient(seed, { cautionNote: null });
  await sql(`update public.clients set name = $1 where id = $2`, [LONG_NAME, clientId]);
  // An intake awaiting review puts this client in Needs attention.
  await seedE2eIntake(seed.studioId, clientId, "submitted");
  const second = await seedE2eSecondAppointmentToday(seed, clientId, 4);
  const third = await seedE2eSecondAppointmentToday(seed, clientId, 6);
  return { seed, clientId, extra: [second.appointmentId, third.appointmentId] };
}

async function assertNoSidewaysOverflow(page: Page, width: number) {
  const report = await page.evaluate((vw) => {
    const doc = document.documentElement;
    const offenders: string[] = [];
    const scope = document.querySelector("main") ?? document.body;
    const nodes = scope.querySelectorAll<HTMLElement>(
      'a, li, [data-testid^="today-row"], [data-attention-client], details, summary',
    );
    nodes.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return; // not rendered (closed details content)
      // Something meant to scroll sideways on its own is allowed to extend past its box.
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === "auto" || ox === "scroll") return;
      }
      const parent = el.parentElement?.getBoundingClientRect();
      const label = `${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? el.getAttribute("href") ?? ""}]`;
      if (r.right > vw + 1) offenders.push(`${label} right ${Math.round(r.right)} > viewport ${vw}`);
      else if (parent && parent.width > 0 && r.right > parent.right + 1) {
        offenders.push(`${label} right ${Math.round(r.right)} > container ${Math.round(parent.right)}`);
      }
    });
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, offenders };
  }, width);
  expect(report.scrollWidth, `document scrollWidth ${report.scrollWidth}`).toBeLessThanOrEqual(width);
  expect(report.offenders, report.offenders.join("\n")).toEqual([]);
}

for (const width of [320, 390]) {
  test.describe(`dashboard at ${width}px with a 95-character unbroken client name`, () => {
    test.use({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });

    test(`owner: no sideways scroll, Needs attention and the Today rows stay inside the page`, async ({ page }) => {
      const { seed } = await seedStudioWithLongName();
      await loginByMagicLink(page, seed.ownerEmail);
      await page.goto("/dashboard");
      await expect(page.getByTestId("today-row-client-name").first()).toBeVisible({ timeout: T });
      await expect(page.locator("[data-attention-client]").first()).toBeVisible({ timeout: T });
      await assertNoSidewaysOverflow(page, width);
    });

    test(`practitioner: no sideways scroll with the same name on their own appointments`, async ({ page }) => {
      const { seed, clientId } = await seedStudioWithLongName();
      const member = await seedE2eMember(seed);
      // The owner's visits sit at about +2h, +4h and +6h; their start times were taken a moment before this
      // one, so an adjacent slot can overlap by the drift. +8h leaves a clear hour.
      const starts = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
      const ends = new Date(Date.now() + 9 * 3600 * 1000).toISOString();
      await seedConfirmedAppointment(seed.studioId, member.practitionerId, clientId, starts, ends);
      await loginByMagicLink(page, member.email);
      await page.goto("/dashboard");
      await expect(page.getByTestId("today-row-client-name").first()).toBeVisible({ timeout: T });
      await assertNoSidewaysOverflow(page, width);
    });
  });
}

test.describe("tapping the appointment name on a 390px touch phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("reaches /calendar/<id> on every one of 5 taps across the rows", async ({ page }) => {
    const { seed } = await seedStudioWithLongName();
    await loginByMagicLink(page, seed.ownerEmail, { openRowDetails: false });
    await page.goto("/dashboard");
    const names = page.getByTestId("today-row-client-name");
    await expect(names.first()).toBeVisible({ timeout: T });
    const rows = await names.count();
    expect(rows).toBeGreaterThanOrEqual(3);
    for (let tap = 0; tap < 5; tap += 1) {
      const index = tap % rows;
      const name = page.getByTestId("today-row-client-name").nth(index);
      const href = await page
        .getByTestId("today-row-body")
        .nth(index)
        .evaluate((el) => (el as HTMLAnchorElement).getAttribute("href"));
      expect(href, `tap ${tap}`).toMatch(/^\/calendar\/[0-9a-f-]{36}$/);
      await name.scrollIntoViewIfNeeded();
      const box = await name.boundingBox();
      if (!box) throw new Error(`tap ${tap}: the name has no box`);
      await page.touchscreen.tap(box.x + Math.min(box.width / 2, 60), box.y + box.height / 2);
      await page.waitForURL(`**${href}`, { timeout: T });
      expect(new URL(page.url()).pathname, `tap ${tap}`).toBe(href);
      await page.goto("/dashboard");
      await expect(page.getByTestId("today-row-client-name").first()).toBeVisible({ timeout: T });
    }
  });
});
