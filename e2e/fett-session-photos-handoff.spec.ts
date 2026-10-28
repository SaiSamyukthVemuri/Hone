import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { seedE2eStudio, seedE2eMember, seedE2eDraftElectrolysisSession, sql } from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";
import { E2E_SUPABASE_URL } from "./helpers/local-env";

// HON-43: visit photos stay tied to the right visit, in the same order, for
// another authorized practitioner after a reload, and are not reachable from
// another studio. Synthetic data on the owned local stack; needs real storage,
// so it self-skips where storage-api is excluded (CI browser lanes), as the
// other FETT photo specs do. Local storage is HTTP: bypass CSP in this test
// context only.
test.use({ bypassCSP: true });
const T = 30_000;
type Photo = { id: string; storage_path: string; session_id: string | null; created_at: string };

test.beforeAll(async () => {
  const up = await fetch(`${E2E_SUPABASE_URL}/storage/v1/version`).then((r) => r.ok, () => false);
  test.skip(!up, "storage-api is not running on this stack (CI browser lanes exclude it)");
});

const stemOf = (p: Photo) => p.storage_path.replace(/\.[^.]+$/, "");

async function visitPhotos(clientId: string, sessionId: string): Promise<Photo[]> {
  return sql<Photo>(
    `select id, storage_path, session_id, created_at::text from public.treatment_images
      where client_id = $1 and session_id = $2 and deleted_at is null order by created_at asc, id asc`,
    [clientId, sessionId],
  );
}

/** The photo stems rendered on the visit chart, in DOM order. */
async function renderedStems(page: Page, expected: Photo[]): Promise<string[]> {
  const section = page.getByTestId("session-photos");
  await expect(section.locator("img")).toHaveCount(expected.length, { timeout: T });
  return section.locator("img").evaluateAll((imgs) =>
    imgs.map((i) => new URL((i as HTMLImageElement).src).pathname),
  );
}

function orderedAs(paths: string[], photos: Photo[]): boolean {
  const idx = photos.map((p) => paths.findIndex((u) => u.includes(stemOf(p))));
  return idx.every((i) => i >= 0) && idx.every((v, i) => i === 0 || idx[i - 1] < v);
}

test("visit photos keep their visit, their order and their identity for another practitioner; another studio sees none", async ({ browser, page }) => {
  test.setTimeout(300_000);
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  const other = await seedE2eStudio();
  const member = await seedE2eMember(seed);
  await loginAsOwner(page, seed);

  async function upload(colour: string, name: string) {
    await page.goto(`/clients/${clientId}/images`);
    await page.getByRole("radio", { name: "Session photo", exact: true }).check();
    await page.locator("main select").first().selectOption(sessionId);
    const buffer = await sharp({ create: { width: 1200, height: 900, channels: 3, background: colour } }).png().toBuffer();
    await page.locator('input[type="file"][name="file"]').setInputFiles({ name, mimeType: "image/png", buffer });
    await page.getByRole("button", { name: /^Attach/ }).click();
    await expect(page.getByText(/✓ Uploaded/)).toBeVisible({ timeout: 120_000 });
  }

  // Two photos for the visit (first, then second), plus one CLIENT-scoped photo
  // that must never appear on the visit.
  await upload("#426488", "synthetic-first.png");
  await upload("#88a046", "synthetic-second.png");
  await page.goto(`/clients/${clientId}/images`);
  await page.getByRole("radio", { name: "Client photo", exact: true }).check();
  const buf = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#a04688" } }).png().toBuffer();
  await page.locator('input[type="file"][name="file"]').setInputFiles({ name: "synthetic-client.png", mimeType: "image/png", buffer: buf });
  await page.getByRole("button", { name: /^Attach/ }).click();
  await expect(page.getByText(/✓ Uploaded/)).toBeVisible({ timeout: 120_000 });

  const photos = await visitPhotos(clientId, sessionId);
  expect(photos).toHaveLength(2);
  const clientScoped = await sql<Photo>(
    `select id, storage_path, session_id, created_at::text from public.treatment_images where client_id = $1 and session_id is null`,
    [clientId],
  );
  expect(clientScoped).toHaveLength(1);

  // Owner: the chart shows exactly the two visit photos, in order, after a reload.
  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.reload();
  const ownerPaths = await renderedStems(page, photos);
  expect(orderedAs(ownerPaths, photos)).toBe(true);
  expect(ownerPaths.some((u) => u.includes(stemOf(clientScoped[0])))).toBe(false);

  // Another authorized practitioner of the same studio: same photos, same order.
  const ctx = await browser.newContext({ bypassCSP: true });
  try {
    const p2 = await ctx.newPage();
    await loginByMagicLink(p2, member.email);
    await p2.goto(`/clients/${clientId}/sessions/${sessionId}`);
    const memberPaths = await renderedStems(p2, photos);
    expect(orderedAs(memberPaths, photos)).toBe(true);
    expect(memberPaths.some((u) => u.includes(stemOf(clientScoped[0])))).toBe(false);
  } finally {
    await ctx.close();
  }

  // Another studio's owner: the chart is not theirs, and no photo is rendered.
  const ctx2 = await browser.newContext({ bypassCSP: true });
  try {
    const p3 = await ctx2.newPage();
    await loginAsOwner(p3, other);
    await p3.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await expect(p3.getByTestId("session-photos")).toHaveCount(0);
    const html = await p3.content();
    for (const ph of photos) expect(html).not.toContain(stemOf(ph));
    const res = await p3.request.get(`/api/clients/${clientId}/images/${photos[0].id}/signed-url`);
    expect(res.ok()).toBe(false);
  } finally {
    await ctx2.close();
  }
});
