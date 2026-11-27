import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { seedE2eStudio, seedE2eMember, seedConfirmedAppointment, getOwnerPractitionerId, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// HON-124 item 14. Destructive staff actions ask first, through the house confirm dialog, at iPhone width (390x844) by touch emulation AND keyboard:
// the dialog names the action and its consequence, Cancel / Escape change nothing and put focus back on the trigger, Confirm acts once.
// Covered here: revoke an invitation, remove a team member, cancel an appointment. (Deactivate a receptionist is covered by
// team-invite-receptionist.spec.ts and receptionist-onboarding-flow.spec.ts.) Synthetic fixture studio only.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const T = 20_000;

const dialog = (page: Page) => page.getByRole("alertdialog");
const confirm = (page: Page) => page.getByTestId("confirm-dialog-confirm");
const cancel = (page: Page) => page.getByTestId("confirm-dialog-cancel");

async function expectUsableDialog(page: Page) {
  await expect(dialog(page)).toBeVisible({ timeout: T });
  for (const b of [confirm(page), cancel(page)]) {
    const box = (await b.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(43.5); // the touch floor
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(391);
  }
  await expect(confirm(page)).toBeFocused(); // focus moves INTO the dialog
}

test.describe("destructive actions ask first", () => {
  test("revoke an invitation: names it, Cancel and Escape change nothing and return focus, Confirm revokes once", async ({ page }) => {
    const seed = await seedE2eStudio();
    const invitee = `confirm-${seed.runId}@harness.local`;
    await sql(`insert into public.pending_invitations (studio_id, email, role, display_name) values ($1, $2, 'practitioner', 'Confirm Invitee')`, [seed.studioId, invitee]);
    await loginAsOwner(page, seed);
    await page.goto("/settings/team");
    const row = page.locator("li", { hasText: invitee });
    const trigger = row.getByRole("button", { name: `Revoke the invitation for ${invitee}` });
    await expect(trigger).toBeVisible({ timeout: T });
    const status = async () => (await sql<{ status: string }>(`select status from public.pending_invitations where studio_id=$1 and lower(email)=$2`, [seed.studioId, invitee]))[0]!.status;

    await trigger.click();
    await expectUsableDialog(page);
    await expect(dialog(page)).toContainText("Revoke this invitation?");
    await expect(dialog(page)).toContainText(invitee);
    await expect(dialog(page)).toContainText("will stop working");
    await cancel(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger).toBeFocused(); // focus restored
    expect(await status()).toBe("pending");

    // keyboard only: Enter on the focused trigger opens it, Escape closes it and restores focus, Enter on Confirm revokes
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible({ timeout: T });
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await status()).toBe("pending");
    await page.keyboard.press("Enter");
    await expect(confirm(page)).toBeFocused({ timeout: T });
    await page.keyboard.press("Tab"); // the trap keeps focus inside the dialog
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest('[role="alertdialog"]') != null)).toBe(true);
    await confirm(page).focus();
    await page.keyboard.press("Enter");
    await expect.poll(status, { timeout: T }).toBe("revoked");
  });

  test("remove a team member: names them and what is kept, Cancel keeps them active, Confirm deactivates", async ({ page }) => {
    const seed = await seedE2eStudio();
    const member = await seedE2eMember(seed);
    await loginAsOwner(page, seed);
    await page.goto("/settings/team");
    const trigger = page.getByRole("button", { name: `Remove ${member.displayName}` });
    await expect(trigger).toBeVisible({ timeout: T });
    const active = async () => (await sql<{ active: boolean }>(`select active from public.practitioners where id=$1`, [member.practitionerId]))[0]!.active;

    await trigger.click();
    await expectUsableDialog(page);
    await expect(dialog(page)).toContainText(`Remove ${member.displayName} from the team?`);
    await expect(dialog(page)).toContainText("appointments and records are kept");
    await cancel(page).click();
    await expect(trigger).toBeFocused();
    expect(await active()).toBe(true);
    await trigger.click();
    await confirm(page).click();
    await expect.poll(active, { timeout: T }).toBe(false);
  });

  test("keyboard only: Tab to Remove, Enter opens the dialog with focus inside, Escape closes it and focus returns to the trigger", async ({ page }) => {
    const seed = await seedE2eStudio();
    const member = await seedE2eMember(seed);
    await loginAsOwner(page, seed);
    await page.goto("/settings/team");
    const label = `Remove ${member.displayName}`;
    await expect(page.getByRole("button", { name: label })).toBeVisible({ timeout: T });
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    let reached = false;
    for (let i = 0; i < 120 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate((l) => document.activeElement?.getAttribute("aria-label") === l, label);
    }
    expect(reached, "Tab reaches the Remove button").toBe(true);
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible({ timeout: T });
    expect(await page.evaluate(() => document.activeElement?.closest('[role="alertdialog"]') != null)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: label })).toBeFocused();
    const active = (await sql<{ active: boolean }>(`select active from public.practitioners where id=$1`, [member.practitionerId]))[0]!.active;
    expect(active).toBe(true); // Escape changed nothing
  });

  test("cancel an appointment: Keep appointment changes nothing, Confirm cancels it", async ({ page }) => {
    const seed = await seedE2eStudio();
    const clientId = randomUUID();
    await sql("insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)", [clientId, seed.studioId, "Confirm Client", `confirm-client-${seed.runId}@harness.local`]);
    const practitionerId = await getOwnerPractitionerId(seed.studioId);
    const start = new Date(Date.now() + 48 * 3_600_000);
    const apptId = await seedConfirmedAppointment(seed.studioId, practitionerId, clientId, start.toISOString(), new Date(start.getTime() + 3_600_000).toISOString());
    await loginAsOwner(page, seed);
    await page.goto(`/calendar/${apptId}`);
    const trigger = page.getByRole("button", { name: "Cancel appointment", exact: true });
    await expect(trigger).toBeVisible({ timeout: T });
    const status = async () => (await sql<{ status: string }>(`select status from public.appointments where id=$1`, [apptId]))[0]!.status;

    await trigger.click();
    await expectUsableDialog(page);
    await expect(dialog(page)).toContainText("Cancel this appointment?");
    await expect(dialog(page)).toContainText("emailed about the cancellation");
    await page.getByRole("button", { name: "Keep appointment" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await status()).toBe("confirmed");
    await trigger.click();
    await confirm(page).click();
    await expect.poll(status, { timeout: T }).toBe("cancelled");
  });
});
