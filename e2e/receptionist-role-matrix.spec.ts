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
import { E2E_APP_ORIGIN } from "./helpers/local-env";
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
// THE DENIAL CHAIN, verified by reading the code rather than assumed:
//   app route -> requirePractitionerWithStudio() -> membership "none"
//             -> redirect("/no-access")
//             -> /no-access renders a link to /front-desk for a receptionist
// NOTE the thing that is easy to get wrong: LOGIN lands a receptionist on
// /front-desk (auth/callback routes them there), but DIRECT NAVIGATION to an
// app route lands on /no-access. Asserting /front-desk for a direct navigation
// would be asserting the login flow by accident.
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
  await sql(
    `insert into public.treatment_images
       (id, studio_id, client_id, session_id, session_block_id,
        storage_bucket, storage_path, original_filename, content_type,
        size_bytes, uploaded_by)
     values ($1, $2, $3, $4, null, 'treatment-images', $5, 'e2e.jpg',
        'image/jpeg', 2048, $6)`,
    [imageId, seed.studioId, clientId, session, `${seed.studioId}/${clientId}/${imageId}.jpg`, A.practitionerId],
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

    await page.goto(`/clients/${clientId}/images`);
    // The practitioner gate fired. NOT /front-desk: that is the login landing,
    // and asserting it here would pass without the gate doing anything.
    await page.waitForURL(/\/no-access/, { timeout: 30_000 });

    // The clinical surface did not render on the way past.
    await expect(page.getByRole("heading", { name: /treatment (images|photos)/i })).toHaveCount(0);
    await expect(page.locator(`img[src*="${imageId}"]`)).toHaveCount(0);
    // It is a ROLE redirect, not a generic error: the receptionist's own
    // surface is offered.
    await expect(page.getByRole("link", { name: /front desk/i })).toBeVisible();
  });

  test("the clinical record refuses the same way", async ({ page }) => {
    await loginAsReceptionist(page, deskEmail);
    await page.goto(`/clients/${clientId}`);
    await page.waitForURL(/\/no-access/, { timeout: 30_000 });
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
