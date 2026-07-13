import { test, expect, type Request } from "@playwright/test";
import { seedE2eStudio, seedE2eOverdueDisinfectant } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Willow follow-up (Issue #420-adjacent Chloe request): an overdue disinfectant
// "Replace now" record must also surface in the Notification Centre as an
// operational safety alert, and must resolve when a replacement is recorded.
//
// Local-only, synthetic data (e2e/helpers/local-env.ts refuses hosted URLs). The
// alert is COMPUTED, so recording a replacement (setting the actual discard date
// through the REAL Records edit form) makes it no longer overdue and the alert
// disappears — no cron, no email/SMS.

test("overdue disinfectant surfaces in Notification Centre and resolves on replacement", async ({
  page,
}) => {
  // Sanity monitor: the browser must never call a real email/SMS provider.
  const providerRequests: string[] = [];
  page.on("request", (req: Request) => {
    if (/api\.resend\.com|api\.twilio\.com|twilio\.com/.test(req.url())) {
      providerRequests.push(req.url());
    }
  });

  const studio = await seedE2eStudio();
  await seedE2eOverdueDisinfectant(studio, { name: "Barbicide E2E jar" });

  // A DIFFERENT studio's overdue item must never appear for this owner (tenancy).
  const otherStudio = await seedE2eStudio();
  await seedE2eOverdueDisinfectant(otherStudio, { name: "OtherStudio Cavicide" });

  await loginAsOwner(page, studio);

  // Header badge reflects the operational alert (>=1 unread) on every page.
  // (Desktop + mobile bells both exist in the DOM; assert the visible one.)
  await expect(
    page.getByRole("link", { name: /Notifications, \d+ unread/i }).first(),
  ).toBeVisible();

  // Notification Centre shows the overdue disinfectant alert with safe context.
  await page.goto("/notifications");
  const alerts = page.getByTestId("operational-alerts");
  await expect(alerts).toBeVisible();
  await expect(alerts.getByText("Replace disinfectant now")).toBeVisible();
  await expect(
    alerts.getByText("A disinfectant record is overdue for replacement."),
  ).toBeVisible();
  await expect(alerts.getByText(/Barbicide E2E jar/)).toBeVisible();
  // "overdue" appears in both the badge and the days-overdue line; assert one.
  await expect(alerts.getByText(/overdue/i).first()).toBeVisible();
  // Cross-studio item is invisible.
  await expect(page.getByText("OtherStudio Cavicide")).toHaveCount(0);

  // Opening the alert navigates to the authorized disinfectants records section.
  await alerts.getByRole("link", { name: "Review disinfectant records" }).click();
  await expect(page).toHaveURL(/\/records\?section=disinfectants/);
  await expect(page.getByText("Barbicide E2E jar").first()).toBeVisible();
  await expect(page.getByText(/Overdue — replace now/i)).toBeVisible();

  // Record a replacement through the REAL edit form: set the actual discard date.
  await page.getByText("Edit", { exact: true }).first().click();
  const editForm = page.locator("form", {
    has: page.getByRole("button", { name: "Save changes" }),
  });
  await editForm.getByLabel("Actual date discarded").fill("2020-02-01");
  await editForm.getByRole("button", { name: "Save changes" }).click();

  // The record is no longer overdue (the row's "Replace now" badge is gone).
  await expect(page.getByText(/Overdue — replace now/i)).toHaveCount(0);

  // Back in the Notification Centre, the alert is resolved/absent — and no
  // duplicate was created.
  await page.goto("/notifications");
  await expect(page.getByText("Replace disinfectant now")).toHaveCount(0);
  await expect(page.getByTestId("operational-alerts")).toHaveCount(0);

  // No real email/SMS provider was contacted.
  expect(providerRequests).toEqual([]);
});
