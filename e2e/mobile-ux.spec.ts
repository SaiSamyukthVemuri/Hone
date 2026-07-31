import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  getClientIdByEmail,
  getAppointmentsForClient,
  getCancellationToken,
  getIntakeTokenForClient,
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
let sessionPath: string;

// PR #234: a sheet/panel must sit fully inside the viewport.
async function expectInsideViewport(
  page: Page,
  locator: ReturnType<Page["locator"]>,
  label: string,
) {
  const box = (await locator.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x, `${label}: left edge on-screen`).toBeGreaterThanOrEqual(0);
  expect(
    box.x + box.width,
    `${label}: right edge on-screen`,
  ).toBeLessThanOrEqual(viewport.width + 0.5);
}

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
const BLOCK_DRAWER = (page: Page) =>
  page.getByRole("dialog", { name: "Block time" });

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

  await test.step("public client surfaces fit a phone (PR #234 sanity pass)", async () => {
    // Booking + its confirmation already ran in THIS viewport in the
    // step above; assert the confirmation state explicitly.
    await expectNoPageOverflow(page, "booking confirmation");

    const appointments = await getAppointmentsForClient(seed.studioId, clientId);
    const token = await getCancellationToken(seed.studioId, appointments[0].id);
    expect(token).toBeTruthy();

    const publicPages: Array<[string, string]> = [
      [`/book/${seed.slug}`, "public booking"],
      [`/manage/${token}`, "manage appointment"],
      [`/cancel/${token}`, "cancel appointment"],
      [`/reschedule/${token}`, "reschedule appointment"],
      ["/cancel/not-a-real-token", "invalid token state"],
    ];
    const intakeToken = await getIntakeTokenForClient(
      seed.studioId,
      seed.clientEmail,
    );
    if (intakeToken) {
      publicPages.push([`/intake/${intakeToken}`, "intake form"]);
      publicPages.push(["/intake/thank-you", "intake thank-you"]);
    }
    for (const [path, label] of publicPages) {
      await page.goto(path);
      await expectNoPageOverflow(page, label);
      // The authenticated shell must never leak onto public pages.
      await expect(
        page.getByRole("button", { name: "Open navigation menu" }),
        `${label}: no app menu`,
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Search Hone" }),
        `${label}: no app search`,
      ).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: /^Notifications/ }),
        `${label}: no app bell`,
      ).toHaveCount(0);
    }
  });

  await test.step("login at phone width", async () => {
    await loginAsOwner(page, seed);
  });

  await test.step("dashboard: no horizontal overflow + Today next action", async () => {
    await page.goto("/dashboard");
    await expect(page.getByText("Charted within 24h").first()).toBeVisible();
    await expectNoPageOverflow(page, "dashboard");
    // PR #238: worklist first. The Today section renders ABOVE the
    // Practice Snapshot (its Charted-within-24h card is the marker).
    const todayBox = await page
      .getByRole("heading", { name: "Today", exact: true })
      .boundingBox();
    const snapshotBox = await page
      .getByText("Charted within 24h")
      .first()
      .boundingBox();
    expect(todayBox && snapshotBox && todayBox.y < snapshotBox.y).toBe(true);
    // The Daily Prep Brief list is RETIRED: it re-rendered every appointment a
    // second time. Its preparation facts now live once, inside the Today card,
    // which must still fit the phone and state the no-history case calmly.
    await expect(
      page.getByRole("heading", { name: "Daily prep brief" }),
    ).toHaveCount(0);
    const todaySection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Today", exact: true }) });
    await expect(
      todaySection.getByText(/New client · No charted history yet/).first(),
    ).toBeVisible();
    // ONE relationship phrasing, not two.
    await expect(page.getByText(/No prior treatment history yet/)).toHaveCount(0);
    await expectNoPageOverflow(page, "dashboard with combined Today workflow");
    // PR #236: the booked appointment shows ONE obvious action. The
    // client is brand new (no history yet), so it reads Open client.
    const action = page.getByRole("link", { name: "Open client" }).first();
    await expect(action).toBeVisible();
    await expectInsideViewport(page, action, "today next action");
    await action.click();
    await page.waitForURL(new RegExp(`/clients/${clientId}`));
  });

  await test.step("header bell opens Notifications (with badge slot)", async () => {
    const bell = page.getByRole("link", { name: /^Notifications/ });
    await expect(bell).toBeVisible();
    await bell.click();
    await page.waitForURL(/notifications/);
  });

  await test.step("mobile global search finds the client and navigates", async () => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Search Hone" }).click();
    const searchInput = page.getByRole("searchbox", { name: "Search Hone" });
    await expect(searchInput).toBeVisible();

    // PR #234: the sheet, its input, and Close are fully on-screen.
    await expectInsideViewport(page, searchInput, "search input");
    // PR #238: 16px input so iOS Safari does not auto-zoom the page
    // when the field gains focus (Chloe's retest: the site zoomed in
    // on tap and stayed zoomed).
    expect(
      await searchInput.evaluate((el) => getComputedStyle(el).fontSize),
    ).toBe("16px");
    const closeButton = page.getByRole("button", { name: "Close" });
    await expect(closeButton).toBeVisible();
    await expectInsideViewport(page, closeButton, "search close");
    await expectNoPageOverflow(page, "mobile search sheet");

    // Close button and Escape both dismiss; reopen for the search.
    await closeButton.click();
    await expect(searchInput).toHaveCount(0);
    await page.getByRole("button", { name: "Search Hone" }).click();
    await page.keyboard.press("Escape");
    await expect(searchInput).toHaveCount(0);
    await page.getByRole("button", { name: "Search Hone" }).click();

    await searchInput.fill(seed.clientName);
    // The client result is the one whose subtitle is the email
    // (appointment results share the client NAME as their title).
    const clientResult = page.getByRole("link", {
      name: new RegExp(seed.clientEmail),
    });
    await expect(clientResult.first()).toBeVisible({ timeout: 15_000 });
    await expectNoPageOverflow(page, "mobile search open");
    await clientResult.first().click();
    await page.waitForURL(new RegExp(`/clients/${clientId}`));
    // Panel closed itself on result tap.
    await expect(searchInput).toHaveCount(0);
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
    // PR #234: the menu sheet is fully inside the viewport.
    await expectInsideViewport(page, nav, "menu sheet");
    // PR #231: profile/studio block at the top of the panel.
    await expect(nav.getByText(seed.studioName)).toBeVisible();
    await expect(nav.getByText(/· Owner/)).toBeVisible();
    for (const label of [
      "Dashboard",
      "Clients",
      "Calendar",
      "Records",
      "Settings",
      "Getting Started",
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

  await test.step("clients + client detail: fit the viewport with usable actions", async () => {
    await page.goto("/clients");
    await expectNoPageOverflow(page, "clients");
    await page.goto(`/clients/${clientId}`);
    await expect(page.getByText(seed.clientName).first()).toBeVisible();
    await expectNoPageOverflow(page, "client detail");

    // PR #233: header actions are all reachable on a phone.
    await expect(page.getByRole("link", { name: "Edit" }).first()).toBeVisible();
    await expect(
      page.getByRole("link", { name: "+ Log session" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "+ Book appointment" }),
    ).toBeVisible();

    // PR #238: on phones the sections are a stable native select
    // (the draggable tab row felt unstable in Chloe's retest). All
    // sections are options; picking one navigates; the select
    // always shows the active section. Willow PR A added the
    // "Consultation" section (dedicated consultation + skin/hair notes).
    const sectionSelect = page
      .getByRole("navigation", { name: "Client profile sections" })
      .locator("select");
    await expect(sectionSelect).toBeVisible();
    const optionLabels = await sectionSelect
      .locator("option")
      .allTextContents();
    expect(optionLabels).toEqual([
      "Overview",
      "Sessions",
      "Treatment Plans",
      "Messages",
      "Health & Forms",
      "Consultation",
      "Personal Notes",
    ]);
    // 16px-safe: the focused select must not trigger iOS page zoom.
    expect(
      await sectionSelect.evaluate((el) => getComputedStyle(el).fontSize),
    ).toBe("16px");
    await sectionSelect.selectOption("sessions");
    await page.waitForURL(/tab=sessions/);
    await expect(sectionSelect).toHaveValue("sessions");
    await expectNoPageOverflow(page, "client detail sessions tab");
    await sectionSelect.selectOption("personal");
    await page.waitForURL(/tab=personal/);
    await expect(sectionSelect).toHaveValue("personal");
    await expectNoPageOverflow(page, "client detail personal tab");
    await page.goto(`/clients/${clientId}`);

    // Pinned notes card (first thing on Overview) fits the viewport.
    await expect(page.getByText(/Pinned notes/i).first()).toBeVisible();
    await expectNoPageOverflow(page, "client detail pinned notes");
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

  await test.step("mobile charting: comfortable and complete at 390px (PR #235)", async () => {
    // Enter charting from the client page action.
    await page.goto(`/clients/${clientId}`);
    await page.getByRole("link", { name: "+ Log session" }).click();
    await page.getByRole("button", { name: /electrolysis/i }).click();
    // Wait for the CREATED session URL (a UUID), not /sessions/new.
    await page.waitForURL(/\/sessions\/[0-9a-f-]{36}/, { timeout: 20_000 });
    sessionPath = new URL(page.url()).pathname;
    await expectNoPageOverflow(page, "charting page");

    // Charting polish: the settings form no longer auto-opens — open the
    // compact CTA before reaching for the in-form controls.
    await page.getByTestId("add-settings-block-cta").click({ timeout: 20_000 });

    // Every charting control the workflow needs is reachable.
    const controls: Array<[ReturnType<typeof page.locator>, string]> = [
      [page.getByRole("button", { name: "Chin", exact: true }), "treatment area"],
      [page.getByRole("button", { name: "13.56 MHz" }), "machine frequency"],
      [page.getByPlaceholder("e.g. 460941"), "probe lot"],
      [page.getByRole("spinbutton", { name: /minutes performed/i }), "minutes"],
      [page.getByRole("button", { name: "Mild discomfort" }), "tolerance"],
      [page.getByRole("button", { name: "+ Mild redness" }), "reaction chip"],
      [
        page.getByPlaceholder(/start lower and check sensitivity/i),
        "next-visit note",
      ],
      [
        page.getByRole("button", { name: /procedure risks explained/i }),
        "aftercare mark",
      ],
      [page.getByRole("button", { name: /save settings block/i }), "save"],
    ];
    for (const [locator, label] of controls) {
      await locator.scrollIntoViewIfNeeded();
      await expect(locator, `${label} reachable at 390px`).toBeVisible();
      await expectInsideViewport(page, locator, label);
    }

    // Chart for real: area, settings, lot, minutes, response, save.
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await page.getByRole("button", { name: "13.56 MHz" }).click();
    await page.getByPlaceholder("e.g. 460941").fill(`E2E-M-${seed.runId}`);
    await page
      .getByRole("spinbutton", { name: /minutes performed/i })
      .fill("10");
    await page.getByRole("button", { name: "Mild discomfort" }).click();
    await page.getByRole("button", { name: "+ Mild redness" }).click();
    await page.getByRole("button", { name: /save settings block/i }).click();
    await expect(page.getByText(`E2E-M-${seed.runId}`).first()).toBeVisible({
      timeout: 20_000,
    });

    // Next-visit note + aftercare mark, right on the charting page.
    await page
      .getByPlaceholder(/start lower and check sensitivity/i)
      .fill("E2E mobile caution: check chin sensitivity");
    await page.getByRole("button", { name: /save note/i }).click();
    await expect(
      page.getByText("E2E mobile caution: check chin sensitivity").first(),
    ).toBeVisible({ timeout: 20_000 });
    await page
      .getByRole("button", { name: /procedure risks explained/i })
      .click();
    await expect(
      page.getByText(/✓ Risks explained and aftercare provided/).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expectNoPageOverflow(page, "charting page after save");

    // PR #238: the Finish up section answers "how do I save and
    // complete?": it says everything already saved per piece and the
    // Done charting link is reachable and exits to the client's
    // Sessions tab. (This walk-in session has no linked appointment,
    // so the appointment/billing link correctly does not render.)
    const finishHeading = page.getByRole("heading", { name: "Finish up" });
    await finishHeading.scrollIntoViewIfNeeded();
    await expect(finishHeading).toBeVisible();
    await expect(
      page.getByText(/Everything above is already saved as you go/),
    ).toBeVisible();
    const doneCharting = page.getByRole("button", { name: "Done charting" });
    await expect(doneCharting).toBeVisible();
    await expectInsideViewport(page, doneCharting, "done charting button");
    await expect(
      page.getByRole("link", { name: /Review appointment & billing/ }),
    ).toHaveCount(0);
    await doneCharting.tap();
    await page.waitForURL(/tab=sessions/);
    await expectNoPageOverflow(page, "client sessions after done charting");

    // The memory loop holds: Before Today surfaces the note, with
    // the PR #237 hierarchy (Remember today band first) fitting the
    // phone viewport.
    await page.goto(`/clients/${clientId}`);
    await expect(
      page.getByText("E2E mobile caution: check chin sensitivity").first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Remember today").first()).toBeVisible();
    await expect(
      page.getByText("Client response (last recorded)").first(),
    ).toBeVisible();
    await expectNoPageOverflow(page, "client page Before Today");

    // PR #236: this charting entered from the CLIENT page (no
    // appointment context), so the session is unlinked and the Today
    // row's action flips from "Open client" to "Review Before Today"
    // (the client now has charted history). The linked-session
    // branches (View session / Continue charting) are covered by the
    // core spec, which charts with appointment context.
    await page.goto("/dashboard");
    await expect(
      page.getByRole("link", { name: "Review Before Today" }).first(),
    ).toBeVisible();
    await expectNoPageOverflow(page, "dashboard after charting");
  });

  await test.step("calendar: mobile day view loads as ONE day, no page-wide overflow", async () => {
    await page.goto("/calendar");
    // The mobile single-day timeline renders (its floating +, day controls, and
    // tap-to-book layer) — NOT the sideways-scrollable 7-day week grid.
    await expect(
      page.getByRole("button", { name: "Add appointment or block time" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: "Previous day" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Next day" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Book on /i }).first(),
    ).toBeAttached();
    // The core win: one day, vertical only — no horizontal week-grid panning.
    await expectNoPageOverflow(page, "calendar mobile day view");
  });

  await test.step("calendar: floating + opens the Book/Block chooser; Book still creates nothing until submit", async () => {
    const before = (await getAppointmentsForClient(seed.studioId, clientId))
      .length;
    await page
      .getByRole("button", { name: "Add appointment or block time" })
      .click();
    // The + now opens a chooser (Book appointment / Block time), not the booking
    // drawer directly.
    await expect(CHOOSER(page)).toBeVisible({ timeout: 10_000 });
    await expect(
      CHOOSER(page).getByRole("button", { name: "Book appointment" }),
    ).toBeVisible();
    await expect(
      CHOOSER(page).getByRole("button", { name: "Block time" }),
    ).toBeVisible();
    // Book appointment -> the quick-book drawer; nothing created until submit.
    await CHOOSER(page).getByRole("button", { name: "Book appointment" }).click();
    await expect(DRAWER(page)).toBeVisible({ timeout: 10_000 });
    const after = (await getAppointmentsForClient(seed.studioId, clientId))
      .length;
    expect(after).toBe(before);
    await DRAWER(page).getByRole("button", { name: "Close", exact: true }).click();
    await expect(DRAWER(page)).toHaveCount(0);
  });

  await test.step("calendar: + -> Block time opens the reused block drawer prefilled with the selected day", async () => {
    await page
      .getByRole("button", { name: "Add appointment or block time" })
      .click();
    await expect(CHOOSER(page)).toBeVisible({ timeout: 10_000 });
    await CHOOSER(page).getByRole("button", { name: "Block time" }).click();
    // The desktop block-create drawer is reused (no mobile-only model): a date
    // (prefilled with the selected day), start/end, optional reason, Save block.
    await expect(BLOCK_DRAWER(page)).toBeVisible({ timeout: 10_000 });
    await expect(
      BLOCK_DRAWER(page).getByText(/^\d{4}-\d{2}-\d{2}$/),
    ).toBeVisible();
    await expect(
      BLOCK_DRAWER(page).getByRole("button", { name: "Save block" }),
    ).toBeVisible();
    await expectNoPageOverflow(page, "mobile block-time drawer");
    await BLOCK_DRAWER(page)
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(BLOCK_DRAWER(page)).toHaveCount(0);
  });

  await test.step("calendar: day navigation stays on one day with no page-wide overflow", async () => {
    await page.getByRole("button", { name: "Next day" }).click();
    await expectNoPageOverflow(page, "calendar next day");
    await page.getByRole("button", { name: "Previous day" }).click();
    await page.getByRole("button", { name: "Today" }).first().click();
    await expectNoPageOverflow(page, "calendar back to today");
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
    // PR #235: the charting page fits iPad width too.
    await ipadPage.goto(sessionPath);
    await expect(
      ipadPage.getByRole("heading", { name: /risks & aftercare/i }),
    ).toBeVisible();
    await expectNoPageOverflow(ipadPage, "iPad charting page");
    await ipadPage.goto("/calendar");
    await syntheticDrag(ipadPage, "touch");
    await ipadPage.waitForTimeout(600);
    await expect(DRAWER(ipadPage)).toHaveCount(0);
    await expect(CHOOSER(ipadPage)).toHaveCount(0);
    await ipad.close();
  });

  await test.step("desktop: header nav, account dropdown, wordmark, drag-create", async () => {
    const desktop = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    }); // explicit desktop viewport, no touch
    const desktopPage = await desktop.newPage();
    await loginAsOwner(desktopPage, seed);

    // Primary nav is the four working surfaces; Settings moved into
    // the account dropdown (PR #231).
    const header = desktopPage.locator("header");
    for (const label of ["Dashboard", "Clients", "Calendar", "Records"]) {
      await expect(
        header.getByRole("link", { name: label, exact: true }),
      ).toBeVisible();
    }
    await expect(
      header.getByRole("link", { name: "Settings", exact: true }),
    ).toHaveCount(0);
    await expect(
      desktopPage.getByRole("link", { name: /^Notifications/ }),
    ).toBeVisible();

    // Global search: input visible, finds the client, page shortcut
    // works, Escape and outside click close the dropdown.
    const search = desktopPage.getByRole("searchbox", { name: "Search Hone" });
    await expect(search).toBeVisible();
    await search.fill(seed.clientName);
    const clientResult = desktopPage.getByRole("link", {
      name: new RegExp(seed.clientEmail),
    });
    await expect(clientResult.first()).toBeVisible({ timeout: 15_000 });
    await desktopPage.keyboard.press("Escape");
    await expect(clientResult).toHaveCount(0);
    await search.fill("Getting");
    await expect(
      desktopPage.getByRole("link", { name: "Getting Started Go to page" }),
    ).toBeVisible({ timeout: 15_000 });
    await desktopPage.getByText("Charted within 24h").first().click();
    await expect(
      desktopPage.getByRole("link", { name: "Getting Started Go to page" }),
    ).toHaveCount(0);
    await search.fill(seed.clientName);
    await expect(clientResult.first()).toBeVisible({ timeout: 15_000 });
    await clientResult.first().click();
    await desktopPage.waitForURL(new RegExp(`/clients/${clientId}`));
    await desktopPage.goto("/dashboard");

    // Account dropdown: opens, shows profile block + actions, closes
    // on outside click and on Escape.
    const trigger = desktopPage.getByRole("button", {
      name: "Open account menu",
    });
    const accountNav = desktopPage.getByRole("navigation", {
      name: "Account menu",
    });
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(accountNav.getByText(seed.studioName)).toBeVisible();
    await expect(accountNav.getByText(/· Owner/)).toBeVisible();
    for (const label of ["Settings", "Getting Started"]) {
      await expect(accountNav.getByRole("link", { name: label })).toBeVisible();
    }
    await expect(
      accountNav.getByRole("button", { name: "Sign out" }),
    ).toBeVisible();
    await desktopPage.getByText("Charted within 24h").first().click();
    await expect(accountNav).toHaveCount(0);
    await trigger.click();
    await desktopPage.keyboard.press("Escape");
    await expect(accountNav).toHaveCount(0);

    // Wordmark goes home on desktop too.
    await desktopPage.goto("/records");
    await desktopPage.getByRole("link", { name: "Go to Dashboard" }).click();
    await desktopPage.waitForURL(/dashboard/);

    await desktopPage.goto("/calendar");
    await syntheticDrag(desktopPage, "mouse");
    await expect(CHOOSER(desktopPage)).toBeVisible({ timeout: 10_000 });
    await desktop.close();
  });
});
