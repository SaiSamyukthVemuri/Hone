import { expect, test } from "@playwright/test";
import { seedE2eStudio, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

test("owner configures 48-hour and same-day fees, enables separately, and cannot use stale policy rules", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  await sql(
    `update public.studios set cancellation_policy_text=$2, no_show_policy_text='' where id=$1`,
    [seed.studioId, "Less than 48 hours: 50%. Same-day cancellations: 100%."],
  );
  await loginAsOwner(page, seed);
  await page.goto("/settings/payments/fees");
  const card = page.getByRole("region", {
    name: "Late cancellation fee",
    exact: true,
  });
  const toggle = card.getByRole("switch", {
    name: "Allow late cancellation fees",
  });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toBeDisabled();
  await card.getByLabel("Notice window").fill("48");
  await card.locator("#notice-rate-value").fill("50");
  await card.locator("#same-rate-value").fill("100");
  await card
    .getByText("Review your cancellation policy", { exact: true })
    .click();
  await expect(
    card.getByText("Less than 48 hours: 50%. Same-day cancellations: 100%.", {
      exact: true,
    }),
  ).toBeVisible();
  await card.getByRole("checkbox").check();
  await card.getByRole("button", { name: "Save rules", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await sql(
            `select enabled from public.studio_cancellation_fee_rules where studio_id=$1`,
            [seed.studioId],
          )
        )[0]?.enabled,
    )
    .toBe(false);
  await page.reload();
  await expect(card.locator("#notice-rate-value")).toHaveValue("50");
  await expect(card.locator("#same-rate-value")).toHaveValue("100");
  await toggle.click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "50% with less than 48 hours",
  );
  await expect(page.getByRole("alertdialog")).toContainText(
    "100% on the same day",
  );
  await page.getByTestId("confirm-dialog-confirm").click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(
      async () =>
        (
          await sql(
            `select enabled from public.studio_cancellation_fee_rules where studio_id=$1`,
            [seed.studioId],
          )
        )[0]?.enabled,
    )
    .toBe(true);
  expect(
    (
      await sql(`select no_show_fee_enabled from public.studios where id=$1`, [
        seed.studioId,
      ])
    )[0].no_show_fee_enabled,
  ).toBe(false);
  expect(
    (
      await sql(
        `select count(*)::int n from public.payment_charge_attempts where studio_id=$1`,
        [seed.studioId],
      )
    )[0].n,
  ).toBe(0);
  await sql(
    `update public.studios set cancellation_policy_text='Changed policy' where id=$1`,
    [seed.studioId],
  );
  await page.reload();
  await expect(card.getByText(/The cancellation policy changed/)).toBeVisible();
  // Turning OFF is still available after the policy changes.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toBeDisabled();
});
