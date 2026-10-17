import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  sql,
  seedE2eStudio,
  seedE2eMember,
  seedE2eClient,
  createLocalAuthUser,
  type E2eSeed,
} from "./helpers/seed";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN, E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "./helpers/local-env";
import { loginAsOwner } from "./helpers/flows";

// ===========================================================================
// #824 ROLE MATRIX — the RENDERED half of the receptionist denial.
// ===========================================================================
//
// WHAT THIS SPEC IS FOR, AND WHAT IT IS NOT FOR.
//
// The signing claim is NOT made here. A signed URL is bearer access once it
// exists, so an absent link in the DOM says nothing about whether a URL could
// be minted — the same reason a "no horizontal overflow" assertion cannot fail
// inside an overflow-hidden ancestor. That claim lives at the minting step:
//   * identity (primary)  -> tests/source-guards/photo-signing-sites.test.ts
//   * the row read        -> tests/db/receptionist-photo-denial.db.test.ts
//
// What a browser CAN prove, and nothing else can, is what the human actually
// gets: the practitioner gate fires, the clinical surface never renders, and
// the receptionist is offered their own surface instead of a dead end.
//
// THE DENIAL CHAIN, MEASURED. The MIDDLEWARE refuses first, before the route
// renders at all: lib/supabase/middleware.ts:225-248 — "a receptionist has NO
// practitioners row, so they arrive here with zero memberships. They may reach
// /front-desk and nothing else: every other path is sent to /front-desk" —
// `return NextResponse.redirect(deskUrl)`.
//
// I GOT THIS WRONG FIRST and the run corrected me. I grepped the 58-line
// `middleware.ts`, found no receptionist logic, and concluded the denial was
// requirePractitionerWithStudio() -> /no-access. But middleware.ts only
// delegates to lib/supabase/middleware.ts, which is where the receptionist
// branch lives. /no-access does NOT redirect a receptionist (its front-desk
// link appears only on an invitation issue), so asserting /no-access failed.
// The practitioner gate is the SECOND barrier and never runs here, because the
// middleware never lets the request reach the page.
//
// Which makes this a STRONGER denial than the one I first described: no signed
// URL can be minted because the route is never entered.
//
// Synthetic studio, created per run. Never Willow or production data.

test.describe.configure({ mode: "serial" });

let seed: E2eSeed;
let clientId = "";
let deskEmail = "";
let imageId = "";

async function loginAsReceptionist(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(email);
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /send magic link/i }).click();
  const link = await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen });
  await page.goto(link);
  // Post-login landing: auth/callback sends a receptionist to the front desk.
  await page.waitForURL(/\/front-desk/, { timeout: 30_000 });
}

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  ({ clientId } = await seedE2eClient(seed));
  const A = await seedE2eMember(seed);

  // Clinical content that must exist, so a denial is a denial and not an
  // empty studio. The owner cases below read exactly these rows.
  await sql(
    `insert into public.client_clinical_notes (studio_id, client_id, practitioner_id, kind, body)
     values ($1, $2, $3, 'consultation', 'E2E clinical note: keloid history.')`,
    [seed.studioId, clientId, A.practitionerId],
  );
  const session = (
    await sql<{ id: string }>(
      `insert into public.sessions (studio_id, client_id, practitioner_id, modality)
       values ($1, $2, $3, 'electrolysis') returning id`,
      [seed.studioId, clientId, A.practitionerId],
    )
  )[0].id;
  imageId = randomUUID();
  // UPLOAD A REAL OBJECT, not just the metadata row. Without a byte in the
  // bucket nothing can be signed, the owner's page renders no <img> at all,
  // and the receptionist's "no <img> for this id" would pass VACUOUSLY —
  // satisfied by a photo surface that shows nothing to anybody.
  const objectPath = `${seed.studioId}/${clientId}/${imageId}.jpg`;
  // A 1x1 JPEG, the smallest thing that is genuinely an image.
  const jpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDI0Mv/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAAwDAQACEQMRAD8A/v4oA//Z",
    "base64",
  );
  const put = await fetch(
    `${E2E_SUPABASE_URL}/storage/v1/object/treatment-images/${objectPath}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
        "content-type": "image/jpeg",
      },
      body: jpeg,
    },
  );
  if (!put.ok) throw new Error(`fixture upload failed: ${put.status} ${await put.text()}`);
  await sql(
    `insert into public.treatment_images
       (id, studio_id, client_id, session_id, session_block_id,
        storage_bucket, storage_path, original_filename, content_type,
        size_bytes, uploaded_by)
     values ($1, $2, $3, $4, null, 'treatment-images', $5, 'e2e.jpg',
        'image/jpeg', 2048, $6)`,
    [imageId, seed.studioId, clientId, session, objectPath, A.practitionerId],
  );

  // The receptionist: a real auth user whose ONLY membership is a
  // studio_receptionists row, created by the owner command (0216).
  deskEmail = `e2e-matrix-desk-${seed.runId}@harness.local`;
  const userId = await createLocalAuthUser(deskEmail);
  const owner = (
    await sql<{ id: string }>(
      `select id from public.practitioners where studio_id = $1 and role = 'owner'`,
      [seed.studioId],
    )
  )[0].id;
  await sql(`select public.add_studio_receptionist($1, $2, $3, 'Front Desk Matrix', $4)`, [
    seed.studioId,
    owner,
    userId,
    deskEmail,
  ]);
});

test.describe("a receptionist is denied the clinical surfaces, in the browser", () => {
  test("the photo surface refuses, and offers the front desk instead of a dead end", async ({ page }) => {
    await loginAsReceptionist(page, deskEmail);

    const target = `/clients/${clientId}/images`;
    const response = await page.goto(target);
    // The middleware refused and sent them to their own surface. Walk the
    // REDIRECT CHAIN back to its origin rather than reading
    // response.request().url(), which is the FINAL request after redirects and
    // would read /front-desk — an assertion that passes whether or not the
    // page ever moved.
    let first = response?.request();
    while (first?.redirectedFrom()) first = first.redirectedFrom()!;
    expect(first?.url(), "the redirect chain must START at the photo route").toContain(target);
    await page.waitForURL(/\/front-desk/, { timeout: 30_000 });
    expect(new URL(page.url()).pathname).not.toContain("/images");

    // The clinical surface did not render on the way past.
    await expect(page.getByRole("heading", { name: /treatment (images|photos)/i })).toHaveCount(0);
    await expect(page.locator(`img[src*="${imageId}"]`)).toHaveCount(0);
  });

  test("the clinical record refuses the same way", async ({ page }) => {
    await loginAsReceptionist(page, deskEmail);
    await page.goto(`/clients/${clientId}`);
    await page.waitForURL(/\/front-desk/, { timeout: 30_000 });
    await expect(page.getByText(/keloid history/i)).toHaveCount(0);
  });

  // =========================================================================
  // NON-VACUITY. Every assertion above is satisfied by a broken fixture, a
  // wrong client id, or a studio with no content. The OWNER must reach exactly
  // what the receptionist could not, in the same browser, against the same
  // rows.
  // =========================================================================
  test("THE DENIAL IS NOT VACUOUS: the owner reaches the photo surface and the note", async ({ page }) => {
    await loginAsOwner(page, seed);

    await page.goto(`/clients/${clientId}/images`);
    // The owner is NOT redirected.
    await expect(page).toHaveURL(new RegExp(`/clients/${clientId}/images`));
    // And the seeded image is actually on the page, which is what makes the
    // receptionist's empty result meaningful.
    await expect(page.locator(`img[src*="${imageId}"]`).first()).toBeVisible({ timeout: 30_000 });

    await page.goto(`/clients/${clientId}`);
    await expect(page.getByText(/keloid history/i).first()).toBeVisible({ timeout: 30_000 });
  });
});
