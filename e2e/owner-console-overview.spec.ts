import { test, expect } from "@playwright/test";
import { seedE2eStudio, seedE2eMember, type E2eSeed } from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";

// STUDIO-READY-03b (#824): the owner console composes the authorities it does
// not own, through the real page against a synthetic studio:
//   * DELIVERY-VISIBILITY-02's OwnerDeliveryCard, mounted as-is, with no delivery
//     problems and NOT "unavailable" (the read succeeded);
//   * per-country text-message readiness (SMS-SENDER-READY-01): with no sender,
//     never "ready";
//   * Connect status gated by the payment country (PAY-CCY): with no Stripe
//     account, never "ready".
// A practitioner sees no console. Never Willow / production data.

test.describe.configure({ mode: "serial" });

let seed: E2eSeed;
let member: { email: string };

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  member = await seedE2eMember(seed);
});

test("the owner sees every panel, the delivery card, and nothing reads ready that is not", async ({ page }) => {
  await loginAsOwner(page, seed);
  await page.goto("/settings/overview");
  await expect(page.getByRole("heading", { name: "Studio overview" })).toBeVisible();

  const panel = (title: string) => page.getByRole("listitem").filter({ has: page.getByText(title, { exact: true }) });
  for (const title of ["Booking setup", "Team", "Phone and text messages", "Payments", "Alert recipients"]) {
    await expect(panel(title), title).toBeVisible();
  }
  for (const [title, href] of [
    ["Booking setup", "/settings/launch"],
    ["Team", "/settings/team"],
    ["Phone and text messages", "/settings/integrations"],
    ["Payments", "/settings/payments"],
  ]) {
    await expect(page.getByRole("link", { name: `Open ${title}`, exact: true })).toHaveAttribute("href", href);
  }
  // No sender: per-country rows, never "ready".
  await expect(panel("Phone and text messages")).toContainText("Canada:");
  await expect(panel("Phone and text messages")).toContainText("US:");
  // No Stripe account: never "Live payments ready".
  await expect(panel("Payments")).not.toContainText("Live payments ready");
  await expect(panel("Payments")).toContainText("Not connected");
  // The delivery lane's own card, which answered: no problems, not "unavailable".
  const delivery = page.getByRole("region", { name: "Message delivery" });
  await expect(delivery).toBeVisible();
  await expect(delivery).toContainText("No delivery problems reported");
  await expect(page.getByText("Delivery status is unavailable")).toHaveCount(0);
  // The old placeholder is gone.
  await expect(page.getByText("Message delivery problems", { exact: true })).toHaveCount(0);
});

test("the delivery card no longer sits on the Launch checklist", async ({ page }) => {
  await loginAsOwner(page, seed);
  await page.goto("/settings/launch");
  await expect(page.getByRole("region", { name: "Message delivery" })).toHaveCount(0);
});

test("a practitioner gets no console", async ({ page }) => {
  await loginByMagicLink(page, member.email);
  await page.goto("/settings/overview");
  await expect(page.getByText("Only studio owners can see the studio overview.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Message delivery" })).toHaveCount(0);
});
