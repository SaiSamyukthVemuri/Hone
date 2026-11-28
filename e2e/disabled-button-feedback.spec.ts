import { expect, test, type Locator, type Page } from "@playwright/test";
import { seedE2eStudio, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// The shared Button: a DISABLED button must not react to a hover or a press, and an ENABLED one still does.
// Surface: Settings > Payments > Fees, the "Save rules" button (primary variant). It is disabled until the notice window, the rates and the policy review are filled in.
//   1. Disabled: its look at rest, hovered and with the mouse held down is IDENTICAL (colours, border, box-shadow and transform), and the pointer shows "not allowed".
//   2. Positive control: after the form is filled in (typing only, nothing is saved) the same button is enabled and its hover and pressed looks DIFFER from rest and from each other.
//      Without this a button that never reacted at all would pass step 1.
// Never clicked: no write happens, and the studio's payment settings rows are identical at the end. Each state is read after the 120-180ms transition has settled.

const SETTLE = 400;
const look = (l: Locator) =>
  l.evaluate((e) => {
    const c = getComputedStyle(e);
    return [c.backgroundColor, c.color, c.borderTopColor, c.boxShadow, c.transform, c.opacity].join("|");
  });

async function states(page: Page, b: Locator) {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(SETTLE);
  const rest = await look(b);
  await b.hover({ force: true });
  await page.waitForTimeout(SETTLE);
  const hover = await look(b);
  await page.mouse.down();
  await page.waitForTimeout(SETTLE);
  const pressed = await look(b);
  await page.mouse.move(1, 1); // released off the control: a press that ends elsewhere is not a click
  await page.mouse.up();
  await page.mouse.move(1, 1);
  return { rest, hover, pressed };
}

test("a disabled Button shows no hover or pressed change; once enabled it does", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const seed = await seedE2eStudio();
  const [j] = await sql<{ out_result: string }>(`select * from public.set_studio_payment_jurisdiction($1,'CA','cad',$2,$3,false,$4)`, [seed.studioId, "fixture:disabled-button", "Synthetic verified payment currency", `fixture:${seed.runId}`]);
  expect(j?.out_result).toBe("initialized");
  await sql(`update public.studios set cancellation_policy_text=$2, no_show_policy_text='' where id=$1`, [seed.studioId, "Less than 48 hours: 50%. Same-day cancellations: 100%."]);
  const snapshot = async () => (await sql<{ j: string }>(`select to_jsonb(s)::text as j from public.studios s where id = $1`, [seed.studioId]))[0]!.j;
  const before = await snapshot();
  await loginAsOwner(page, seed);
  await page.goto("/settings/payments/fees");
  const card = page.getByRole("region", { name: "Late cancellation fee", exact: true });
  const save = card.getByRole("button", { name: "Save rules", exact: true });
  await expect(save).toBeDisabled();

  const off = await states(page, save);
  expect(off.hover, "a disabled button's hover look equals its rest look").toBe(off.rest);
  expect(off.pressed, "a disabled button's pressed look equals its rest look").toBe(off.rest);
  expect(await save.evaluate((e) => getComputedStyle(e).cursor), "the pointer says not allowed").toBe("not-allowed");

  // typing only: nothing is submitted
  await card.getByRole("spinbutton", { name: "Notice window" }).fill("48");
  await card.locator("#notice-rate-value").fill("50");
  await card.locator("#same-rate-value").fill("100");
  await card.getByText("Review your cancellation policy", { exact: true }).click();
  await card.getByRole("checkbox").check();
  await expect(save).toBeEnabled();
  const on = await states(page, save);
  expect(on.hover, "an enabled button's hover differs from rest").not.toBe(on.rest);
  expect(on.pressed, "an enabled button's pressed look differs from rest").not.toBe(on.rest);
  expect(on.pressed, "and from hover").not.toBe(on.hover);

  expect(await snapshot(), "nothing was saved: the studio row is identical").toBe(before);
});
