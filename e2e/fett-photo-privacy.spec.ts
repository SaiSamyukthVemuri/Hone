import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { seedE2eClientWithPreviousAreas, seedE2eStudio, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { E2E_SUPABASE_URL } from "./helpers/local-env";

// FETT photos (HON-43): a treatment photo is PRIVATE, end to end, and the held identification-photo store stays off. Synthetic image only.
//   1. The owner uploads a visit photo. Its image reaches the page only through the app's signed-url route, which answers with a time-limited storage URL (never cached):
//      the signed URL serves the image (positive control), but the same object without its token, with a tampered token or through the public path does not.
//   2. Another studio's owner and a signed-out visitor get no signed URL and no photo for that image, through the page and through the route.
//   3. The identification-photo store (0375) is off: its bucket is private and empty, no studio has it enabled, the page offers no ID-photo control and no header
//      portrait, and nothing the browser requests touches that bucket or a public object path.
// NEEDS REAL STORAGE (it uploads): it self-skips on a stack without storage-api, as the other photo specs do.
test.use({ bypassCSP: true });

const T = 30_000;

test.beforeAll(async () => {
  const up = await fetch(`${E2E_SUPABASE_URL}/storage/v1/version`).then(
    (r) => r.ok,
    () => false,
  );
  test.skip(!up, "storage-api is not running on this stack (CI browser lanes exclude it)");
});

async function uploadSessionPhoto(page: Page, clientId: string, sessionId: string): Promise<void> {
  const buffer = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#6e6e6e" } }).png().toBuffer();
  await page.goto(`/clients/${clientId}/images`);
  await page.getByRole("radio", { name: "Session photo" }).check();
  await page.locator("main select").first().selectOption(sessionId);
  await page.getByTestId("upload-capture-stage").getByRole("radio", { name: "Before treatment" }).check();
  await page.getByLabel("Choose treatment images", { exact: true }).setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer });
  await page.getByRole("button", { name: /^Attach/ }).click();
  await expect(page.getByText(/✓ Uploaded/)).toBeVisible({ timeout: 120_000 });
}

test("a visit photo is served only through a signed, private URL; another studio and a signed-out visitor get nothing; the identification store stays off", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  const a = await seedE2eStudio();
  const { clientId, previousSessionId } = await seedE2eClientWithPreviousAreas(a);
  const b = await seedE2eStudio();

  // Everything the owner's browser requests while uploading and viewing.
  const requested: string[] = [];
  page.on("request", (r) => requested.push(r.url()));
  await loginAsOwner(page, a);
  await uploadSessionPhoto(page, clientId, previousSessionId);
  const [{ id: imageId }] = await sql<{ id: string }>("select id from public.treatment_images where session_id=$1 and deleted_at is null", [previousSessionId]);
  await page.goto(`/clients/${clientId}/images`);
  await expect(page.getByTestId("capture-stage-badge")).toHaveText("Before", { timeout: T });
  await expect(page.getByRole("button", { name: /Use as ID photo|Remove ID photo/ })).toHaveCount(0);
  await expect(page.getByTestId("client-portrait")).toHaveCount(0);
  await page.goto(`/clients/${clientId}/sessions/${previousSessionId}`);
  await expect(page.getByTestId("session-photos").locator("img")).toHaveCount(1, { timeout: T });

  // ---- 1. signed and private ---------------------------------------------------------------------------------------------------------------------------
  const route = `/api/clients/${clientId}/images/${imageId}/signed-url?variant=thumb`;
  const minted = await page.request.get(route, { maxRedirects: 0 });
  expect(minted.status(), "the owner's mint answers with a signed URL").toBe(200);
  expect(minted.headers()["cache-control"], "a signed URL is never cached").toBe("no-store, private");
  const signed = ((await minted.json()) as { url?: string }).url ?? "";
  expect(signed, "a signed URL with a token").toMatch(/\/storage\/v1\/object\/sign\/treatment-images\/.+\?token=[^&]+/);
  const served = await request.get(signed); // a fresh context: no cookies, so the token alone is what authorises it
  expect(served.status(), "positive control: the signed URL serves the image").toBe(200);
  expect(served.headers()["content-type"] ?? "").toMatch(/^image\//);
  const url = new URL(signed);
  const objectPath = url.pathname.replace("/storage/v1/object/sign/", "");
  const refused = async (label: string, target: string) => {
    const r = await request.get(target);
    expect(r.status(), `${label}: does not serve the image`).toBeGreaterThanOrEqual(400);
    expect(r.headers()["content-type"] ?? "", `${label}: not an image`).not.toMatch(/^image\//);
  };
  await refused("no token", `${E2E_SUPABASE_URL}/storage/v1/object/sign/${objectPath}`);
  await refused("tampered token", signed.replace(/token=([^&]+)/, (_m, t: string) => `token=${t.slice(0, -3)}AAA`));
  await refused("public path", `${E2E_SUPABASE_URL}/storage/v1/object/public/${objectPath}`);
  await refused("authenticated path without a session", `${E2E_SUPABASE_URL}/storage/v1/object/authenticated/${objectPath}`);

  // ---- 2. another studio, and nobody -------------------------------------------------------------------------------------------------------------------
  const other = await browser.newContext({ bypassCSP: true });
  try {
    const p = await other.newPage();
    await loginAsOwner(p, b);
    const crossed = await p.request.get(route, { maxRedirects: 0 });
    expect(crossed.status(), "another studio's owner is refused").not.toBe(200);
    for (const s of [await crossed.text(), crossed.headers()["location"] ?? ""]) expect(s).not.toMatch(/\/storage\/v1\/object\/sign\/|token=/);
    await p.goto(`/clients/${clientId}/images`);
    await expect(p.getByTestId("capture-stage")).toHaveCount(0);
    await expect(p.locator("main img")).toHaveCount(0);
    await expect(p.getByTestId("capture-stage-badge")).toHaveCount(0);
  } finally {
    await other.close();
  }
  const anon = await browser.newContext({ bypassCSP: true });
  try {
    const r = await anon.request.get(route, { maxRedirects: 0 });
    expect(r.status(), "a signed-out visitor is redirected, not served").toBe(307);
    for (const s of [await r.text(), r.headers()["location"] ?? ""]) expect(s).not.toMatch(/\/storage\/v1\/object\/sign\/|token=/);
    expect(new URL(r.headers()["location"] ?? "", "http://x").pathname).toMatch(/login/);
  } finally {
    await anon.close();
  }

  // ---- 3. the identification store (0375) stays off -----------------------------------------------------------------------------------------------------
  const [bucket] = await sql<{ public: boolean }>("select public from storage.buckets where id='client-identification-photos'");
  expect(bucket?.public, "the identification bucket exists and is private").toBe(false);
  expect((await sql("select 1 from storage.objects where bucket_id='client-identification-photos'")).length, "no identification object").toBe(0);
  expect((await sql("select 1 from public.studio_client_id_photo_settings where enabled")).length, "no studio has the identification store on").toBe(0);
  expect(requested.filter((u) => /client-identification-photos|\/object\/public\//.test(u)), "the browser never touched the identification bucket or a public object path").toEqual([]);
});
