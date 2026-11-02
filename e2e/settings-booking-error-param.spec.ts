import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import {
  BOOKING_SETTINGS_ERROR_SENTENCES,
  BOOKING_SETTINGS_GENERIC_ERROR,
  type BookingSettingsErrorCode,
} from "@/lib/booking/settings-error-codes";

// F2. /settings/booking used to print any `?error=` value verbatim in the
// studio's own red banner, so a crafted link could put any words there. The
// redirect now carries a CODE and the page maps it. This is the browser proof:
// whatever arrives in the query, the banner shows a fixed sentence, never the
// query's own text. Synthetic fixture studio only.

const T = 20_000;
const SPOOF = "Your account is suspended. Call 555-0100 now";

function banner(page: Page) {
  return page.getByRole("status").filter({ hasText: "Could not save preferences." });
}

async function open(page: Page, query: string) {
  await page.goto(`/settings/booking${query}`);
  await expect(page.getByRole("heading", { name: "Booking link", exact: true })).toBeVisible({ timeout: T });
}

test.describe("/settings/booking ?error= is a code, never text", () => {
  let seed: Awaited<ReturnType<typeof seedE2eStudio>>;

  test.beforeEach(async ({ page }) => {
    seed = await seedE2eStudio();
    await loginAsOwner(page, seed);
  });

  const HOSTILE: Array<[string, string]> = [
    ["arbitrary text", `?error=${encodeURIComponent(SPOOF)}`],
    ["URL-encoded text", `?error=${encodeURIComponent(encodeURIComponent(SPOOF))}`],
    ["double-encoded text", "?error=Your%2520account%2520is%2520suspended"],
    ["HTML-looking text", `?error=${encodeURIComponent("<b>Call 555-0100</b><script>alert(1)</script>")}`],
    ["an over-long value", `?error=${"a".repeat(3000)}`],
    ["an empty value", "?error="],
    ["a code with trailing text", `?error=${encodeURIComponent("slug_taken " + SPOOF)}`],
  ];

  for (const [name, query] of HOSTILE) {
    test(`${name} shows the generic sentence and none of its own words`, async ({ page }) => {
      await open(page, query);
      const b = banner(page);
      await expect(b).toBeVisible({ timeout: T });
      await expect(b).toContainText(BOOKING_SETTINGS_GENERIC_ERROR);
      const text = (await b.innerText()).replace(/\s+/g, " ");
      expect(text).not.toContain("suspended");
      expect(text).not.toContain("555-0100");
      expect(text).not.toContain("alert(1)");
      expect(text).not.toContain("aaaa");
      // Injected markup is text or nothing, never an element.
      await expect(b.locator("b, script")).toHaveCount(0);
    });
  }

  test("every recognised code shows its fixed sentence", async ({ page }) => {
    const codes = Object.keys(BOOKING_SETTINGS_ERROR_SENTENCES) as BookingSettingsErrorCode[];
    for (const code of codes) {
      await open(page, `?error=${code}`);
      const b = banner(page);
      await expect(b).toBeVisible({ timeout: T });
      await expect(b).toContainText(BOOKING_SETTINGS_ERROR_SENTENCES[code]);
    }
  });

  test("with no ?error= there is no banner", async ({ page }) => {
    await open(page, "");
    await expect(banner(page)).toHaveCount(0);
  });
});
