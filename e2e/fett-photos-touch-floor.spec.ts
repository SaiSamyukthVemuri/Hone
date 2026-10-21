import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  seedE2eStudio,
  seedE2eMember,
  seedE2eClientWithPreviousAreas,
  getOwnerPractitionerId,
  setPractitionerActive,
  sql,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";

// FETT photos (#892, HON-43). Mounted proofs on the treatment-photo surface,
// with SYNTHETIC rows only.
//
// STORAGE-FREE BY DESIGN. CI's browser jobs start Supabase without
// storage-api, so nothing here uploads: the photo is seeded as a metadata row,
// which is all the tiles and the preview need to render their controls. The
// signed-URL and upload DENIALS are proved where they have a definitive
// outcome — tests/db/treatment-image-deactivated-practitioner.db.test.ts — not
// by watching a browser for something NOT to appear.
//
//  1. At phone width with touch emulation, every control on the photo surface
//     measures at least 44px tall: upload panel (picker, attach-as radios,
//     session / treatment-area selects, attach), tile actions, preview close.
//  2. A practitioner DEACTIVATED in the same studio is redirected off the page.
//
// Production has no receptionist role yet (it lives on the unmerged
// STUDIO-READY-02 stack, #838); that denial is proved there, not here.

const T = 20_000;
const FLOOR = 44;

/** A synthetic photo ROW (no object in storage): the tile and preview render from it. */
async function seedPhotoRow(seed: E2eSeed, clientId: string): Promise<string> {
  const id = randomUUID();
  const owner = await getOwnerPractitionerId(seed.studioId);
  await sql(
    `insert into public.treatment_images
       (id, studio_id, client_id, storage_bucket, storage_path, original_filename,
        content_type, size_bytes, uploaded_by)
     values ($1, $2, $3, 'treatment-images', $4, 'synthetic.png', 'image/png', 1024, $5)`,
    [id, seed.studioId, clientId, `${seed.studioId}/${clientId}/${id}.png`, owner],
  );
  return id;
}

/** Height of every visible control on the photo surface, labelled for the report. */
async function controlHeights(page: Page) {
  return page.evaluate(() => {
    const sel = [
      "main button",
      "main select",
      "main textarea",
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
    await seedPhotoRow(seed, clientId);
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/images`);
    await expect(page.getByText("Choose images")).toBeVisible({ timeout: T });

    // Reveal both selects: "Treatment area photo" + a session with charted areas.
    await page.getByLabel("Treatment area photo").check();
    await page.locator("main select").first().selectOption(previousSessionId);
    await expect(page.locator("main select")).toHaveCount(2, { timeout: T });
    // Measure while BOTH selects are shown: switching scope hides them.
    const areaPanel = await controlHeights(page);
    await page.getByLabel("Client photo").check();
    const panel = await controlHeights(page);
    // Native inputs overlay their labels; measure both actual boxes, not Button count.
    for (const name of ["Take a treatment photo", "Choose treatment images"]) {
      const input = page.getByLabel(name, { exact: true });
      for (const target of [input, input.locator("..")]) {
        const box = await target.boundingBox();
        expect(box, `${name} mounted target`).not.toBeNull();
        expect(box!.height, `${name} computed touch height`).toBeGreaterThanOrEqual(FLOOR);
        // The native input needs its own floor: label borders made h-full only42px.
        await expect(target).toHaveCSS("min-height", "44px");
      }
    }
    await page.getByRole("button", { name: "Add note", exact: true }).first().click();
    const noteInput = page.getByPlaceholder("Add a note for this photo…");
    await expect(noteInput).toBeVisible();
    await expect(noteInput).toHaveCSS("min-height", "44px");
    const noteBox = await noteInput.boundingBox();
    expect(noteBox, "opened note editor mounted").not.toBeNull();
    expect(noteBox!.height, "opened note editor computed touch height").toBeGreaterThanOrEqual(FLOOR);
    const editor = await controlHeights(page);
    expect(editor.some((c) => c.what.startsWith("textarea")), "opened note textarea measured").toBe(true);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    // Without storage there is no signed thumbnail, so the image button is not
    // drawn; the tile's own "View larger" action is, and opens the same preview.
    const tile = page.getByRole("button", { name: "View larger", exact: true }).first();
    await expect(tile).toBeVisible({ timeout: T });
    const tiles = await controlHeights(page);

    await tile.click();
    await expect(page.getByRole("button", { name: "Close preview" })).toBeVisible({ timeout: T });
    // A missing storage object must reach a definitive outcome, not merely
    // the initial loading state in which no image has rendered yet.
    const dialog = page.getByRole("dialog", { name: "Treatment photo preview" });
    await expect(dialog.getByText("Image not available", { exact: true })).toBeVisible({ timeout: T });
    await expect(dialog.getByText("Loading preview…", { exact: true })).toHaveCount(0);
    const preview = await controlHeights(page);

    // CLN-006: exercise the mounted dialog's keyboard boundary and restoration
    // in this existing metadata-only fixture (no new browser/session harness).
    const firstPreviewControl = dialog.getByRole("button").first();
    const lastPreviewControl = dialog.getByRole("button").last();
    await expect(page.getByTestId("photo-preview-panel")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(lastPreviewControl).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(firstPreviewControl).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(lastPreviewControl).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(tile).toBeFocused();

    const all = [...areaPanel, ...panel, ...editor, ...tiles, ...preview];
    const under = all.filter((c) => c.height < FLOOR);
    // The surfaces the check claims to cover must actually be in the sample.
    for (const must of [/Take photo/, /Choose images/, /Client photo/, /Treatment area photo/, /Attach/, /View larger/, /Archive/, /Close preview/]) {
      expect(all.some((c) => must.test(c.what)), `measured ${must}`).toBe(true);
    }
    expect(all.filter((c) => c.what.startsWith("select")).length, "both selects measured").toBeGreaterThanOrEqual(2);
    expect(under, `controls under ${FLOOR}px: ${JSON.stringify(under)}`).toEqual([]);
  });
});

test.describe("FETT photos: a deactivated practitioner loses the photo page", () => {
  test("a fresh load is redirected off the photo surface", async ({ page }) => {
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClientWithPreviousAreas(seed);
    await seedPhotoRow(seed, clientId);
    const member = await seedE2eMember(seed);

    // Control: while ACTIVE the member reaches the page.
    await loginByMagicLink(page, member.email);
    await page.goto(`/clients/${clientId}/images`);
    await expect(page.getByText("Choose images")).toBeVisible({ timeout: T });

    await setPractitionerActive(member.practitionerId, false);

    await page.goto(`/clients/${clientId}/images`);
    await expect(page).not.toHaveURL(new RegExp(`/clients/${clientId}/images`), { timeout: T });
    await expect(page.getByText("Choose images")).toHaveCount(0);
  });
});
