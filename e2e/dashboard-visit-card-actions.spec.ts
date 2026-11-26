import { expect, test } from "@playwright/test";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";
import {
  seedE2eDashboardClient,
  seedE2eDashboardMemoryClient,
  seedE2eMember,
  seedE2eStudio,
  seedE2eTodayAppointment,
  seedPinnedNote,
  sql,
} from "./helpers/seed";

// Practitioner feedback on the dashboard visit card (26 Nov 2026), proved in a real browser. Synthetic data only.
//   1. ONE action row, every action the same size, wrapping inside its own group on a phone.
//   2. Pinned notes stay YELLOW (inline edit and "Add pinned note" preserved).
//   3. "From last visit, for today" is its own BLUE box.
//   4. Last visit details are ON the card on first render, with no click.
//   5. Checkout is OWNER-ONLY: an owner sees it on the visit card, a signed-in practitioner sees the same card without it.

const T = 20_000;

test("visit card: one action row, yellow pins, blue reminder, last visit details open with no click", async ({ page }) => {
  const studio = await seedE2eStudio();
  const { clientId, appointmentId } = await seedE2eDashboardMemoryClient(studio, {
    cautionNote: "Avoid the jawline",
    nextVisitNote: "Lower the energy one step",
  });
  await seedPinnedNote(studio.studioId, clientId, "Prefers the 2pm slot");
  // In progress: started 20 minutes ago, so Checkout (a started visit) is offered.
  await sql("update public.appointments set starts_at = now() - interval '20 minutes', ends_at = now() + interval '25 minutes' where id = $1", [appointmentId]);
  await loginAsOwner(page, studio);
  await page.goto("/dashboard");
  const row = page.locator(`#appointment-${appointmentId}`);
  await expect(row).toBeVisible({ timeout: T });

  await test.step("4. the details are open on FIRST render, no click", async () => {
    const toggle = row.getByTestId("dashboard-memory-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: T });
    await expect(row.getByTestId("dashboard-memory-full")).toContainText("27.12 MHz", { timeout: T });
  });

  await test.step("1. one action row, one size, grouped", async () => {
    const group = row.getByTestId("today-row-actions");
    await expect(group).toHaveCount(1);
    const names = ["Checkout", "Rebook", "Chart", "Consultation notes"];
    const g = (await group.boundingBox())!;
    const heights: number[] = [];
    for (const name of names) {
      const el = group.getByRole(name === "Checkout" ? "button" : "link", { name, exact: true });
      await expect(el, name).toBeVisible();
      const b = (await el.boundingBox())!;
      heights.push(Math.round(b.height));
      // inside the group's box
      expect(b.x).toBeGreaterThanOrEqual(g.x - 1);
      expect(b.x + b.width).toBeLessThanOrEqual(g.x + g.width + 1);
      expect(b.y).toBeGreaterThanOrEqual(g.y - 1);
      expect(b.y + b.height).toBeLessThanOrEqual(g.y + g.height + 1);
    }
    expect(new Set(heights).size, `all action heights equal: ${heights}`).toBe(1);
    const fonts = await group.locator("a, button").evaluateAll(els => els.map(e => getComputedStyle(e).fontSize));
    expect(new Set(fonts).size, `all action font sizes equal: ${fonts}`).toBe(1);
    // none of these actions lives outside the group
    await expect(row.getByTestId("today-consultation-notes")).toHaveCount(1);
    await expect(group.getByTestId("today-consultation-notes")).toHaveCount(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  await test.step("2 + 3. pinned note is yellow, the reminder is its own blue box", async () => {
    const reminder = row.getByTestId("dashboard-prep-remember");
    await expect(reminder).toContainText("From last visit, for today");
    await expect(reminder).toContainText("Lower the energy one step");
    // Colour by the design tokens' classes: computed colours come back as oklch/lab, which no rgb parser reads.
    await expect(reminder).toHaveClass(/bg-blue-50/);
    await expect(reminder).not.toHaveClass(/amber|yellow/);
    const pinned = row.getByText("Prefers the 2pm slot").first().locator("xpath=ancestor::div[contains(@class,'bg-amber-50')][1]");
    await expect(pinned).toHaveCount(1);
    await expect(pinned).not.toHaveClass(/blue/);
    await expect(row.getByRole("button", { name: /^Add pinned note for / })).toBeVisible();
    await expect(row.getByRole("button", { name: /^Edit pinned note for / })).toBeVisible();
    // The two boxes are separate elements.
    expect(await reminder.evaluate((e, p) => e.contains(p), await pinned.elementHandle())).toBe(false);
  });
});

test("Checkout is owner-only: the owner sees it on the visit card, a signed-in practitioner sees the same card without it", async ({ page, browser, baseURL }) => {
  const studio = await seedE2eStudio();
  const { clientId } = await seedE2eDashboardClient(studio, { label: "Owner only" });
  const member = await seedE2eMember(studio);
  // A visit in progress (Checkout is offered once it has started), assigned to the practitioner, so the card is the member's own.
  const { appointmentId } = await seedE2eTodayAppointment(studio, {
    clientId,
    startsMinutesFromNow: -20,
    endsMinutesFromNow: 25,
    withService: true,
  });
  await sql("update public.appointments set practitioner_id = $2 where id = $1", [appointmentId, member.practitionerId]);

  await test.step("the owner sees Check out on the card", async () => {
    await loginAsOwner(page, studio);
    await page.goto("/dashboard");
    const row = page.locator(`#appointment-${appointmentId}`);
    await expect(row).toBeVisible({ timeout: T });
    await expect(row.getByTestId("today-rebook")).toBeVisible();
    await expect(row.getByRole("button", { name: "Checkout", exact: true })).toHaveCount(1);
  });

  await test.step("a signed-in practitioner sees the same visit card with NO Check out", async () => {
    const context = await browser.newContext({ baseURL: baseURL ?? undefined, viewport: page.viewportSize() ?? undefined });
    try {
      const memberPage = await context.newPage();
      await loginByMagicLink(memberPage, member.email);
      await memberPage.goto("/dashboard");
      const row = memberPage.locator(`#appointment-${appointmentId}`);
      // The card is really there (its other actions render), so an absent Checkout is the owner rule, not a missing row.
      await expect(row).toBeVisible({ timeout: T });
      await expect(row.getByTestId("today-rebook")).toBeVisible();
      await expect(row.getByTestId("today-chart")).toBeVisible();
      await expect(row.getByRole("button", { name: /^Check ?out$/i })).toHaveCount(0);
      await expect(row.getByText("Available once the appointment has started")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
