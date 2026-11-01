import { test, expect, type Locator, type Page, type Route } from "@playwright/test";
import sharp from "sharp";
import { seedE2eStudio, seedE2eClientWithPreviousAreas, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "./helpers/local-env";

// HON-43 / 0231: distinct from B2 recovery. Real set → replace → remove via UI,
// persisted pointer and rendered header; synthetic data on the owned local stack.
// Requires an OPS heavy slot to EXECUTE. CI without storage self-skips, not passes.
// Local storage is HTTP; bypass CSP in this test context only, as other photo specs do.
test.use({ bypassCSP: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const T = 30_000;
type Photo = { id: string; storage_path: string; session_id: string | null; deleted_at: string | null };

test.beforeAll(async () => {
  const up = await fetch(`${E2E_SUPABASE_URL}/storage/v1/version`).then((r) => r.ok, () => false);
  test.skip(!up, "storage-api is not running on this stack (CI browser lanes exclude it)");
});

async function photos(clientId: string): Promise<Photo[]> {
  return sql<Photo>(
    `select id, storage_path, session_id, deleted_at from public.treatment_images where client_id = $1 order by id`,
    [clientId],
  );
}

async function pointer(clientId: string): Promise<string | null> {
  const rows = await sql<{ portrait_image_id: string | null }>(
    `select portrait_image_id from public.clients where id = $1`, [clientId],
  );
  expect(rows).toHaveLength(1);
  return rows[0].portrait_image_id;
}

function tile(page: Page, photo: Photo): Locator {
  // Match the original OR derivative by their shared storage-path stem. Never
  // depend on grid ordering, timestamps or signed tokens (which change on refresh).
  const stem = photo.storage_path.replace(/\.[^.]+$/, "");
  return page.locator("main div.grid > div").filter({ has: page.locator(`img[src*="${stem}"]`) });
}

async function touchFloor(control: Locator) {
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
}

async function saveWithPending(page: Page, control: Locator, busyLabel: string) {
  // Hold the actual Next action request BEFORE sending it, not a fake success.
  // Release in finally so failed pending assertions cannot strand an action.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  const url = new URL(page.url());
  const pattern = `${url.origin}${url.pathname}*`;
  let actionDone: Promise<void> | undefined;
  const handler = (route: Route) => {
    if (route.request().method() !== "POST" || !route.request().headers()["next-action"]) {
      return route.continue();
    }
    entered = true;
    actionDone = (async () => {
      await gate;
      await route.continue();
    })();
    return actionDone;
  };
  await page.route(pattern, handler);
  try {
    await touchFloor(control);
    await control.click();
    // Bounded by Playwright's assertion timeout, even if no request arrives.
    await expect.poll(() => entered, { timeout: T }).toBe(true);
    const busy = page.getByRole("button", { name: busyLabel, exact: true });
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveAttribute("aria-busy", "true");
  } finally {
    release();
    // unroute changes interception for in-flight requests too. Wait until the
    // held action has actually continued before removing its handler.
    try {
      await actionDone;
    } finally {
      await page.unroute(pattern, handler);
    }
  }
}

// HELD (portrait policy): the app server runs with HONE_CLIENT_PORTRAIT_ENABLED
// = "true" only when the outer process sets it (local-env passes it through),
// so the ON case needs its own server run and the OFF case runs on the default
// server where the variable is absent.
const PORTRAIT_ON = E2E_WEB_SERVER_ENV.HONE_CLIENT_PORTRAIT_ENABLED === "true";

test("ID photo set, replacement and removal persist without archiving the source photos", async ({ page }) => {
  test.skip(!PORTRAIT_ON, "portrait use is OFF on this server (HONE_CLIENT_PORTRAIT_ENABLED is not true)");
  test.setTimeout(300_000);
  const seed = await seedE2eStudio();
  const { clientId, previousSessionId } = await seedE2eClientWithPreviousAreas(seed);
  const [{ name: clientName }] = await sql<{ name: string }>(`select name from public.clients where id = $1`, [clientId]);
  await loginAsOwner(page, seed);

  async function upload(name: string, sessionId?: string): Promise<Photo> {
    const before = new Set((await photos(clientId)).map((p) => p.id));
    await page.goto(`/clients/${clientId}/images`);
    if (sessionId) {
      await page.getByRole("radio", { name: "Session photo", exact: true }).check();
      await page.locator("main select").first().selectOption(sessionId);
    } else {
      await page.getByRole("radio", { name: "Client photo", exact: true }).check();
    }
    const buffer = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: name === "a" ? "#426488" : "#88a046" } }).png().toBuffer();
    await page.locator('input[type="file"][name="file"]').setInputFiles({ name: `synthetic-${name}.png`, mimeType: "image/png", buffer });
    await page.getByRole("button", { name: /^Attach/ }).click();
    await expect(page.getByText(/✓ Uploaded/)).toBeVisible({ timeout: 120_000 });
    const added = (await photos(clientId)).filter((p) => !before.has(p.id));
    expect(added).toHaveLength(1);
    await expect(tile(page, added[0])).toHaveCount(1, { timeout: T });
    return added[0];
  }

  async function headerShows(photo: Photo) {
    await page.goto(`/clients/${clientId}`);
    await page.reload();
    const image = page.getByTestId("client-portrait");
    await expect(image).toHaveAttribute("alt", `ID photo of ${clientName}`);
    // Assert only booleans: signed tokens must not enter assertion output.
    await expect.poll(() => image.evaluate((node, stem) => {
      const img = node as HTMLImageElement;
      return img.complete && img.naturalWidth > 0 && new URL(img.src).pathname.includes(stem);
    }, photo.storage_path.replace(/\.[^.]+$/, "")), { timeout: T }).toBe(true);
  }

  const a = await upload("a");
  const b = await upload("b");
  const visit = await upload("visit", previousSessionId);
  expect(a.session_id).toBeNull();
  expect(b.session_id).toBeNull();
  expect(visit.session_id).toBe(previousSessionId);
  await expect(tile(page, visit).getByRole("button", { name: /Use as ID photo|Remove ID photo/ })).toHaveCount(0);
  await expect(tile(page, b).getByRole("button", { name: "Use as ID photo", exact: true })).toBeVisible();
  expect(await pointer(clientId)).toBeNull();

  await saveWithPending(page, tile(page, a).getByRole("button", { name: "Use as ID photo", exact: true }), "Saving…");
  await expect(tile(page, a).getByTestId("portrait-badge")).toBeVisible({ timeout: T });
  await expect.poll(() => pointer(clientId), { timeout: T }).toBe(a.id);
  await page.reload();
  await expect(tile(page, a).getByRole("button", { name: "Remove ID photo", exact: true })).toBeVisible();
  await headerShows(a);

  await page.goto(`/clients/${clientId}/images`);
  await saveWithPending(page, tile(page, b).getByRole("button", { name: "Use as ID photo", exact: true }), "Saving…");
  await expect(tile(page, b).getByTestId("portrait-badge")).toBeVisible({ timeout: T });
  await expect(tile(page, a).getByTestId("portrait-badge")).toHaveCount(0);
  await expect(page.getByTestId("portrait-badge")).toHaveCount(1);
  await expect.poll(() => pointer(clientId), { timeout: T }).toBe(b.id);
  await headerShows(b);

  await page.goto(`/clients/${clientId}/images`);
  await saveWithPending(page, tile(page, b).getByRole("button", { name: "Remove ID photo", exact: true }), "Removing…");
  await expect(tile(page, b).getByRole("button", { name: "Use as ID photo", exact: true })).toBeVisible({ timeout: T });
  await expect.poll(() => pointer(clientId), { timeout: T }).toBeNull();
  await page.reload();
  await expect(page.getByTestId("portrait-badge")).toHaveCount(0);
  await page.goto(`/clients/${clientId}`);
  await page.reload();
  await expect(page.getByTestId("client-portrait")).toHaveCount(0);
  const remaining = await photos(clientId);
  expect(remaining.map((p) => p.id).sort()).toEqual([a.id, b.id, visit.id].sort());
  expect(remaining.every((p) => p.deleted_at === null)).toBe(true);
});

test("portrait use OFF: no control, no header portrait, the stored pointer is left alone", async ({ page }) => {
  test.skip(PORTRAIT_ON, "this case needs the default server, where portrait use is OFF");
  test.setTimeout(300_000);
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClientWithPreviousAreas(seed);
  await loginAsOwner(page, seed);

  await page.goto(`/clients/${clientId}/images`);
  await page.getByRole("radio", { name: "Client photo", exact: true }).check();
  const buffer = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#426488" } }).png().toBuffer();
  await page.locator('input[type="file"][name="file"]').setInputFiles({ name: "synthetic-off.png", mimeType: "image/png", buffer });
  await page.getByRole("button", { name: /^Attach/ }).click();
  await expect(page.getByText(/✓ Uploaded/)).toBeVisible({ timeout: 120_000 });
  const [photo] = await photos(clientId);
  await expect(tile(page, photo)).toHaveCount(1, { timeout: T });
  await expect(page.getByRole("button", { name: /Use as ID photo|Remove ID photo/ })).toHaveCount(0);

  // A pointer stored before the hold is neither rendered nor cleared. 0275 refuses
  // any non-null write of the pointer, so a legacy one is planted the way a restore
  // would: the owner switches the guard trigger off for this one statement batch.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  expect(photo.id).toMatch(uuid);
  expect(clientId).toMatch(uuid);
  await sql(
    `alter table public.clients disable trigger clients_portrait_pointer_frozen;
     update public.clients set portrait_image_id = '${photo.id}' where id = '${clientId}';
     alter table public.clients enable trigger clients_portrait_pointer_frozen;`,
  );
  await page.goto(`/clients/${clientId}`);
  await page.reload();
  await expect(page.getByTestId("client-portrait")).toHaveCount(0);
  await page.goto(`/clients/${clientId}/images`);
  await expect(page.getByTestId("portrait-badge")).toHaveCount(0);
  expect(await pointer(clientId)).toBe(photo.id);
  expect((await photos(clientId)).every((p) => p.deleted_at === null)).toBe(true);
});
