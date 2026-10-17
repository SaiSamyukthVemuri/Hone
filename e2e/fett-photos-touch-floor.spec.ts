import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import {
  seedE2eStudio,
  seedE2eMember,
  seedE2eClientWithPreviousAreas,
  setPractitionerActive,
  sql,
} from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";

// FETT photos (#892, HON-43). Two mounted proofs on the treatment-photo
// surface, with SYNTHETIC images only:
//
//  1. At phone width with touch emulation, every control on the photo surface
//     measures at least 44px tall: upload panel (picker, attach-as radios,
//     session / treatment-area selects, attach), tile actions, preview close.
//     The source-level floor test cannot see layout; this measures it.
//  2. A practitioner DEACTIVATED in the same studio loses the surface at every
//     layer the page touches: the signed URL is refused (RLS hides the row),
//     an upload is refused (the action's practitioner guard), and a reload is
//     redirected off the page (requirePractitionerWithStudio).
//
// Production has no receptionist role yet (it lives on the unmerged
// STUDIO-READY-02 stack, #838); that denial is proved there, not here.

const T = 20_000;
const FLOOR = 44;

async function syntheticPng(shade: string): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 64, channels: 3, background: shade } })
    .png()
    .toBuffer();
}

async function uploadOne(page: Page, name: string, shade: string) {
  await page.locator('input[type="file"][name="file"]').setInputFiles({
    name,
    mimeType: "image/png",
    buffer: await syntheticPng(shade),
  });
  await page.getByRole("button", { name: /attach/i }).click();
  await expect(page.getByText("✓ Uploaded").first()).toBeVisible({ timeout: T });
}

/** Height of every visible control on the photo surface, labelled for the report. */
async function controlHeights(page: Page) {
  return page.evaluate(() => {
    const sel = [
      "main button",
      "main select",
      'main label:has(> input[type="file"])',
      'main label:has(> input[type="radio"])',
      '[aria-label="Treatment photo preview"] button',
    ].join(", ");
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== "hidden";
      })
      .map((el) => ({
        what: `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}"`,
        height: Math.round(el.getBoundingClientRect().height * 10) / 10,
      }));
  });
}

test.describe("FETT photos: touch floor, mounted at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("every photo control measures at least 44px, upload panel through preview", async ({ page }) => {
    const seed = await seedE2eStudio();
    const { clientId, previousSessionId } = await seedE2eClientWithPreviousAreas(seed);
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/images`);
    await expect(page.getByText("Choose images")).toBeVisible({ timeout: T });

    // Reveal both selects: "Treatment area photo" + a session with charted areas.
    await page.getByLabel("Treatment area photo").check();
    await page.locator("main select").first().selectOption(previousSessionId);
    await expect(page.locator("main select")).toHaveCount(2, { timeout: T });
    // Measure while BOTH selects are shown: switching scope hides them.
    const areaPanel = await controlHeights(page);
    // Back to a client photo for the upload, so it never depends on the area list.
    await page.getByLabel("Client photo").check();
    const panel = await controlHeights(page);

    await uploadOne(page, "synthetic-before.png", "#6b6b6b");
    await page.reload();
    const tile = page.getByRole("button", { name: "View larger treatment photo" }).first();
    await expect(tile).toBeVisible({ timeout: T });
    const tiles = await controlHeights(page);

    await tile.click();
    await expect(page.getByRole("button", { name: "Close preview" })).toBeVisible({ timeout: T });
    const preview = await controlHeights(page);

    const all = [...areaPanel, ...panel, ...tiles, ...preview];
    const under = all.filter((c) => c.height < FLOOR);
    // The surfaces the check claims to cover must actually be in the sample.
    for (const must of [/Choose images/, /Client photo/, /Treatment area photo/, /Attach/, /Archive/, /Close preview/]) {
      expect(all.some((c) => must.test(c.what)), `measured ${must}`).toBe(true);
    }
    expect(all.filter((c) => c.what.startsWith("select")).length, "both selects measured").toBeGreaterThanOrEqual(2);
    expect(under, `controls under ${FLOOR}px: ${JSON.stringify(under)}`).toEqual([]);
  });
});

test.describe("FETT photos: a deactivated practitioner loses the photo surface", () => {
  test("signed URL refused, upload refused, page redirected", async ({ page }) => {
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClientWithPreviousAreas(seed);
    const member = await seedE2eMember(seed);

    // While ACTIVE, the member uploads and sees the photo.
    await loginByMagicLink(page, member.email);
    await page.goto(`/clients/${clientId}/images`);
    await uploadOne(page, "synthetic-member.png", "#8a8a8a");
    await page.reload();
    await expect(page.getByRole("button", { name: "View larger treatment photo" }).first()).toBeVisible({ timeout: T });
    const rows = await sql<{ n: string }>(
      "select count(*)::text as n from public.treatment_images where studio_id = $1 and client_id = $2 and deleted_at is null",
      [seed.studioId, clientId],
    );
    expect(rows[0].n).toBe("1");

    // Deactivate, then use the page already loaded in the browser.
    await setPractitionerActive(member.practitionerId, false);

    // 1. Signed URL: RLS no longer shows the row, so the preview has no image.
    await page.getByRole("button", { name: "View larger treatment photo" }).first().click();
    const preview = page.getByRole("dialog", { name: "Treatment photo preview" }).or(
      page.locator('[aria-label="Treatment photo preview"]'),
    );
    await expect(preview).toBeVisible({ timeout: T });
    await expect(preview.locator("img")).toHaveCount(0, { timeout: T });
    await page.getByRole("button", { name: "Close preview" }).click();

    // 2. Upload: the action's practitioner guard refuses; nothing new is stored.
    await page.locator('input[type="file"][name="file"]').setInputFiles({
      name: "synthetic-after-deactivation.png",
      mimeType: "image/png",
      buffer: await syntheticPng("#9a9a9a"),
    });
    await page.getByRole("button", { name: /attach/i }).click();
    await expect(page.getByText("✓ Uploaded")).toHaveCount(0, { timeout: T });
    const after = await sql<{ n: string }>(
      "select count(*)::text as n from public.treatment_images where studio_id = $1 and client_id = $2",
      [seed.studioId, clientId],
    );
    expect(after[0].n, "no image stored after deactivation").toBe("1");

    // 3. Page: a fresh load is redirected off the photo surface.
    await page.goto(`/clients/${clientId}/images`);
    await expect(page).not.toHaveURL(new RegExp(`/clients/${clientId}/images`), { timeout: T });
    await expect(page.getByText("Choose images")).toHaveCount(0);
  });
});
