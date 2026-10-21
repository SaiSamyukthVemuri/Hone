import { test, expect, type Page, type Route } from "@playwright/test";
import sharp from "sharp";
import { seedE2eStudio, seedE2eClient, seedNoStudioAuthUser, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN, E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL } from "./helpers/local-env";

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
// the re-mint GET (/api/clients/<c>/images/<i>/signed-url) is then HELD OPEN,
// as one that never settles. It is an abortable request, NOT a server action:
// Next runs a page's server actions one at a time, so a held re-mint ACTION
// queued its own retry and every later action on the page behind it (Codex P1
// 4307807754). Here the retry must be a SECOND request on the wire.
// ---------------------------------------------------------------------------

const REMINT = /\/api\/clients\/[^/]+\/images\/[^/]+\/signed-url\?variant=/;

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

/** Hold the first `n` re-mint GETs open (never answered while the test runs); let the rest through. */
async function holdRemints(page: Page, n: number) {
  const held: Array<() => void> = [];
  let seen = 0;
  await page.route(REMINT, async (route) => {
    seen += 1;
    if (seen <= n) {
      await new Promise<void>((resolve) => held.push(resolve));
      return route.abort().catch(() => undefined);
    }
    return route.continue();
  });
  return {
    count: () => seen,
    release: () => held.forEach((r) => r()),
  };
}

async function imageIdFor(clientId: string): Promise<string> {
  const rows = await sql<{ id: string }>(
    `select id from public.treatment_images where client_id = $1 and deleted_at is null order by created_at limit 1`,
    [clientId],
  );
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

test("a re-mint that NEVER settles is ABORTED and retried as a SECOND request, and the cell recovers", async ({ page }) => {
  test.setTimeout(120_000);
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  await loginAsOwner(page, seed);
  await uploadPhotos(page, clientId, 1);

  await expireFirstToken(page);
  const remints = await holdRemints(page, 1); // attempt 1 hangs; attempt 2 goes through
  await page.reload();
  try {
    // 8 s timeout + the retry's round trip.
    await expect.poll(async () => cells(page), { timeout: 20_000 }).toEqual([{ stage: "thumb", rendered: true }]);
    expect(remints.count()).toBe(2);
  } finally {
    remints.release();
  }
});

test("re-mints that NEVER settle twice give up on the derivative: TWO requests, then the ORIGINAL renders", async ({ page }) => {
  test.setTimeout(120_000);
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  await loginAsOwner(page, seed);
  await uploadPhotos(page, clientId, 1);

  await expireFirstToken(page);
  const remints = await holdRemints(page, 2); // both derivative attempts hang
  await page.reload();
  try {
    // Two 8 s timeouts, then the server-signed original (a different, valid token).
    await expect.poll(async () => cells(page), { timeout: 30_000 }).toEqual([{ stage: "original", rendered: true }]);
    expect(remints.count()).toBe(2);
    await expect(page.getByText("Image not available")).toHaveCount(0);
  } finally {
    remints.release();
  }
});

test("PAGE-WIDE: while a re-mint hangs, a note save on the same page still completes", async ({ page }) => {
  test.setTimeout(120_000);
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  await loginAsOwner(page, seed);
  await uploadPhotos(page, clientId, 1);
  const imageId = await imageIdFor(clientId);

  await expireFirstToken(page);
  const remints = await holdRemints(page, Number.POSITIVE_INFINITY); // every re-mint hangs
  await page.reload();
  try {
    await expect.poll(() => remints.count(), { timeout: T }).toBeGreaterThanOrEqual(1);
    const note = `synthetic note ${Date.now()}`;
    await page.getByRole("button", { name: "Add note" }).click();
    await page.locator("textarea").fill(note);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    // A server action queued behind a hung one would never get here.
    await expect
      .poll(
        async () =>
          (await sql<{ n: string | null }>(`select practitioner_note as n from public.treatment_images where id = $1`, [imageId]))[0]?.n,
        { timeout: 6_000 },
      )
      .toBe(note);
    expect(remints.count()).toBeGreaterThanOrEqual(1); // ...and the re-mint was still held throughout
  } finally {
    remints.release();
  }
});

// ---------------------------------------------------------------------------
// The re-mint route through the REAL session middleware. The route adds no
// middleware exemption, so the existing redirects refuse it before the
// handler runs; the response must carry no signed URL anywhere.
// ---------------------------------------------------------------------------

/**
 * Real magic-link sign-in for an account with NO active practitioner. It lands
 * on /no-access, never /dashboard (as e2e/invite-only.spec.ts asserts), so the
 * shared loginByMagicLink, which waits for /dashboard, cannot be used here.
 */
async function loginWithoutPractitioner(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(email);
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /send magic link/i }).click();
  const link = await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen });
  await page.goto(link);
  await page.waitForURL(/\/no-access/, { timeout: 30_000 });
}

function expectNoSignedUrl(body: string, location: string | undefined) {
  for (const s of [body, location ?? ""]) {
    expect(s).not.toMatch(/\/storage\/v1\/object\/sign\/|token=/);
  }
}

test("re-mint route via the middleware: owner 200 (control); logged-out 307 /login; no-practitioner 307 /no-access", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  await loginAsOwner(page, seed);
  await uploadPhotos(page, clientId, 1);
  const imageId = await imageIdFor(clientId);
  const path = `/api/clients/${clientId}/images/${imageId}/signed-url?variant=thumb`;

  // POSITIVE CONTROL: the owner gets a fresh signed URL, never cached.
  const ok = await page.request.get(path, { maxRedirects: 0 });
  expect(ok.status()).toBe(200);
  expect(ok.headers()["cache-control"]).toBe("no-store, private");
  expect(Object.keys(ok.headers()).filter((k) => k.startsWith("access-control-"))).toEqual([]);
  expect((await ok.json()).url).toMatch(/\/storage\/v1\/object\/sign\/treatment-images\//);

  // LOGGED OUT: a fresh context with no session.
  const anon = await browser.newContext();
  try {
    const r = await anon.request.get(path, { maxRedirects: 0 });
    expect(r.status()).toBe(307);
    expect(new URL(r.headers()["location"]!, "http://x").pathname).toBe("/login");
    expectNoSignedUrl(await r.text(), r.headers()["location"]);
  } finally {
    await anon.close();
  }

  // SIGNED IN, NO ACTIVE PRACTITIONER (how a receptionist or an uninvited
  // account reaches this gate).
  const { email } = await seedNoStudioAuthUser();
  const other = await browser.newContext();
  try {
    const p2 = await other.newPage();
    await loginWithoutPractitioner(p2, email);
    const r = await p2.request.get(path, { maxRedirects: 0 });
    expect(r.status()).toBe(307);
    expect(new URL(r.headers()["location"]!, "http://x").pathname).toBe("/no-access");
    expectNoSignedUrl(await r.text(), r.headers()["location"]);
  } finally {
    await other.close();
  }
});


// CLN-005: reuse this spec's real upload/auth/storage fixture, not a fabricated
// Flight response. Hold real signing replies at the browser boundary. Next
// serializes actions, so B is held AFTER A completes: that makes the stale-A
// render observable while B's metadata is already current.
test("delayed preview replies never cross image identity; close and signing failure stay safe", async ({ page }) => {
  test.setTimeout(180_000);
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  await loginAsOwner(page, seed);
  await uploadPhotos(page, clientId, 2);
  const rows = await sql<{ id: string; storage_path: string }>(
    `select id, storage_path from public.treatment_images where client_id = $1 and deleted_at is null order by created_at desc, id desc`,
    [clientId],
  );
  expect(rows).toHaveLength(2);
  const [b, a] = rows;
  const tiles = page.getByRole("button", { name: "View larger", exact: true });
  const tileA = tiles.last();
  const tileB = tiles.first();
  // Distinguishable current metadata, through the EXISTING note editor/action.
  for (const [tile, note] of [[tileA, "Synthetic preview A"], [tileB, "Synthetic preview B"]] as const) {
    const card = tile.locator("xpath=../..");
    await card.getByRole("button", { name: "Add note", exact: true }).click();
    await card.getByPlaceholder("Add a note for this photo…").fill(note);
    const saved = page.waitForResponse((response) => {
      const request = response.request();
      return request.method() === "POST" && Boolean(request.headers()["next-action"])
        && (request.postData() ?? "").includes(JSON.stringify(note));
    });
    await card.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(card.getByText(note, { exact: true })).toBeVisible({ timeout: T });
  }
  // Note text is optimistic. Settle the saves and read persisted metadata before
  // installing a gate, otherwise a note action can block the queued signer.
  await page.reload();
  await expect(page.getByText("Synthetic preview A", { exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic preview B", { exact: true })).toBeVisible();

  let releaseA!: () => void;
  let releaseB!: () => void;
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
  const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
  let heldA = false;
  let heldB = false;
  let hold = true;
  let refuseA = false;
  const inFlight: Promise<void>[] = [];
  const pattern = `${E2E_APP_ORIGIN}/clients/${clientId}/images*`;
  const handler = (route: Route) => {
    const request = route.request();
    const body = request.postData() ?? "";
    // The signer receives exactly [{ imageId }]. A UUID also appears in note
    // saves, which must never be held behind this preview-only response gate.
    let args: unknown;
    try { args = JSON.parse(body); } catch { return route.continue(); }
    const input: unknown = Array.isArray(args) && args.length === 1 ? args[0] : null;
    const imageId = input !== null && typeof input === "object"
      && Object.keys(input).length === 1 && "imageId" in input ? input.imageId : null;
    const image = imageId === a.id ? "A" : imageId === b.id ? "B" : null;
    if (request.method() !== "POST" || !request.headers()["next-action"] || !image) {
      return route.continue();
    }
    if (refuseA && image === "A") return route.abort("failed");
    if (!hold) return route.continue();
    const pending = (async () => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      if (image === "A") { heldA = true; await gateA; }
      else { heldB = true; await gateB; }
      await route.fulfill({ response }); // one terminal route action, never continue again
    })();
    inFlight.push(pending);
    return pending;
  };
  await page.route(pattern, handler);
  const dialog = page.getByRole("dialog", { name: "Treatment photo preview" });
  try {
    await tileA.click();
    await expect.poll(() => heldA, { timeout: T }).toBe(true);
    await expect(dialog.getByText("Synthetic preview A", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await tileB.click();
    await expect(dialog.getByText("Synthetic preview B", { exact: true })).toBeVisible();
    releaseA();
    await expect.poll(() => heldB, { timeout: T }).toBe(true);
    // Paint after the delivered A result and B's real server round trip. This
    // prevents an initial no-image/loading assertion passing before A settles.
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await expect(dialog.getByText("Loading preview…", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("img")).toHaveCount(0);
    await expect(dialog.getByText("Synthetic preview B", { exact: true })).toBeVisible();
    releaseB();
    const image = dialog.getByRole("img", { name: "Treatment photo", exact: true });
    await expect(image).toBeVisible({ timeout: T });
    await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: T }).toBeGreaterThan(0);
    const src = await image.getAttribute("src");
    expect(decodeURIComponent(new URL(src!, E2E_APP_ORIGIN).pathname)).toContain(b.storage_path);
    expect(src).not.toContain(a.id);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(tileB).toBeFocused();

    hold = false;
    refuseA = true; // deterministic transport rejection, no storage deletion
    await tileA.click();
    await expect(dialog.getByText("Synthetic preview A", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Image not available", { exact: true })).toBeVisible({ timeout: T });
    await expect(dialog.getByText("Loading preview…", { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("img")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  } finally {
    releaseA();
    releaseB();
    await Promise.allSettled(inFlight);
    await page.unroute(pattern, handler);
  }
});

// CLN-006: close before a note refresh commits, then retain the SAME grid
// opener after fresh signed URLs arrive. Real responses/storage, no fake Flight.
test("grid preview opener keeps focus when note refresh commits after close", async ({ page }) => {
  test.setTimeout(180_000);
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  await loginAsOwner(page, seed);
  await uploadPhotos(page, clientId, 1);
  const [row] = await sql<{ id: string }>(
    "select id from public.treatment_images where client_id = $1 and deleted_at is null", [clientId],
  );
  const opener = page.getByRole("button", { name: "View larger treatment photo", exact: true });
  await expect(opener.locator("img")).toBeVisible();
  const oldSrc = await opener.locator("img").getAttribute("src");
  const originalButton = await opener.elementHandle();
  expect(originalButton).not.toBeNull();
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Treatment photo preview" });
  await expect(dialog.getByRole("img", { name: "Treatment photo", exact: true })).toBeVisible();
  // Storage tokens include second-resolution issuance. Ensure the refresh
  // actually changes the URLs, otherwise a URL-keyed remount is not exercised.
  const signingSecond = Math.floor(Date.now() / 1000);
  await expect.poll(() => Math.floor(Date.now() / 1000)).toBeGreaterThan(signingSecond);

  const note = "Synthetic note saved before preview close";
  let releaseNote!: () => void;
  let releaseRefresh!: () => void;
  const noteGate = new Promise<void>((resolve) => { releaseNote = resolve; });
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  let heldNote = false;
  let heldRefresh = false;
  const pending: Promise<void>[] = [];
  const pattern = `${E2E_APP_ORIGIN}/clients/${clientId}/images*`;
  const handler = (route: Route) => {
    const request = route.request();
    const body = request.postData() ?? "";
    const savingNote = request.method() === "POST" && Boolean(request.headers()["next-action"])
      && body.includes(row.id) && body.includes(JSON.stringify(note));
    const refreshing = request.method() === "GET" && request.headers().rsc === "1";
    if (!savingNote && !refreshing) return route.continue();
    const task = (async () => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      if (savingNote) { heldNote = true; await noteGate; }
      else { heldRefresh = true; await refreshGate; }
      await route.fulfill({ response });
    })();
    pending.push(task);
    return task;
  };
  await page.route(pattern, handler);
  try {
    await dialog.getByRole("button", { name: "Add note", exact: true }).click();
    await dialog.getByPlaceholder("Add a note for this photo…").fill(note);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => heldNote, { timeout: T }).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    // The review's race: close sees a CONNECTED opener, before refresh commit.
    await expect.poll(() => originalButton!.evaluate((el) => el.isConnected && el === document.activeElement)).toBe(true);
    releaseNote();
    await expect.poll(() => heldRefresh, { timeout: T }).toBe(true);
    releaseRefresh();
    await Promise.all(pending);
    await expect(page.getByText(note, { exact: true })).toBeVisible();
    await expect.poll(() => opener.locator("img").getAttribute("src")).not.toBe(oldSrc);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(() => originalButton!.evaluate((el) => el.isConnected && el === document.activeElement)).toBe(true);
  } finally {
    releaseNote();
    releaseRefresh();
    await Promise.allSettled(pending);
    await page.unroute(pattern, handler);
  }
});
