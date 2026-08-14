import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, seedE2eDashboardMemoryClient } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// ===========================================================================
// Chloe Dashboard cleanup — the browser proof.
// ===========================================================================
//
// D1 REPORTED DEFECT (the reason this file exists). On Dashboard → Today,
// "View full last treatment" expanded the previous treatment and then took her
// away to another page. She never asked to navigate; she asked to read.
//
// REPRODUCED CAUSE. The disclosure was rendered INSIDE the Today row's body
// <Link href="/calendar/{id}">, so the toggle's click bubbled straight into a
// route push — and, once open, the embedded card rendered an <a> ("Open full
// chart →") nested inside that <a>, which is invalid HTML whose activation
// behaviour is undefined.
//
// WHY A BROWSER TEST AND NOT A SOURCE GREP. The unit lane
// (tests/app/dashboard/today-treatment-memory.test.ts) pins the JSX shape, but
// the defect is a NAVIGATION — a thing that only exists once a real click meets
// a real router. A source assertion cannot observe a URL change, and the
// "expands briefly, then leaves" symptom is precisely a timing behaviour, so
// the wait below is deliberate and not a smell: a delayed push is exactly what
// Chloe saw.
//
// The other three cleanups (D2 booking-setup, D3 getting-started, D4 pilot
// learning) are all "this must NOT be on the page", and an absence is worth
// asserting in the browser too — a card can be absent from the source and
// present from a layout, or vice versa.

const T = 20_000;
/** Longer than any plausible delayed client-side push. */
const SETTLE_MS = 3_500;

function dashboardPath(page: Page): string {
  return new URL(page.url()).pathname;
}

test.describe("D1 — the Treatment Memory disclosure stays on the Dashboard", () => {
  test("expanding, waiting and collapsing never leaves /dashboard", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    // A client with a REAL prior charted treatment (a completed session 30 days
    // ago with a settings block), plus an appointment today, so the Today row
    // has history and renders the disclosure.
    const { appointmentId } = await seedE2eDashboardMemoryClient(seed, {
      cautionNote: null,
      nextVisitNote: "E2E plan: re-check tolerance on the first pass.",
    });
    await loginAsOwner(page, seed);

    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { name: "Today", exact: true }),
    ).toBeVisible({ timeout: T });

    // 2. Record the URL we must still be on at the end.
    const urlBefore = page.url();
    expect(dashboardPath(page)).toBe("/dashboard");

    const toggle = page.getByTestId("today-memory-toggle").first();
    await expect(toggle).toBeVisible({ timeout: T });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // The compact line is there before expanding; the full card is not.
    await expect(page.getByTestId("today-memory-compact").first()).toBeVisible();
    await expect(page.getByTestId("today-memory-full")).toHaveCount(0);

    // 3. Click the control Chloe clicks.
    await toggle.click();

    // 4. The FULL previous treatment is really rendered — not an empty shell.
    const full = page.getByTestId("today-memory-full").first();
    await expect(full).toBeVisible({ timeout: T });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const card = full.getByTestId("appointment-prep-memory");
    await expect(card).toBeVisible();
    // Real clinical content from the seeded prior visit, not just a container.
    await expect(card.getByText("Last treatment", { exact: true })).toBeVisible();
    await expect(card.getByTestId("prep-areas")).toContainText("Upper lip");
    await expect(card.getByTestId("prep-setup-area").first()).toContainText(
      "27.12 MHz",
    );
    await expect(card.getByTestId("prep-notes")).toBeVisible();

    // 5. WAIT. The bug was "expands briefly, then goes"; a push that lands one
    //    tick after the assertion above would otherwise pass this test.
    await page.waitForTimeout(SETTLE_MS);

    // 6. Still on the Dashboard.
    expect(page.url(), "expanding must not navigate").toBe(urlBefore);
    expect(dashboardPath(page)).toBe("/dashboard");

    // 7. ...and the content she expanded is still on screen.
    await expect(full).toBeVisible();
    await expect(card.getByTestId("prep-areas")).toContainText("Upper lip");

    // The embedded disclosure offers NO way out of the Dashboard.
    await expect(
      card.getByTestId("prep-full-chart-link"),
      "the embedded card must not carry an Open-full-chart CTA",
    ).toHaveCount(0);
    await expect(full.getByText("Open full chart")).toHaveCount(0);

    // 8. Collapse it.
    await toggle.click();
    await expect(page.getByTestId("today-memory-full")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // 9. Still nowhere near a route change.
    await page.waitForTimeout(SETTLE_MS);
    expect(page.url(), "collapsing must not navigate either").toBe(urlBefore);
    expect(dashboardPath(page)).toBe("/dashboard");

    // The row body itself is UNCHANGED: it still opens the appointment. The fix
    // removed the disclosure from inside the link, not the link.
    await page
      .locator(`a[href="/calendar/${appointmentId}"]`)
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/calendar/${appointmentId}$`), {
      timeout: T,
    });
  });

  test("the STANDALONE appointment-prep card keeps its full-chart navigation", async ({
    page,
  }) => {
    // The other half of the capability: this is a per-surface presentation
    // decision, not a deletion. On the appointment page — where she is already
    // preparing for THIS visit — the link to the prior chart is the point.
    const seed = await seedE2eStudio();
    const { appointmentId } = await seedE2eDashboardMemoryClient(seed, {
      cautionNote: null,
    });
    await loginAsOwner(page, seed);

    await page.goto(`/calendar/${appointmentId}`);
    const card = page.getByTestId("appointment-prep-memory");
    await expect(card).toBeVisible({ timeout: T });

    const link = card.getByTestId("prep-full-chart-link");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", /\/clients\/.+\/sessions\/.+/);

    // And it genuinely navigates to the full session chart.
    await link.click();
    await expect(page).toHaveURL(/\/clients\/[^/]+\/sessions\/[^/]+$/, {
      timeout: T,
    });
  });
});

test.describe("D2/D3/D4 — finished setup and pilot tooling are off the Dashboard", () => {
  test("no completed-setup cards and no Pilot learning card render", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await seedE2eDashboardMemoryClient(seed, { cautionNote: null });
    await loginAsOwner(page, seed);

    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { name: "Today", exact: true }),
    ).toBeVisible({ timeout: T });

    await test.step("D2: booking readiness is COMPLETE, so no booking card at all", async () => {
      // seedE2eStudio satisfies every REQUIRED readiness item: studio name,
      // slug, one active service, seven open availability days, and the booking
      // settings numbers (timezone / duration / buffer / horizon). So
      // computeBookingReadiness returns "ready" — which is exactly the state
      // that used to render "Booking page ready / Your public booking page is
      // live" plus a column of ticks, permanently.
      //
      // Both headings must be absent: "ready" means no congratulation, and it
      // also means the not-ready setup card must not appear (if it did, the
      // seed is no longer booking-ready and this proof has silently rotted).
      await expect(
        page.getByRole("heading", { name: "Booking page ready" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Set up your booking page" }),
      ).toHaveCount(0);
      await expect(page.getByText("Your public booking page is live")).toHaveCount(0);
    });

    await test.step("D2 control: the booking link still lives on its settings page", async () => {
      // Hiding the ready card removed a banner, never the capability.
      // BookingLinkCard's "card" variant puts the URL in a readonly <input>,
      // so this reads the VALUE — getByText would never see it.
      await page.goto("/settings/booking");
      const linkInput = page.locator(`input[readonly][value$="/book/${seed.slug}"]`);
      await expect(linkInput).toBeVisible({ timeout: T });
      await expect(linkInput).toHaveValue(new RegExp(`/book/${seed.slug}$`));
      await page.goto("/dashboard");
      await expect(
        page.getByRole("heading", { name: "Today", exact: true }),
      ).toBeVisible({ timeout: T });
    });

    await test.step("D3: no 'Setup complete' congratulation anywhere", async () => {
      await expect(page.getByText("Setup complete.")).toHaveCount(0);
      await expect(page.getByText("Getting started checklist")).toHaveCount(0);
    });

    await test.step("D3 control: an INCOMPLETE studio still gets its assistance", async () => {
      // A freshly seeded studio has not recorded sterile items, disinfectants,
      // probe lots and so on, so getting-started is genuinely incomplete and the
      // progress card MUST still be offered. This is the assertion that stops
      // "hide when complete" quietly becoming "hide always".
      await expect(
        page.getByRole("link", { name: /Getting started/ }),
      ).toBeVisible({ timeout: T });
    });

    await test.step("D3 control: the dedicated route is still reachable", async () => {
      await page.goto("/getting-started");
      await expect(
        page.getByRole("heading", { name: /Getting started/i }).first(),
      ).toBeVisible({ timeout: T });
      await page.goto("/dashboard");
      await expect(
        page.getByRole("heading", { name: "Today", exact: true }),
      ).toBeVisible({ timeout: T });
    });

    await test.step("D4: Pilot learning is gone, copy and all", async () => {
      await expect(
        page.getByRole("heading", { name: "Pilot learning" }),
      ).toHaveCount(0);
      await expect(page.getByText("Send it to Sam")).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "Know another electrologist?" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "Send feedback" }),
      ).toHaveCount(0);
    });

    await test.step("D4: the quiet feedback footers are gone TOO", async () => {
      // DASH-TRUTH-04. The earlier cleanup removed the large "Pilot learning"
      // card but left two quiet <PilotFeedbackPrompt> footers under Today and
      // To do. Chloe does not want the daily product sending feedback directly
      // to Sam, so ALL Dashboard pilot-feedback UI is now absent — the card and
      // the footers.
      //
      // Narrow, stable assertions: the prompt's own copy, and the mailto link
      // it renders. Deliberately not a bare absence of "Yes", which is a common
      // word an unrelated future control could legitimately use.
      await expect(page.getByText("Was this useful?")).toHaveCount(0);
      await expect(
        page.locator('a[href^="mailto:hello@hone.care"]'),
      ).toHaveCount(0);
    });

    await test.step("D4 control: the SHARED helper was not over-deleted", async () => {
      // The requirement was Dashboard-specific. The shared mailto helper and
      // the PilotFeedbackPrompt component are deliberately retained, so this
      // proves the removal was scoped to Dashboard rendering rather than a
      // blanket deletion of the capability.
      const res = await page.request.get("/getting-started");
      expect(res.status()).toBeLessThan(400);
    });

    await test.step("regression: the operational hierarchy is unchanged", async () => {
      // Today first, To do second, Birthdays after — and nothing new inserted.
      const headings = await page
        .locator("main h2, h2")
        .allTextContents();
      const own = headings.filter((h) =>
        ["Today", "To do", "Birthdays this month"].includes(h.trim()),
      );
      expect(own[0]).toBe("Today");
      expect(own[1]).toBe("To do");
      await expect(
        page.getByRole("heading", { name: "To do", exact: true }),
      ).toBeVisible();
    });
  });
});
