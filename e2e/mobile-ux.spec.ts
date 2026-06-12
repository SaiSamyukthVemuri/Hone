import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  getClientIdByEmail,
  getAppointmentsForClient,
  type E2eSeed,
} from "./helpers/seed";
import { bookAppointment, loginAsOwner } from "./helpers/flows";

// PR #228: mobile/iPad UX stabilization smoke. Chloe's report: the
// authenticated app horizontally scrolled on her phone (the nav row
// was wider than the viewport) and the calendar created appointment
// drafts from ordinary touch scrolling. This spec pins the fixes:
// no page-wide horizontal overflow on the core practitioner pages at
// iPhone width, a compact mobile menu with every destination plus
// Sign out, and a calendar where touch gestures are inert and only
// the explicit per-day "+ Book" button opens the booking drawer.
//
// Touch simulation note: Playwright's touchscreen supports taps;
// continuous native scroll-flick gestures are approximated here by
// dispatching the same pointer-event sequences (pointerType "touch")
// the real gesture produces against the grid's handler element. The
// remaining native-gesture nuance is covered by the docs/12 manual
// mobile smoke.

test.describe.configure({ mode: "serial" });

// iPhone-12-class emulation, declared explicitly (the devices[]
// descriptors carry defaultBrowserType webkit, which this chromium-
// only lane does not install).
test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 3,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
});

let seed: E2eSeed;
let clientId: string;

async function expectNoPageOverflow(page: Page, label: string) {
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    widths.scrollWidth,
    `${label}: page must not scroll horizontally (scrollWidth ${widths.scrollWidth} vs clientWidth ${widths.clientWidth})`,
  ).toBeLessThanOrEqual(widths.clientWidth);
}

// Synthetic pointer phase dispatch. Each phase runs in its own
// evaluate tick with a pause between, matching real input timing
// (the grid handlers carry drag state across React renders, so a
// single synchronous burst would not exercise them faithfully).
async function syntheticDrag(page: Page, pointerType: "touch" | "mouse") {
  const grid = page
    .getByRole("button", { name: /open quick-book draft/i })
    .first();
  for (const [phase, dy] of [
    ["pointerdown", 60],
    ["pointermove", 220],
    ["pointerup", 220],
  ] as const) {
    await grid.evaluate(
      (el, args) => {
        const rect = el.getBoundingClientRect();
        el.dispatchEvent(
          new PointerEvent(args.phase, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 71,
            pointerType: args.pointerType,
            button: 0,
            isPrimary: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + args.dy,
          }),
        );
      },
      { phase, dy, pointerType },
    );
    await page.waitForTimeout(80);
  }
}

const DRAWER = (page: Page) =>
  page.getByRole("dialog", { name: "New appointment" });
const CHOOSER = (page: Page) =>
  page.getByRole("dialog", { name: "Choose action for selected time" });

test("mobile: shell, core pages, calendar touch safety", async ({
  page,
  browser,
}) => {
  await test.step("seed + book one appointment at phone width", async () => {
    seed = await seedE2eStudio();
    await bookAppointment(page, seed);
    clientId = (await getClientIdByEmail(seed.studioId, seed.clientEmail))!;
    expect(clientId).toBeTruthy();
  });

  await test.step("login at phone width", async () => {
    await loginAsOwner(page, seed);
  });

  await test.step("dashboard: no horizontal overflow", async () => {
    await page.goto("/dashboard");
    await expect(page.getByText("Charted within 24h").first()).toBeVisible();
    await expectNoPageOverflow(page, "dashboard");
  });

  await test.step("header bell opens Notifications (with badge slot)", async () => {
    const bell = page.getByRole("link", { name: /^Notifications/ });
    await expect(bell).toBeVisible();
    await bell.click();
    await page.waitForURL(/notifications/);
  });

  await test.step("notifications: fits the viewport", async () => {
    await expectNoPageOverflow(page, "notifications");
  });

  await test.step("mobile menu: outside tap dismisses without navigating", async () => {
    await page.goto("/dashboard");
    const menuButton = page.getByRole("button", {
      name: "Open navigation menu",
    });
    const nav = page.getByRole("navigation", { name: "Mobile navigation" });

    // A non-interactive text node well below the right-aligned
    // panel: a safe "outside" tap target that cannot navigate.
    // (The wordmark is no longer safe for this: PR #230 made it a
    // Dashboard link.)
    const outside = page.getByText("Charted within 24h").first();

    await menuButton.click();
    await expect(nav).toBeVisible();
    await outside.tap();
    await expect(nav).toHaveCount(0);
    await expect(page).toHaveURL(/dashboard/);

    // Reliably repeatable: open again, dismiss again, reopen works.
    await menuButton.click();
    await expect(nav).toBeVisible();
    await outside.tap();
    await expect(nav).toHaveCount(0);
    await menuButton.click();
    await expect(nav).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(nav).toHaveCount(0);
  });

  await test.step("mobile menu: contents + auto-close on link tap", async () => {
    await page.goto("/dashboard");
    const menuButton = page.getByRole("button", {
      name: "Open navigation menu",
    });
    const nav = page.getByRole("navigation", { name: "Mobile navigation" });

    await menuButton.click();
    await expect(menuButton).toHaveAttribute("aria-expanded", "true");
    for (const label of [
      "Dashboard",
      "Clients",
      "Calendar",
      "Records",
      "Settings",
    ]) {
      await expect(nav.getByRole("link", { name: label })).toBeVisible();
    }
    await expect(nav.getByRole("button", { name: "Sign out" })).toBeVisible();
    // Notifications lives on the bell now, not in the menu.
    await expect(nav.getByRole("link", { name: "Notifications" })).toHaveCount(
      0,
    );

    // Tap Records: the menu must close itself and navigate.
    await nav.getByRole("link", { name: "Records" }).click();
    await page.waitForURL(/records/);
    await expect(nav).toHaveCount(0);

    // Again with Calendar.
    await menuButton.click();
    await nav.getByRole("link", { name: "Calendar" }).click();
    await page.waitForURL(/calendar/);
    await expect(nav).toHaveCount(0);

    // Tapping the CURRENT page's link must also close the menu.
    await menuButton.click();
    await nav.getByRole("link", { name: "Calendar" }).click();
    await expect(nav).toHaveCount(0);
    await expect(page).toHaveURL(/calendar/);
  });

  await test.step("records: fits the viewport", async () => {
    await page.goto("/records");
    await expect(
      page.getByRole("heading", { name: "Record Keeping" }),
    ).toBeVisible();
    await expectNoPageOverflow(page, "records");
    await page.goto("/records?section=procedures");
    await expectNoPageOverflow(page, "records procedures");
  });

  await test.step("clients + client detail: fit the viewport", async () => {
    await page.goto("/clients");
    await expectNoPageOverflow(page, "clients");
    await page.goto(`/clients/${clientId}`);
    await expect(page.getByText(seed.clientName).first()).toBeVisible();
    await expectNoPageOverflow(page, "client detail");
  });

  await test.step("wordmark navigates home from anywhere", async () => {
    const home = page.getByRole("link", { name: "Go to Dashboard" });
    await page.goto("/calendar");
    await expect(home).toBeVisible();
    await home.tap();
    await page.waitForURL(/dashboard/);
    await page.goto("/records");
    await home.tap();
    await page.waitForURL(/dashboard/);
    await expectNoPageOverflow(page, "dashboard via wordmark");
  });

  await test.step("calendar: loads without page-wide overflow", async () => {
    await page.goto("/calendar");
    await expect(
      page.getByRole("button", { name: /open quick-book draft/i }).first(),
    ).toBeAttached();
    await expectNoPageOverflow(page, "calendar");
  });

  await test.step("calendar: touch tap on empty grid does nothing", async () => {
    const before = (await getAppointmentsForClient(seed.studioId, clientId))
      .length;
    const grid = page
      .getByRole("button", { name: /open quick-book draft/i })
      .first();
    const box = (await grid.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + 80);
    await page.waitForTimeout(600);
    await expect(DRAWER(page)).toHaveCount(0);
    await expect(CHOOSER(page)).toHaveCount(0);
    const after = (await getAppointmentsForClient(seed.studioId, clientId))
      .length;
    expect(after).toBe(before);
  });

  await test.step("calendar: touch drag does not open create flow", async () => {
    await syntheticDrag(page, "touch");
    await page.waitForTimeout(600);
    await expect(DRAWER(page)).toHaveCount(0);
    await expect(CHOOSER(page)).toHaveCount(0);
  });

  await test.step("calendar: explicit + Book button is the deliberate create path", async () => {
    await page
      .getByRole("button", { name: /^Book on /i })
      .first()
      .click();
    await expect(DRAWER(page)).toBeVisible({ timeout: 10_000 });
    await DRAWER(page).getByRole("button", { name: "Close", exact: true }).click();
    await expect(DRAWER(page)).toHaveCount(0);
  });

  await test.step("iPad: calendar fits and touch drag stays inert", async () => {
    const ipad = await browser.newContext({
      viewport: { width: 810, height: 1080 },
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const ipadPage = await ipad.newPage();
    await loginAsOwner(ipadPage, seed);
    await ipadPage.goto("/calendar");
    await expect(
      ipadPage.getByRole("button", { name: /open quick-book draft/i }).first(),
    ).toBeAttached();
    await expectNoPageOverflow(ipadPage, "iPad calendar");
    await syntheticDrag(ipadPage, "touch");
    await ipadPage.waitForTimeout(600);
    await expect(DRAWER(ipadPage)).toHaveCount(0);
    await expect(CHOOSER(ipadPage)).toHaveCount(0);
    await ipad.close();
  });

  await test.step("desktop: mouse drag-create still works", async () => {
    const desktop = await browser.newContext(); // default desktop viewport, no touch
    const desktopPage = await desktop.newPage();
    await loginAsOwner(desktopPage, seed);
    await desktopPage.goto("/calendar");
    await syntheticDrag(desktopPage, "mouse");
    await expect(CHOOSER(desktopPage)).toBeVisible({ timeout: 10_000 });
    await desktop.close();
  });
});
