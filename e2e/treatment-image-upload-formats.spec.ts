import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { seedE2eStudio, seedE2eClient, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { E2E_SUPABASE_URL } from "./helpers/local-env";

// ENG-002: a browser upload through the Photos tab accepts genuine JPEG, PNG and
// WebP, and refuses SVG and HEIF. HEIF and SVG are refused twice: by the
// browser-side type check when declared honestly, and by the server's byte
// sniff (lib/images/treatment-image-sanitize.ts) when the bytes are sent under
// an allowed type. A refusal stores nothing: no metadata row, no object.
//
// NEEDS REAL STORAGE. CI's browser lanes start Supabase WITHOUT storage-api, so
// this spec SELF-SKIPS there; it runs in the storage photos job, whose
// preflight fails the job before a skip could read as a pass. Synthetic media
// only. bypassCSP for the same reason as fett-photos-thumbnail-recovery: the
// local stack serves storage over http, and the change is to the test browser
// only, never the app.
test.use({ bypassCSP: true });

const CELL = 'main button[aria-label="View larger treatment photo"] img';
const CLIENT_REFUSAL = "Only JPEG, PNG, or WebP images are allowed.";
const SERVER_REFUSAL = "Upload a valid JPEG, PNG, or WebP image.";

test.beforeAll(async () => {
  const up = await fetch(`${E2E_SUPABASE_URL}/storage/v1/version`).then(
    (r) => r.ok,
    () => false,
  );
  test.skip(!up, "storage-api is not running on this stack (CI browser lanes exclude it)");
});

function raster() {
  const w = 320;
  const h = 240;
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) & 0xff;
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } });
}

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#888"/></svg>',
);

// An ISO-BMFF ftyp box with the HEIC brand, the header an iPhone photo starts
// with, followed by filler. It is not decodable; the server must refuse it at
// the container gate, before any decoder runs.
function heicHeader(): Buffer {
  const ftyp = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from("ftypheic", "ascii"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("mif1heic", "ascii"),
  ]);
  return Buffer.concat([ftyp, Buffer.alloc(512, 0x11)]);
}

async function counts(clientId: string) {
  const [row] = await sql<{ rows: number; objects: number }>(
    `select (select count(*)::int from public.treatment_images where client_id = $1) as rows,
            (select count(*)::int from storage.objects
              where bucket_id = 'treatment-images' and name like '%/' || $1 || '/%') as objects`,
    [clientId],
  );
  return row;
}

async function attach(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.locator('input[type="file"][name="file"]').setInputFiles(files);
  await page.getByRole("button", { name: /^Attach/ }).click();
  for (const f of files) {
    await expect(page.locator("form li", { hasText: f.name })).not.toContainText(/Waiting|Uploading/, {
      timeout: 60_000,
    });
  }
}

const status = (page: Page, name: string) => page.locator("form li", { hasText: name });

test("JPEG, PNG and WebP upload; SVG and HEIF are refused and store nothing", async ({ page }) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${clientId}/images`);

  const avif = await raster().heif({ compression: "av1" }).toBuffer();
  // Control: sharp's AVIF output really is a HEIF container (ftyp box), so the
  // refusal below is of a decodable HEIF image, not of garbage.
  expect(avif.toString("ascii", 4, 8)).toBe("ftyp");

  // Refusals first, so the zero counts cannot be hidden by earlier uploads.
  await attach(page, [
    { name: "honest.svg", mimeType: "image/svg+xml", buffer: SVG },
    { name: "honest.heic", mimeType: "image/heic", buffer: heicHeader() },
    { name: "honest.heif", mimeType: "image/heif", buffer: avif },
    { name: "svg-as.png", mimeType: "image/png", buffer: SVG },
    { name: "heic-as.jpg", mimeType: "image/jpeg", buffer: heicHeader() },
    { name: "heif-as.webp", mimeType: "image/webp", buffer: avif },
  ]);
  for (const n of ["honest.svg", "honest.heic", "honest.heif"]) {
    await expect(status(page, n)).toContainText(`✗ ${CLIENT_REFUSAL}`);
  }
  for (const n of ["svg-as.png", "heic-as.jpg", "heif-as.webp"]) {
    await expect(status(page, n)).toContainText(`✗ ${SERVER_REFUSAL}`);
  }
  expect(await counts(clientId)).toEqual({ rows: 0, objects: 0 });
  await expect(page.locator(CELL)).toHaveCount(0);

  await attach(page, [
    { name: "photo.jpg", mimeType: "image/jpeg", buffer: await raster().jpeg().toBuffer() },
    { name: "photo.png", mimeType: "image/png", buffer: await raster().png().toBuffer() },
    { name: "photo.webp", mimeType: "image/webp", buffer: await raster().webp().toBuffer() },
  ]);
  for (const n of ["photo.jpg", "photo.png", "photo.webp"]) {
    await expect(status(page, n)).toContainText("✓ Uploaded");
  }
  await expect(page.locator(CELL)).toHaveCount(3, { timeout: 60_000 });

  const rows = await sql<{ content_type: string; original_filename: string }>(
    `select content_type, original_filename from public.treatment_images
      where client_id = $1 order by original_filename`,
    [clientId],
  );
  expect(rows).toEqual([
    { content_type: "image/jpeg", original_filename: "photo.jpg" },
    { content_type: "image/png", original_filename: "photo.png" },
    { content_type: "image/webp", original_filename: "photo.webp" },
  ]);
  const after = await counts(clientId);
  expect(after.rows).toBe(3);
  // Each original is stored; a grid derivative may be stored beside it.
  expect(after.objects).toBeGreaterThanOrEqual(3);
});
