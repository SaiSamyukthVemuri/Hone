import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { sql } from "./helpers/seed";

// HON-84. The public /demo form still succeeds for a visitor now that it saves through the 0213 service-role command, and
// the save is exactly one lead with its one alert row. The alert itself is the lane's fake transport: no real inbox exists here,
// and with LEAD_ALERT_EMAIL unset (the lane's default) nothing is sent at all. The early-access form (app/_components/WaitlistForm)
// is not mounted on any page in this tree, so its action is proved against the real schema in
// tests/db/platform-lead-alert-actions.db.test.ts instead.

type AlertRow = { status: string; attempt_count: number; provider_message_id: string | null; last_error_code: string | null };

test.describe("the public /demo form", () => {
  test("a visitor submits and sees the confirmation; one lead and one alert row are saved; nothing is accepted by a provider when no recipient is configured", async ({ page }) => {
    const email = `success+visitor-${randomUUID().slice(0, 8)}@lead-forms-e2e.test`;
    await page.goto("/demo");
    await page.getByLabel("Your name").fill("Avery Visitor");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Studio or practice name").fill("Maple Clinic");
    await page.getByRole("button", { name: "Request my walkthrough" }).click();
    await expect(page.getByText(/a real person will email you/i)).toBeVisible({ timeout: 30_000 });

    const leads = await sql<{ id: string }>("select id from public.demo_requests where email = $1", [email]);
    expect(leads).toHaveLength(1);
    const alerts = await sql<AlertRow>(
      "select status, attempt_count, provider_message_id, last_error_code from public.platform_lead_alerts where demo_request_id = $1",
      [leads[0].id],
    );
    // 0213: the alert row is created in the SAME transaction as the lead, whatever the recipient configuration.
    expect(alerts).toHaveLength(1);

    if (!process.env.LEAD_ALERT_EMAIL) {
      // No recipient: the lead is saved, and the alert is never accepted by a provider. Give the post-response work a moment, then check.
      await page.waitForTimeout(3_000);
      const after = await sql<AlertRow>("select status, attempt_count, provider_message_id, last_error_code from public.platform_lead_alerts where demo_request_id = $1", [leads[0].id]);
      expect(after[0].status).not.toBe("accepted");
      expect(after[0].provider_message_id).toBeNull();
    }
  });

  test("the form says nothing about the operator alert to the visitor", async ({ page }) => {
    const email = `success+visitor-${randomUUID().slice(0, 8)}@lead-forms-e2e.test`;
    await page.goto("/demo");
    await page.getByLabel("Your name").fill("Avery Visitor");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Studio or practice name").fill("Maple Clinic");
    await page.getByRole("button", { name: "Request my walkthrough" }).click();
    await expect(page.getByText(/a real person will email you/i)).toBeVisible({ timeout: 30_000 });
    const body = (await page.locator("body").innerText()).toLowerCase();
    expect(body).not.toContain("alert");
    expect(body).not.toContain("operator");
  });
});
