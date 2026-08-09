import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  seedE2eClient,
  seedE2eIntake,
  seedE2eStudio,
  sql,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { INTAKE_CONSENT_RESPONSES } from "@/lib/intake/consent-forms";

// CHLOE'S ROUTE: Client -> Health & Forms -> View intake.
//
// WHY THIS SPEC EXISTS. Chloe reported "I can see the general intake questions
// but I can't see the answers to the consent forms". PR #529 had shipped a
// practitioner "Consent forms" section and tested it — but only through the
// projection helper and a source assertion. Neither could see the actual gap,
// which was not in the projection at all:
//
//   * `ConsentSignaturesCard` (the portal signed-consent visibility from #405)
//     is mounted ONLY under the client profile's `overview` tab, and
//   * the intake review page never reads `client_consent_signatures`,
//
// so a client who completed consent in the PORTAL — which is now the only way
// photo consent is collected — showed up on her route as "No consent forms
// were recorded with this intake." A helper test cannot catch a component that
// is mounted on the wrong page. This one navigates the real UI.
//
// It deliberately walks the whole journey (client profile -> Health & Forms ->
// View intake) rather than deep-linking, because the mounting location IS the
// bug under test.

const DESKTOP = { width: 1280, height: 800 };

const PHOTO_BODY = "WILLOW PHOTO CONSENT. We photograph treatment areas to track progress.";

async function seedLivePhotoTemplate(studioId: string): Promise<string> {
  const id = randomUUID();
  await sql(
    `insert into public.consent_form_templates
       (id, studio_id, title, body, form_type, version, status, is_live)
     values ($1,$2,'Photo Consent',$3,'photo_consent',1,'active',true)`,
    [id, studioId, PHOTO_BODY],
  );
  return id;
}

// A real portal signature — the same shape recordConsentSignature writes,
// including the typed name only the portal ceremony collects.
async function seedPortalSignature(
  seed: E2eSeed,
  clientId: string,
  templateId: string,
  response: "accepted" | "denied",
): Promise<void> {
  await sql(
    `insert into public.client_consent_signatures
       (id, studio_id, client_id, template_id,
        template_title_snapshot, template_body_snapshot,
        template_version, template_hash, signature_name, response)
     select gen_random_uuid(), $1, $2, t.id, t.title, t.body, t.version,
            encode(digest(t.title || E'\\n---\\n' || t.body || E'\\n---\\n' || t.version::text, 'sha256'), 'hex'),
            'Dana Reyes', $4
       from public.consent_form_templates t
      where t.id = $3`,
    [seed.studioId, clientId, templateId, response],
  );
}

// A submitted intake carrying BOTH a general health answer and the historical
// intake-collected consent record that existed while the intake still asked
// for photo consent.
function submittedResponses() {
  return {
    has_allergies: "no",
    hair_growth_duration: "1_3_years",
    [INTAKE_CONSENT_RESPONSES.id]: {
      version: 1,
      forms: [
        {
          template_id: "legacy-treatment",
          form_type: "treatment_consent",
          template_version: 1,
          title_snapshot: "Treatment Consent",
          body_snapshot: "The treatment consent text the client read at the time.",
          template_hash: "hash-treatment-v1",
          response: "accepted",
          response_label_snapshot: null,
          responded_at: "2026-08-08T10:00:00.000Z",
        },
        {
          template_id: "legacy-photo",
          form_type: "photo_consent",
          template_version: 1,
          title_snapshot: "Photo Consent (as asked during intake)",
          body_snapshot: "The photo consent text the client read at the time.",
          template_hash: "hash-photo-v1",
          response: "denied",
          response_label_snapshot: "I do NOT consent to photographs.",
          responded_at: "2026-08-08T10:00:00.000Z",
        },
      ],
    },
  };
}

test.describe("practitioner View intake shows recorded consent", () => {
  test("Health & Forms -> View intake: health answers, historical intake consent, and CURRENT portal photo status", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    await seedE2eIntake(seed.studioId, clientId, "submitted", submittedResponses());

    // The studio runs photo consent in the PORTAL, and this client GRANTED it
    // there — after having denied it in the intake. Both facts must survive.
    const photoTemplateId = await seedLivePhotoTemplate(seed.studioId);
    await seedPortalSignature(seed, clientId, photoTemplateId, "accepted");

    await loginAsOwner(page, seed);

    // --- the real journey, not a deep link
    await page.goto(`/clients/${clientId}`);
    // The desktop profile tabs are <button>s driving a ?tab= query param, not
    // links — the mobile control is a <select>. Both are the same nav.
    await page.getByRole("button", { name: "Health & Forms" }).click();
    await expect(page).toHaveURL(/tab=health/);
    await page.getByRole("link", { name: /View intake/ }).click();
    await page.waitForURL(`**/clients/${clientId}/intake`);

    // --- SECTION 1: the general intake answers Chloe could always see
    await expect(page.getByText("Consent forms").first()).toBeVisible();
    const grid = page.locator("dl");
    await expect(grid.first()).toBeVisible();

    // --- SECTION 2: the intake's OWN consent record, both forms
    const recorded = page.getByTestId("intake-review-consent-form");
    await expect(recorded).toHaveCount(2);
    // Treatment reads "Acknowledged" — never "Signed".
    await expect(recorded.filter({ hasText: "Treatment Consent" })).toContainText(
      "Acknowledged",
    );
    // The historical photo DENIAL is still shown, and shown as a denial —
    // not as missing, not as unanswered, not as signed.
    const historicalPhoto = recorded.filter({
      hasText: "Photo Consent (as asked during intake)",
    });
    await expect(historicalPhoto).toContainText("Denied");
    await expect(historicalPhoto).toContainText("Recorded with this intake");
    // The STORED snapshot, not today's template text.
    await expect(historicalPhoto).toContainText(
      "The photo consent text the client read at the time.",
    );

    // --- SECTION 3: the CURRENT portal status, as its own source
    const portal = page.getByTestId("review-portal-photo-consent");
    await expect(portal).toBeVisible();
    await expect(page.getByTestId("review-portal-photo-status")).toHaveText(
      "Consent granted",
    );
    await expect(portal).toContainText("Completed in client portal");
    // History is NOT overwritten by it: the intake still says Denied above,
    // and the portal block does not claim to be the intake's answer.
    await expect(portal).not.toContainText("Recorded with this intake");

    // --- the existing signed-record viewer is reused, not rebuilt
    await portal.getByRole("button", { name: "View signed form" }).click();
    await expect(portal).toContainText(PHOTO_BODY);

    // Nothing here calls a checkbox a signature.
    await expect(
      page.getByTestId("intake-review-consent-form").first(),
    ).not.toContainText("Signed");
  });

  test("portal DENY reads as a completed denial, never as missing", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    await seedE2eIntake(seed.studioId, clientId, "submitted", {
      has_allergies: "no",
    });
    const photoTemplateId = await seedLivePhotoTemplate(seed.studioId);
    await seedPortalSignature(seed, clientId, photoTemplateId, "denied");

    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/intake`);

    await expect(page.getByTestId("review-portal-photo-status")).toHaveText(
      "Consent denied",
    );
    const portal = page.getByTestId("review-portal-photo-consent");
    // A denial is an ANSWER. It must not be dressed up as an outstanding task.
    await expect(portal).not.toContainText("Not completed");
    await expect(portal).not.toContainText("Not signed");
  });

  test("no portal answer reads as Not completed — never as denied", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    await seedE2eIntake(seed.studioId, clientId, "submitted", {
      has_allergies: "no",
    });
    await seedLivePhotoTemplate(seed.studioId);

    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/intake`);

    await expect(page.getByTestId("review-portal-photo-status")).toHaveText(
      "Not completed",
    );
    // Absence is not denial — the distinction this whole feature turns on.
    await expect(
      page.getByTestId("review-portal-photo-consent"),
    ).not.toContainText("Consent denied");
  });
});
