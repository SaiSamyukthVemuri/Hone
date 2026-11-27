import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, getClientIdByEmail, getAppointmentsForClient, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// HON-124 PR 1 · mobile navigation + public booking feedback, at iPhone width,
// by touch AND keyboard. Every assertion is on the property itself: where focus
// IS after a key, how many appointment rows EXIST after a double press, whether
// a focused control's box is BELOW the sticky header.

test.describe.configure({ mode: "serial" });

// Same explicit iPhone-class emulation as mobile-ux.spec.ts (chromium lane).
test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 3,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
});

let seed: E2eSeed;
test.beforeAll(async () => {
  seed = await seedE2eStudio();
});

const SHOTS = process.env.HON124_SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** True when document.activeElement is inside #main-content. */
const focusInMain = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest("#main-content") != null);

async function expectSkipLinkReachesMain(page: Page) {
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main-content$/);
  // The NEXT tab stop is inside main: the header was bypassed.
  await page.keyboard.press("Tab");
  expect(await focusInMain(page), "Tab after the skip link left focus outside <main>").toBe(true);
}

/**
 * Item 5. From the LAST control in <main>, Shift+Tab upward (the direction
 * that scrolls a control to the top edge) and require every focused control's
 * box to start below the sticky header.
 */
async function expectUpwardFocusClearsHeader(page: Page, minChecked = 10) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    // Start from the LAST focusable in main and Shift+Tab upward: upward focus
    // is the direction that scrolls a control to the top edge.
    await page.locator("#main-content").evaluate((main) => {
      const all = [...main.querySelectorAll<HTMLElement>("input, select, textarea, button, a[href]")].filter(
        (el) => el.getClientRects().length > 0 && !(el as HTMLInputElement).disabled && (el as HTMLInputElement).type !== "hidden",
      );
      all[all.length - 1]?.focus();
      if (document.activeElement !== all[all.length - 1]) throw new Error("could not focus the last control in <main>");
    });
    const headerBottom = await page.locator("header").first().evaluate((h) => h.getBoundingClientRect().bottom);
    const offenders: string[] = [];
    let checked = 0;
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Shift+Tab");
      const r = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || !el.closest("#main-content")) return null;
        const b = el.getBoundingClientRect();
        return { top: b.top, label: el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 40) || el.tagName };
      });
      if (!r) break;
      checked++;
      if (r.top < headerBottom - 1) offenders.push(`${r.label} @ ${Math.round(r.top)}`);
    }
    expect(checked, "the upward walk never focused a control in <main> (vacuous)").toBeGreaterThanOrEqual(minChecked);
    expect(offenders, `focused controls under the ${headerBottom}px header`).toEqual([]);
}

test("marketing shell: skip link and phone menu (keyboard + touch)", async ({ page }) => {
  await test.step("item 17: skip to content lands in <main>", async () => {
    await page.goto("/pricing");
    await expectSkipLinkReachesMain(page);
  });

  await test.step("item 10: keyboard open, current page, Escape returns focus", async () => {
    await page.goto("/pricing");
    const trigger = page.getByRole("button", { name: "Menu", exact: true });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Site navigation" });
    await expect(dialog).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    // Focus moved INTO the dialog (its Close control).
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
    const current = dialog.locator('[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText("Pricing");
    await shot(page, "marketing-menu-open-current");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  await test.step("item 5: focusing upward on a long form never hides a field under the header", async () => {
    await page.goto("/demo");
    await expectUpwardFocusClearsHeader(page, 5);
  });

  await test.step("item 10: touch open and Close returns focus", async () => {
    const trigger = page.getByRole("button", { name: "Menu", exact: true });
    await trigger.tap();
    const dialog = page.getByRole("dialog", { name: "Site navigation" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).tap();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});

test("app shell: skip link, phone menu and sticky header", async ({ page }) => {
  await loginAsOwner(page, seed);

  await test.step("item 17: skip to content bypasses the app header", async () => {
    await page.goto("/clients");
    await expectSkipLinkReachesMain(page);
    await shot(page, "app-skip-link-target");
  });

  const trigger = page.getByRole("button", { name: "Open navigation menu" });
  const nav = page.getByRole("navigation", { name: "Mobile navigation" });

  await test.step("item 10: touch open shows the current destination", async () => {
    await page.goto("/clients");
    await trigger.tap();
    await expect(nav).toBeVisible();
    const current = nav.locator('[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText("Clients");
    await shot(page, "app-menu-open-current");
  });

  await test.step("item 10: Escape from inside the panel returns focus to the trigger", async () => {
    // Keyboard into the panel: the panel follows the trigger in the DOM, so
    // the next Tab stop after the trigger is the panel's first destination.
    await trigger.focus();
    await page.keyboard.press("Tab");
    await expect(nav.getByRole("link", { name: "Dashboard" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(nav).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  await test.step("item 10: keyboard Enter opens, Enter on trigger closes", async () => {
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(nav).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(nav).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  await test.step("item 10: a nested destination marks only itself", async () => {
    await page.goto("/settings/booking");
    await trigger.tap();
    const current = nav.locator('[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText("Settings");
    await page.keyboard.press("Escape");
  });

  await test.step("item 5: an anchor target lands below the sticky header", async () => {
    await page.goto("/settings/booking#buffer");
    const headerBottom = await page.locator("header").first().evaluate((h) => h.getBoundingClientRect().bottom);
    const target = page.locator("#buffer");
    await expect(target).toBeInViewport();
    const top = await target.evaluate((el) => el.getBoundingClientRect().top);
    expect(top, `#buffer top ${top} is under the header (bottom ${headerBottom})`).toBeGreaterThanOrEqual(headerBottom - 1);
  });

  await test.step("item 5: focusing upward never hides a control under the header", async () => {
    await page.goto("/settings/booking");
    await expectUpwardFocusClearsHeader(page);
  });
  await test.step("item 5: the calendar's pinned day controls sit below the header, not under it", async () => {
    await page.goto("/calendar");
    const strip = page.getByTestId("calendar-mobile-day-header");
    await expect(strip).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 600));
    await expect(async () => {
      const [headerBottom, stripTop] = await Promise.all([
        page.locator("header").first().evaluate((h) => h.getBoundingClientRect().bottom),
        strip.evaluate((el) => el.getBoundingClientRect().top),
      ]);
      expect(stripTop, `day strip top ${stripTop} vs header bottom ${headerBottom}`).toBeGreaterThanOrEqual(headerBottom - 1);
    }).toPass({ timeout: 5_000 });
    await shot(page, "calendar-sticky-day-strip-scrolled");
  });
});

async function startNewClientBooking(page: Page) {
  await page.goto(`/book/${seed.slug}`);
  await expect(page.getByTestId("booking-progress")).toHaveText(/step 1 of 3/i);
  await shot(page, "booking-step-1");
  await page.getByRole("button", { name: /new client/i }).click();
  await expect(page.getByTestId("booking-progress")).toHaveText(/step 2 of 3/i);
  const slotButton = page.getByRole("button", { name: /^\d{1,2}:\d{2} (AM|PM)$/ });
  const nextDay = page.getByRole("button", { name: /^next available( day)?$/i });
  await expect(async () => {
    expect((await slotButton.count()) + (await nextDay.count())).toBeGreaterThan(0);
  }).toPass({ timeout: 20_000 });
  if ((await slotButton.count()) === 0) {
    await nextDay.click();
    await expect(slotButton.first()).toBeVisible({ timeout: 20_000 });
  }
  return slotButton;
}

test("public booking: progress, one row from a double press, honest success", async ({ page }) => {
  const slotButton = await startNewClientBooking(page);
  await slotButton.first().click();
  await page.getByLabel(/your name/i).fill(seed.clientName);
  await page.getByLabel(/^email/i).fill(seed.clientEmail);
  await page.getByLabel(/phone/i).fill("+1 555 555 0123");
  await shot(page, "booking-step-2-filled");

  // Item 4: two presses in ONE task, before React can re-render the button as
  // disabled. A plain dblclick() would not discriminate.
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) requests.push(r.url());
  });
  await page.getByRole("button", { name: /book appointment/i }).evaluate((btn: HTMLButtonElement) => {
    btn.click();
    btn.click();
  });

  // Item 20: the confirmation appears only once the action answered ok.
  await expect(page.getByRole("heading", { name: /your appointment is booked/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("booking-progress")).toHaveText(/step 3 of 3/i);
  await shot(page, "booking-step-3-confirmed");

  const clientId = await getClientIdByEmail(seed.studioId, seed.clientEmail);
  expect(clientId).not.toBeNull();
  const rows = await getAppointmentsForClient(seed.studioId, clientId!);
  expect(rows, "a double press must leave exactly one appointment row").toHaveLength(1);
  // And only one booking action was even sent.
  expect(requests.length, `booking actions posted: ${requests.length}`).toBe(1);
});

test("public booking: a taken time keeps every entry and says what to do", async ({ browser }) => {
  // Two visitors pick the SAME time; the first books it, the second's submit is refused.
  const ctx = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
  const a = await (await browser.newContext(ctx)).newPage();
  const b = await (await browser.newContext(ctx)).newPage();
  await startNewClientBooking(a);
  const slotsB = await startNewClientBooking(b);
  // Pick the same slot label on both.
  const label = (await slotsB.last().textContent())!.trim();
  await slotsB.last().click();
  const nameB = `Second Visitor ${Date.now()}`;
  const emailB = `second-${Date.now()}@harness.local`;
  await b.getByLabel(/your name/i).fill(nameB);
  await b.getByLabel(/^email/i).fill(emailB);
  await b.getByLabel(/phone/i).fill("+1 555 555 0199");

  await a.getByRole("button", { name: label, exact: true }).click();
  await a.getByLabel(/your name/i).fill(`First Visitor ${Date.now()}`);
  await a.getByLabel(/^email/i).fill(`first-${Date.now()}@harness.local`);
  await a.getByLabel(/phone/i).fill("+1 555 555 0188");
  await a.getByRole("button", { name: /book appointment/i }).click();
  await expect(a.getByRole("heading", { name: /your appointment is booked/i })).toBeVisible({ timeout: 20_000 });

  await b.getByRole("button", { name: /book appointment/i }).click();
  // Item 19: the message says what happened and what to do next, in a live region.
  await expect(b.getByRole("alert").filter({ hasText: /no longer available/i })).toHaveText(
    /that time is no longer available\. please choose another time\./i,
  );
  // Item 20: never optimistic.
  await expect(b.getByRole("heading", { name: /your appointment is booked/i })).toHaveCount(0);
  await expect(b.getByTestId("booking-progress")).toHaveText(/step 2 of 3/i);
  // Every entry is kept.
  await expect(b.getByLabel(/your name/i)).toHaveValue(nameB);
  await expect(b.getByLabel(/^email/i)).toHaveValue(emailB);
  await expect(b.getByLabel(/phone/i)).toHaveValue("+1 555 555 0199");
  // The taken time is no longer offered as the choice, so "choose another" is possible.
  await expect(b.getByRole("button", { name: label, exact: true })).toHaveCount(0, { timeout: 20_000 });
  if (SHOTS) await b.screenshot({ path: `${SHOTS}/booking-slot-taken-error.png` });

  const idB = await getClientIdByEmail(seed.studioId, emailB);
  if (idB) expect(await getAppointmentsForClient(seed.studioId, idB)).toHaveLength(0);
});
