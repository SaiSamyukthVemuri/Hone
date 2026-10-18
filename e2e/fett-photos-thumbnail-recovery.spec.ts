import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { seedE2eStudio, seedE2eClient, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL } from "./helpers/local-env";

// FETT photos (HON-43): Photos-tab grid thumbnails survive a reload AND the
// 60 s signed-URL expiry, with the original-file fallback intact.
//
// Root cause this proves fixed: the grid is loading="lazy" and its signed URLs
// live 60 s, so a cell scrolled into view more than a minute after the page
// rendered asked for an EXPIRED URL and went to "Image not available" (while
// "View larger", which mints per click, still worked).
//
// NEEDS REAL STORAGE. CI's browser jobs start Supabase WITHOUT storage-api, so
// this spec SELF-SKIPS there; its evidence is a local run on a stack with
// storage. Synthetic images only.
//
// The app's CSP allows images only over https: (production Supabase). A local
// stack serves storage over http://127.0.0.1, which the CSP blocks, so the test
// context bypasses CSP. This changes the TEST browser only, never the app.
test.use({ bypassCSP: true });

const T = 30_000;
const CELL = 'main button[aria-label="View larger treatment photo"] img';

test.beforeAll(async () => {
  const up = await fetch(`${E2E_SUPABASE_URL}/storage/v1/version`).then(
    (r) => r.ok,
    () => false,
  );
  test.skip(!up, "storage-api is not running on this stack (CI browser lanes exclude it)");
});

/** A synthetic 1600x1200 PNG with structure, large enough to get a derivative. */
async function syntheticPng(): Promise<Buffer> {
  const w = 1600;
  const h = 1200;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      raw[i] = (x * 255) / w;
      raw[i + 1] = (y * 255) / h;
      raw[i + 2] = (x ^ y) & 0xff;
    }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

async function uploadPhotos(page: Page, clientId: string, n: number) {
  await page.goto(`/clients/${clientId}/images`);
  const png = await syntheticPng();
  await page.locator('input[type="file"][name="file"]').setInputFiles(
    Array.from({ length: n }, (_, i) => ({ name: `synthetic-${i}.png`, mimeType: "image/png", buffer: png })),
  );
  await page.getByRole("button", { name: /^Attach/ }).click();
  await expect(page.locator(CELL)).toHaveCount(n, { timeout: 120_000 });
}

/** Every grid cell: which variant it shows and whether it actually rendered. */
async function cells(page: Page) {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll<HTMLImageElement>(sel)].map((img) => ({
      stage: img.dataset.stage ?? null,
      rendered: img.complete && img.naturalWidth > 0,
    }));
  }, CELL);
}

async function removeObject(path: string) {
  const r = await fetch(`${E2E_SUPABASE_URL}/storage/v1/object/treatment-images`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
      apikey: E2E_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefixes: [path] }),
  });
  expect(r.ok, `delete ${path}`).toBe(true);
}

test("the thumbnail renders after upload and after a HARD reload", async ({ page }) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  await loginAsOwner(page, seed);
  await uploadPhotos(page, clientId, 1);
  await expect.poll(async () => cells(page), { timeout: T }).toEqual([{ stage: "thumb", rendered: true }]);
  await page.reload();
  await expect.poll(async () => cells(page), { timeout: T }).toEqual([{ stage: "thumb", rendered: true }]);
});

test.describe("phone width, many photos", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("cells scrolled into view AFTER the 60 s signed URLs expired still render thumbnails", async ({ page }) => {
    test.setTimeout(300_000);
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    await loginAsOwner(page, seed);
    await uploadPhotos(page, clientId, 8);

    await page.reload();
    await page.waitForLoadState("load");
    // At least one cell must still be DEFERRED (lazy) at this point, or the
    // test would not exercise expiry at all.
    const before = await cells(page);
    expect(before.some((c) => !c.rendered), JSON.stringify(before)).toBe(true);

    // Sit past the 60 s TTL without scrolling, then bring every cell into view.
    await page.waitForTimeout(65_000);
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(300);
    }
    await expect
      .poll(async () => (await cells(page)).filter((c) => c.rendered).length, { timeout: T })
      .toBe(8);
    expect((await cells(page)).every((c) => c.stage === "thumb")).toBe(true);
    await expect(page.getByText("Image not available")).toHaveCount(0);
  });
});

test("no derivative: the ORIGINAL renders; no original either: 'Image not available', never a broken image", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  await loginAsOwner(page, seed);
  await uploadPhotos(page, clientId, 1);
  const [{ storage_path: original }] = await sql<{ storage_path: string }>(
    `select storage_path from public.treatment_images where client_id = $1`,
    [clientId],
  );

  await removeObject(original.replace(/\.[^.]+$/, ".thumb.webp"));
  await page.reload();
  await expect.poll(async () => cells(page), { timeout: T }).toEqual([{ stage: "original", rendered: true }]);

  await removeObject(original);
  await page.reload();
  await expect(page.getByText("Image not available")).toHaveCount(1, { timeout: T });
  await expect(page.locator(CELL)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// BOUNDED PENDING (deterministic; needs no race). The derivative's first signed
// token is refused on every request (true expiry), so the cell must re-mint;
// the re-mint server action (Next-Action POST) is then HELD OPEN, as one that
// never settles. Before bounded pending, a held re-mint stranded the cell on a
// dead URL forever.
// ---------------------------------------------------------------------------

/** Refuse every request carrying the FIRST signed token seen (true expiry). */
async function expireFirstToken(page: Page) {
  let expired: string | null = null;
  await page.route(/\/storage\/v1\/object\/sign\/treatment-images\//, async (route) => {
    const token = new URL(route.request().url()).searchParams.get("token") ?? "";
    if (expired === null) expired = token;
    if (token === expired) return route.fulfill({ status: 400, body: "expired" });
    return route.continue();
  });
}

/** Hold the first `n` server-action POSTs open (never answered); let the rest through. */
async function holdServerActions(page: Page, n: number) {
  const held: Array<() => void> = [];
  let seen = 0;
  await page.route(
    (url) => url.pathname.startsWith("/clients/"),
    async (route) => {
      const req = route.request();
      if (req.method() !== "POST" || !req.headers()["next-action"]) return route.fallback();
      seen += 1;
      if (seen <= n) {
        // Never answered while the test runs; aborted at teardown.
        await new Promise<void>((resolve) => held.push(resolve));
        return route.abort().catch(() => undefined);
      }
      return route.continue();
    },
  );
  return {
    count: () => seen,
    release: () => held.forEach((r) => r()),
  };
}

test("a re-mint that NEVER settles is retried after the timeout, and the cell recovers", async ({ page }) => {
  test.setTimeout(120_000);
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  await loginAsOwner(page, seed);
  await uploadPhotos(page, clientId, 1);

  await expireFirstToken(page);
  const actions = await holdServerActions(page, 1); // attempt 1 hangs; attempt 2 goes through
  await page.reload();
  try {
    // 8 s timeout + the retry's round trip.
    await expect.poll(async () => cells(page), { timeout: 20_000 }).toEqual([{ stage: "thumb", rendered: true }]);
    expect(actions.count()).toBeGreaterThanOrEqual(2);
  } finally {
    actions.release();
  }
});

test("re-mints that NEVER settle twice give up on the derivative: the ORIGINAL renders, never a stuck cell", async ({ page }) => {
  test.setTimeout(120_000);
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  await loginAsOwner(page, seed);
  await uploadPhotos(page, clientId, 1);

  await expireFirstToken(page);
  const actions = await holdServerActions(page, 2); // both derivative attempts hang
  await page.reload();
  try {
    // Two 8 s timeouts, then the server-signed original (a different, valid token).
    await expect.poll(async () => cells(page), { timeout: 30_000 }).toEqual([{ stage: "original", rendered: true }]);
    expect(actions.count()).toBe(2);
    await expect(page.getByText("Image not available")).toHaveCount(0);
  } finally {
    actions.release();
  }
});
