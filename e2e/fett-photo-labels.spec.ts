import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import {
  createLocalAuthUser,
  seedE2eClientWithPreviousAreas,
  seedE2eStudio,
  sql,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN, E2E_SUPABASE_URL } from "./helpers/local-env";

// FETT photos (HON-43), 0232: the Before/After label, end to end, at phone
// width with touch, the way a practitioner uses it:
//   1. chosen at upload (the summary names it), on the tile, after a HARD
//      reload, and in the visit's "Before" section;
//   2. relabelled with the KEYBOARD: focus stays on the pressed button and the
//      result is announced; the visit moves it to "After";
//   3. cleared with the keyboard: focus moves to "Before", "Label cleared" is
//      announced; the visit is back to one plain grid;
//   4. every control is on the 44 px floor;
//   5. a RECEPTIONIST (0220) is refused the Photos tab and the photo re-mint
//      route: the middleware sends both to /front-desk, with no signed URL.
// The partial-failure note ("label not saved; set it on the photo") is proven
// by tests/app/clients/capture-stage-ui.test.ts: a browser cannot make the
// label command fail honestly.
//
// NEEDS REAL STORAGE (it uploads). CI's browser jobs start Supabase WITHOUT
// storage-api, so this spec SELF-SKIPS there; its evidence is a local run on a
// stack with storage. Synthetic images only.
//
// The app's CSP allows images only over https: (production Supabase); a local
// stack serves storage over http, so the TEST browser bypasses CSP. The app is
// unchanged.
test.use({ bypassCSP: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const T = 30_000;

test.beforeAll(async () => {
  const up = await fetch(`${E2E_SUPABASE_URL}/storage/v1/version`).then(
    (r) => r.ok,
    () => false,
  );
  test.skip(!up, "storage-api is not running on this stack (CI browser lanes exclude it)");
});

async function syntheticPng(): Promise<Buffer> {
  const w = 1600;
  const h = 1200;
  return sharp(Buffer.alloc(w * h * 3, 110), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

async function stageInDb(sessionId: string): Promise<string | null> {
  const rows = await sql<{ capture_stage: string | null }>(
    `select capture_stage from public.treatment_images where session_id = $1 and deleted_at is null`,
    [sessionId],
  );
  expect(rows).toHaveLength(1);
  return rows[0].capture_stage;
}

/** The accessible name of whatever has keyboard focus. */
async function focusedButton(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLButtonElement ? (el.textContent ?? "").trim() : null;
  });
}

async function loginAsReceptionist(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(email);
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /send magic link/i }).click();
  const link = await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen });
  await page.goto(link);
  // A receptionist has no practitioners row: the middleware sends every app
  // route, /dashboard included, to the front desk.
  await page.waitForURL(/\/front-desk/, { timeout: 30_000 });
}

test("a practitioner labels a visit photo at upload, relabels and clears it by keyboard; a receptionist is refused", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const seed = await seedE2eStudio();
  const { clientId, previousSessionId } = await seedE2eClientWithPreviousAreas(seed);
  await loginAsOwner(page, seed);

  // ---- 1. at upload --------------------------------------------------------
  await page.goto(`/clients/${clientId}/images`);
  await page.getByRole("radio", { name: "Session photo" }).check();
  await page.locator("main select").first().selectOption(previousSessionId);
  const choice = page.getByTestId("upload-capture-stage");
  await expect(choice).toBeVisible({ timeout: T });
  for (const r of await choice.getByRole("radio").all()) {
    expect((await r.locator("xpath=..").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  // The summary is located by its testid: a text match also hits the ancestor
  // whose text contains it (Playwright strict mode, round-9 a9545589).
  const summary = page.getByTestId("upload-attach-summary");
  await expect(summary).toHaveText(/^Will attach as: Session photo: Session on [^.]+\.$/);
  await choice.getByRole("radio", { name: "Before treatment" }).check();
  await expect(summary).toHaveText(/^Will attach as: Session photo: Session on [^.]+\. Labelled: Before treatment\.$/);
  await page
    .locator('input[type="file"][name="file"]')
    .setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: await syntheticPng() });
  await page.getByRole("button", { name: /^Attach/ }).click();
  await expect(page.getByText(/✓ Uploaded/)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/label not saved/)).toHaveCount(0);
  const badge = page.getByTestId("capture-stage-badge");
  await expect(badge).toHaveText("Before", { timeout: T });
  expect(await stageInDb(previousSessionId)).toBe("before");

  await page.reload(); // the label is server state
  await expect(badge).toHaveText("Before", { timeout: T });
  await page.goto(`/clients/${clientId}/sessions/${previousSessionId}`);
  await expect(page.getByTestId("session-photos-group-before").locator("img")).toHaveCount(1, { timeout: T });
  await expect(page.getByTestId("session-photos-group-after")).toHaveCount(0);

  // ---- 2. relabel by keyboard ---------------------------------------------
  await page.goto(`/clients/${clientId}/images`);
  const control = page.getByTestId("capture-stage");
  const before = control.getByRole("button", { name: "Before", exact: true });
  const after = control.getByRole("button", { name: "After", exact: true });
  const clear = control.getByRole("button", { name: "Clear label" });
  await expect(before).toHaveAttribute("aria-pressed", "true", { timeout: T });
  // The CURRENT choice stays reachable (never disabled by selection).
  await expect(before).toBeEnabled();
  for (const b of [before, after, clear]) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await after.focus();
  await page.keyboard.press("Space");
  await expect(badge).toHaveText("After", { timeout: T });
  await expect(after).toHaveAttribute("aria-pressed", "true");
  await expect(after).toBeEnabled();
  await expect.poll(() => focusedButton(page), { timeout: T }).toBe("After"); // focus came back
  await expect(page.getByTestId("capture-stage-announce")).toHaveText("Labelled After");
  expect(await stageInDb(previousSessionId)).toBe("after");
  await page.goto(`/clients/${clientId}/sessions/${previousSessionId}`);
  await expect(page.getByTestId("session-photos-group-after").locator("img")).toHaveCount(1, { timeout: T });
  await expect(page.getByTestId("session-photos-group-before")).toHaveCount(0);

  // ---- 3. clear by keyboard -----------------------------------------------
  await page.goto(`/clients/${clientId}/images`);
  await expect(clear).toBeVisible({ timeout: T });
  await clear.focus();
  await page.keyboard.press("Enter");
  await expect(control.getByText("Not labelled")).toBeVisible({ timeout: T });
  await expect(badge).toHaveCount(0);
  await expect(clear).toHaveCount(0);
  await expect.poll(() => focusedButton(page), { timeout: T }).toBe("Before"); // Clear unmounted: focus moved
  await expect(page.getByTestId("capture-stage-announce")).toHaveText("Label cleared");
  expect(await stageInDb(previousSessionId)).toBeNull();
  await page.goto(`/clients/${clientId}/sessions/${previousSessionId}`);
  await expect(page.getByTestId("session-photos").locator("img")).toHaveCount(1, { timeout: T });
  await expect(page.getByTestId("session-photos-group-before")).toHaveCount(0);
  await expect(page.getByTestId("session-photos-group-after")).toHaveCount(0);

  // ---- 5. a receptionist is refused ---------------------------------------
  const imageId = (
    await sql<{ id: string }>(`select id from public.treatment_images where session_id = $1 and deleted_at is null`, [
      previousSessionId,
    ])
  )[0].id;
  const deskEmail = `e2e-desk-labels-${seed.runId}@harness.local`;
  const deskUser = await createLocalAuthUser(deskEmail);
  const owner = (
    await sql<{ id: string }>(`select id from public.practitioners where studio_id = $1 and role = 'owner'`, [seed.studioId])
  )[0].id;
  await sql(`select public.add_studio_receptionist($1, $2, $3, 'Front Desk Labels E2E', $4)`, [
    seed.studioId,
    owner,
    deskUser,
    deskEmail,
  ]);
  const desk = await browser.newContext();
  try {
    const p = await desk.newPage();
    await loginAsReceptionist(p, deskEmail);
    await p.goto(`/clients/${clientId}/images`);
    await expect(p).toHaveURL(/\/front-desk$/);
    await expect(p.getByTestId("capture-stage")).toHaveCount(0);
    const r = await p.request.get(`/api/clients/${clientId}/images/${imageId}/signed-url?variant=thumb`, { maxRedirects: 0 });
    expect(r.status()).toBe(307);
    const location = r.headers()["location"] ?? "";
    expect(new URL(location, "http://x").pathname).toBe("/front-desk");
    for (const s of [await r.text(), location]) expect(s).not.toMatch(/\/storage\/v1\/object\/sign\/|token=/);
  } finally {
    await desk.close();
  }
});
