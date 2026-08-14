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
// practitioner "Consent forms" section and tested it, but only through the
// projection helper and a source assertion. Neither could see the actual gap,
// which was not in the projection at all:
//
//   * `ConsentSignaturesCard` (the portal signed-consent visibility from #405)
//     is mounted ONLY under the client profile's `overview` tab, and
//   * the intake review page never reads `client_consent_signatures`,
//
// so a client who completed consent in the PORTAL, which is now the only way
// photo consent is collected, showed up on her route as "No consent forms
// were recorded with this intake." A helper test cannot catch a component that
// is mounted on the wrong page. This one navigates the real UI.
//
// It deliberately walks the whole journey (client profile -> Health & Forms ->
// View intake) rather than deep-linking, because the mounting location IS the
// bug under test.

const DESKTOP = { width: 1280, height: 800 };

const PHOTO_BODY = "WILLOW PHOTO CONSENT. We photograph treatment areas to track progress.";

async function seedPhotoTemplate(
  studioId: string,
  opts: { title?: string; isLive?: boolean; body?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await sql(
    `insert into public.consent_form_templates
       (id, studio_id, title, body, form_type, version, status, is_live)
     values ($1,$2,$3,$4,'photo_consent',1,'active',$5)`,
    [
      id,
      studioId,
      opts.title ?? "Photo Consent",
      opts.body ?? PHOTO_BODY,
      opts.isLive ?? true,
    ],
  );
  return id;
}

const seedLivePhotoTemplate = (studioId: string) => seedPhotoTemplate(studioId);

// A real portal signature: the same shape recordConsentSignature writes,
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
    // there, after having denied it in the intake. Both facts must survive.
    const photoTemplateId = await seedLivePhotoTemplate(seed.studioId);
    await seedPortalSignature(seed, clientId, photoTemplateId, "accepted");

    await loginAsOwner(page, seed);

    // --- the real journey, not a deep link
    await page.goto(`/clients/${clientId}`);
    // The desktop profile tabs are <button>s driving a ?tab= query param, not
    // links, the mobile control is a <select>. Both are the same nav.
    await page.getByRole("button", { name: "Health & Forms" }).click();
    await expect(page).toHaveURL(/tab=health/);
    await page.getByRole("link", { name: /View intake/ }).click();
    await page.waitForURL(`**/clients/${clientId}/intake`);

    // --- SECTION 1: the general intake answers Chloe could always see
    await expect(page.getByText("Consent forms").first()).toBeVisible();
    const grid = page.locator("dl");
    await expect(grid.first()).toBeVisible();

    // --- SECTION 2: CURRENT consent. Treatment consent is intake-owned and
    // therefore still current; the intake's historical PHOTO answer is not
    // here at all (it moved to history when #545 sent photo consent to the
    // portal, and the clarity fix is what actually enforces that).
    const recorded = page.getByTestId("intake-review-consent-form");
    await expect(recorded).toHaveCount(1);
    // Treatment reads "Acknowledged": never "Signed".
    await expect(recorded.filter({ hasText: "Treatment Consent" })).toContainText(
      "Acknowledged",
    );

    // --- SECTION 3: the CURRENT portal photo status, in the current block
    const portal = page.getByTestId("review-portal-photo-consent");
    await expect(portal).toBeVisible();
    await expect(page.getByTestId("review-portal-photo-status")).toHaveText(
      "Consent granted",
    );
    await expect(portal).toContainText("Current portal response");
    // The portal block does not claim to be the intake's answer.
    await expect(portal).not.toContainText("Recorded with this intake");

    // --- SECTION 4: the historical intake DENIAL still exists, as history.
    // Preserved verbatim, same answer, same provenance, same stored text.
    const history = page.getByTestId("consent-history-block");
    // Collapsed by default, so expand it the way a practitioner would.
    await history.locator("> summary").click();
    const historyEntry = page.getByTestId("consent-history-entry");
    await expect(historyEntry).toHaveCount(1);
    await expect(historyEntry).toContainText(
      "Photo Consent (as asked during intake)",
    );
    await expect(historyEntry).toContainText("Denied");
    await expect(historyEntry).toContainText("Recorded with this intake");
    // The STORED snapshot is still reachable, one more click in.
    await historyEntry.locator("summary").click();
    await expect(historyEntry).toContainText(
      "The photo consent text the client read at the time.",
    );

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

  test("no portal answer reads as Not completed, never as denied", async ({
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
    // Absence is not denial: the distinction this whole feature turns on.
    await expect(
      page.getByTestId("review-portal-photo-consent"),
    ).not.toContainText("Consent denied");
  });
});

// ---------------------------------------------------------------------------
// The portal-eligibility boundary, in a real browser against the real database.
//
// `status = 'active'` is NOT portal visibility, migration 0072's CHECK still
// permits active + is_live=false, a form the owner activated and deliberately
// hid. The unit tests pin the resolver; this proves the practitioner's SCREEN
// obeys it, which is where the wrong claim would actually be read.
test.describe("View intake reports only forms the client can reach", () => {
  test("an ACTIVE but NOT LIVE photo form produces no portal status at all", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    await seedE2eIntake(seed.studioId, clientId, "submitted", {
      has_allergies: "no",
    });
    await seedPhotoTemplate(seed.studioId, { isLive: false });

    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/intake`);

    // The intake answers still render, the page is fine, the CLAIM is absent.
    await expect(page.getByText("Consent forms").first()).toBeVisible();
    // No status row, and above all no "Not completed" against a form the
    // client cannot open.
    await expect(
      page.getByTestId("review-portal-photo-consent"),
    ).toHaveCount(0);
    await expect(page.getByTestId("review-portal-photo-status")).toHaveCount(0);
  });

  test("TWO live photo forms render independently, with their own answers", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    await seedE2eIntake(seed.studioId, clientId, "submitted", {
      has_allergies: "no",
    });
    const first = await seedPhotoTemplate(seed.studioId, {
      title: "Photo use consent",
    });
    const second = await seedPhotoTemplate(seed.studioId, {
      title: "Treatment photography authorization",
    });
    // Opposite answers, so a collapse into one status could not pass by luck.
    await seedPortalSignature(seed, clientId, first, "denied");
    await seedPortalSignature(seed, clientId, second, "accepted");

    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/intake`);

    const rows = page.getByTestId("review-portal-photo-consent");
    await expect(rows).toHaveCount(2);
    await expect(
      rows.filter({ hasText: "Photo use consent" }),
    ).toContainText("Consent denied");
    await expect(
      rows.filter({ hasText: "Treatment photography authorization" }),
    ).toContainText("Consent granted");
    // Neither answer leaked into the other's row.
    await expect(
      rows.filter({ hasText: "Photo use consent" }),
    ).not.toContainText("Consent granted");
  });

  test("a hidden form alongside a live one leaves only the live one", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    await seedE2eIntake(seed.studioId, clientId, "submitted", {
      has_allergies: "no",
    });
    await seedPhotoTemplate(seed.studioId, {
      title: "Retired photo form",
      isLive: false,
    });
    await seedPhotoTemplate(seed.studioId, { title: "Photo use consent" });

    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/intake`);

    const rows = page.getByTestId("review-portal-photo-consent");
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("Photo use consent");
    await expect(rows).not.toContainText("Retired photo form");
  });
});

// ===========================================================================
// CHLOE'S SCREENSHOT, 2026-08-09, minutes after #545 went live.
//
//   Photo Consent · Accepted   · Recorded with this intake · v2 · 3:56 PM
//   ... full legal body ...
//   CURRENT PORTAL CONSENT STATUS
//   Photo Consent · Consent denied · 3:57 PM
//
// "consent was both accepted and denied" / "this should not be possible" /
// "very confusing" / "hard to find in all the text".
//
// Both records are real and both are KEPT. What these tests pin is that the
// screen has exactly ONE current answer per consent question, that the current
// answer is the portal's, and that the prior answer is visibly history.
//
// The intake record here is stored against the REAL live template id, which is
// what makes supersession provable: a consent template is versioned in place
// (`update ... set version = version + 1 where id = $id`), so a shared
// template_id is the same logical consent question.
// ===========================================================================

const LONG_TREATMENT_BODY = [
  "TREATMENT CONSENT AND RISK DISCLOSURE.",
  "1. NATURE OF TREATMENT. Electrolysis permanently destroys the hair follicle.",
  "2. RISKS. Temporary redness, swelling, scabbing and pigment change may occur.",
  "3. AFTERCARE. Avoid sun exposure and heat for 48 hours following treatment.",
  "4. RESULTS. Multiple sessions are required; individual outcomes vary.",
].join("\n\n");

const LONG_PHOTO_BODY = [
  "PHOTOGRAPHIC CONSENT AND MEDIA RELEASE AGREEMENT.",
  "1. PURPOSE. Clinical photographs document treatment progress over time.",
  "2. STORAGE. Images are retained in the clinical record for seven years.",
  "3. DISCLOSURE. Images are not shared with third parties without consent.",
  "4. WITHDRAWAL. You may withdraw this consent at any time in writing.",
  "5. MARKETING. Separate written permission is required for promotional use.",
].join("\n\n");

async function seedIntakeWithPhotoAnswer(
  seed: E2eSeed,
  clientId: string,
  opts: {
    photoTemplateId: string;
    response: "accepted" | "denied";
    respondedAt?: string | null;
    body?: string;
    version?: number;
  },
) {
  const photo: Record<string, unknown> = {
    template_id: opts.photoTemplateId,
    form_type: "photo_consent",
    template_version: opts.version ?? 2,
    title_snapshot: "Photo Consent",
    body_snapshot: opts.body ?? "The photo consent text the client read.",
    template_hash: "hash-photo",
    response: opts.response,
    response_label_snapshot:
      opts.response === "accepted"
        ? "I consent to photographs."
        : "I do NOT consent to photographs.",
  };
  if (opts.respondedAt !== null) {
    photo.responded_at = opts.respondedAt ?? "2026-08-09T15:56:00.000Z";
  }
  await seedE2eIntake(seed.studioId, clientId, "submitted", {
    has_allergies: "no",
    [INTAKE_CONSENT_RESPONSES.id]: { version: 1, forms: [photo] },
  });
}

async function openReview(page: import("@playwright/test").Page, seed: E2eSeed, clientId: string) {
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${clientId}/intake`);
  await expect(page.getByText("Consent forms").first()).toBeVisible();
}

test.describe("one unmistakable CURRENT consent answer", () => {
  test("CASE 1, historical ACCEPT + current DENY: the screen says DENIED, once", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    const templateId = await seedLivePhotoTemplate(seed.studioId);
    await seedIntakeWithPhotoAnswer(seed, clientId, {
      photoTemplateId: templateId,
      response: "accepted",
      respondedAt: "2026-08-09T15:56:00.000Z",
    });
    await seedPortalSignature(seed, clientId, templateId, "denied");

    await openReview(page, seed, clientId);

    // THE CURRENT BLOCK: denied, and nothing in it says Accepted.
    const current = page.getByTestId("consent-current-block");
    await expect(current).toBeVisible();
    await expect(page.getByTestId("review-portal-photo-status")).toHaveText(
      "Consent denied",
    );
    await expect(current).toContainText("Current portal response");
    // The precise defect Chloe reported: an "Accepted" standing beside a
    // "Consent denied" as though both were current.
    await expect(current).not.toContainText("Accepted");

    // ...and the Accepted is NOT lost. It is history, labelled as history.
    const history = page.getByTestId("consent-history-block");
    await history.locator("> summary").click();
    const entry = page.getByTestId("consent-history-entry");
    await expect(entry).toContainText("Previous response");
    await expect(entry).toContainText("Accepted");
    await expect(entry).toContainText("Recorded with this intake");
    // Supersession is asserted only because the template ids match AND the
    // portal answer is the later one.
    await expect(entry).toHaveAttribute(
      "data-provenance",
      "superseded_by_portal",
    );
    await expect(entry).toContainText("Superseded by a newer portal response");
  });

  test("CASE 2, historical DENY + current ACCEPT: the screen says GRANTED", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    const templateId = await seedLivePhotoTemplate(seed.studioId);
    await seedIntakeWithPhotoAnswer(seed, clientId, {
      photoTemplateId: templateId,
      response: "denied",
    });
    await seedPortalSignature(seed, clientId, templateId, "accepted");

    await openReview(page, seed, clientId);

    const current = page.getByTestId("consent-current-block");
    await expect(page.getByTestId("review-portal-photo-status")).toHaveText(
      "Consent granted",
    );
    // The mirror image: no stale "Denied" competing with the live grant.
    await expect(current).not.toContainText("Denied");

    await page.getByTestId("consent-history-block").locator("> summary").click();
    await expect(page.getByTestId("consent-history-entry")).toContainText(
      "Denied",
    );
  });

  test("CASE 3: same answer twice still yields exactly ONE current answer", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    const templateId = await seedLivePhotoTemplate(seed.studioId);
    await seedIntakeWithPhotoAnswer(seed, clientId, {
      photoTemplateId: templateId,
      response: "accepted",
    });
    await seedPortalSignature(seed, clientId, templateId, "accepted");

    await openReview(page, seed, clientId);

    // One current photo row, not two agreeing ones.
    await expect(page.getByTestId("review-portal-photo-consent")).toHaveCount(1);
    await expect(page.getByTestId("review-portal-photo-status")).toHaveText(
      "Consent granted",
    );
    await page.getByTestId("consent-history-block").locator("> summary").click();
    await expect(page.getByTestId("consent-history-entry")).toHaveCount(1);
  });

  test("CASE 4: a live portal form with NO answer is Not completed, not inherited consent", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    const templateId = await seedLivePhotoTemplate(seed.studioId);
    // The client accepted at intake and has NOT answered in the portal.
    await seedIntakeWithPhotoAnswer(seed, clientId, {
      photoTemplateId: templateId,
      response: "accepted",
    });

    await openReview(page, seed, clientId);

    // Truthful: a historical intake acceptance is NOT current portal consent.
    await expect(page.getByTestId("review-portal-photo-status")).toHaveText(
      "Not completed",
    );
    const current = page.getByTestId("consent-current-block");
    await expect(current).not.toContainText("Consent granted");
    await expect(current).not.toContainText("Accepted");

    // The prior acceptance survives, and is NOT called superseded, nothing
    // superseded it, because nobody answered the portal form.
    await page.getByTestId("consent-history-block").locator("> summary").click();
    const entry = page.getByTestId("consent-history-entry");
    await expect(entry).toContainText("Accepted");
    await expect(entry).toHaveAttribute("data-provenance", "no_longer_collected");
    await expect(entry).not.toContainText("Superseded");
  });

  test("CASE 5: no live photo form at all invents no portal requirement", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    await seedIntakeWithPhotoAnswer(seed, clientId, {
      photoTemplateId: "legacy-photo-template",
      response: "accepted",
    });

    await openReview(page, seed, clientId);

    // No live form -> no current photo row at all, and no "Not completed"
    // blaming the client for a form that does not exist.
    await expect(page.getByTestId("review-portal-photo-consent")).toHaveCount(0);
    await expect(page.getByTestId("review-portal-photo-status")).toHaveCount(0);
    // History remains available.
    await page.getByTestId("consent-history-block").locator("> summary").click();
    await expect(page.getByTestId("consent-history-entry")).toContainText(
      "Accepted",
    );
  });

  test("CASE 6: two live photo templates keep two independent current answers", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    const docs = await seedPhotoTemplate(seed.studioId, {
      title: "Photo documentation",
    });
    const marketing = await seedPhotoTemplate(seed.studioId, {
      title: "Marketing photography",
    });
    // The old intake answer belongs to the MARKETING template specifically.
    await seedIntakeWithPhotoAnswer(seed, clientId, {
      photoTemplateId: marketing,
      response: "accepted",
    });
    await seedPortalSignature(seed, clientId, docs, "denied");
    await seedPortalSignature(seed, clientId, marketing, "accepted");

    await openReview(page, seed, clientId);

    const rows = page.getByTestId("review-portal-photo-consent");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Photo documentation" })).toContainText(
      "Consent denied",
    );
    await expect(rows.filter({ hasText: "Marketing photography" })).toContainText(
      "Consent granted",
    );
    // Not collapsed into one generic photo status.
    await expect(
      rows.filter({ hasText: "Photo documentation" }),
    ).not.toContainText("Consent granted");

    // The history entry is attributed to the template it actually answered.
    await page.getByTestId("consent-history-block").locator("> summary").click();
    const entry = page.getByTestId("consent-history-entry");
    await expect(entry).toHaveCount(1);
    await expect(entry).toHaveAttribute(
      "data-provenance",
      "superseded_by_portal",
    );
  });

  test("CASE 7: long legal text never dominates the scan view", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    const templateId = await seedLivePhotoTemplate(seed.studioId);
    // BOTH a long-bodied TREATMENT form, which is CURRENT and therefore sits
    // in the top block, not inside the collapsed history, and the historical
    // photo answer. Seeding only the photo record made an earlier version of
    // this test vacuous: the sole record body lived inside the collapsed
    // history <details>, so it was invisible whatever its own disclosure did,
    // and expanding every body by default still passed. The treatment record
    // is the one that would actually be dumped on the practitioner.
    await seedE2eIntake(seed.studioId, clientId, "submitted", {
      has_allergies: "no",
      [INTAKE_CONSENT_RESPONSES.id]: {
        version: 1,
        forms: [
          {
            template_id: "tmpl-treatment",
            form_type: "treatment_consent",
            template_version: 1,
            title_snapshot: "Treatment Consent",
            body_snapshot: LONG_TREATMENT_BODY,
            template_hash: "hash-treatment",
            response: "accepted",
            response_label_snapshot: null,
            responded_at: "2026-08-09T15:56:00.000Z",
          },
          {
            template_id: templateId,
            form_type: "photo_consent",
            template_version: 2,
            title_snapshot: "Photo Consent",
            body_snapshot: LONG_PHOTO_BODY,
            template_hash: "hash-photo",
            response: "accepted",
            response_label_snapshot: "I consent to photographs.",
            responded_at: "2026-08-09T15:56:00.000Z",
          },
        ],
      },
    });
    await seedPortalSignature(seed, clientId, templateId, "denied");

    await openReview(page, seed, clientId);

    // The ANSWERS are visible immediately, without opening anything.
    await expect(page.getByTestId("review-portal-photo-status")).toBeVisible();
    await expect(page.getByTestId("review-portal-photo-status")).toHaveText(
      "Consent denied",
    );
    await expect(page.getByTestId("consent-current-status")).toHaveText(
      "Acknowledged",
    );

    // No stored legal body is rendered expanded anywhere on arrival, INCLUDING
    // the current-block treatment record, which is not hidden behind the
    // history collapse and is therefore the one that discriminates.
    const bodies = page.getByTestId("intake-consent-record-body");
    await expect(bodies).not.toHaveCount(0);
    const count = await bodies.count();
    for (let i = 0; i < count; i += 1) {
      await expect(bodies.nth(i)).not.toBeVisible();
    }
    // Present in the DOM: it is preserved history and must never be dropped,
    // but NOT rendered to the practitioner until asked for. Absence would be
    // the wrong contract here; invisibility is the right one.
    await expect(
      page.getByText("PHOTOGRAPHIC CONSENT AND MEDIA RELEASE"),
    ).not.toBeVisible();
    await expect(
      page.getByText("TREATMENT CONSENT AND RISK DISCLOSURE"),
    ).not.toBeVisible();

    // ...and it is still reachable on demand, exactly as stored.
    await page.getByTestId("consent-history-block").locator("> summary").click();
    await page
      .getByTestId("consent-history-entry")
      .locator("summary")
      .click();
    await expect(
      page
        .getByTestId("consent-history-entry")
        .getByTestId("intake-consent-record-body"),
    ).toContainText("PHOTOGRAPHIC CONSENT AND MEDIA RELEASE");
  });
});

// ---------------------------------------------------------------------------
// MOBILE. Chloe reported this from an iPhone, and the ordering defect is worst
// at a phone width where everything stacks into one column: under #545 the
// current answer sat below the historical answer AND its full legal body, so
// it was several screens down.
//
// NOTE ON FIDELITY: the harness engine is mobile-Chromium at 390px, not real
// iOS Safari. It proves layout order and reachability, not Safari rendering.
test.describe("mobile: the current answer is reachable without hunting", () => {
  test("current photo status renders above any historical consent text at 390px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    const templateId = await seedLivePhotoTemplate(seed.studioId);
    await seedIntakeWithPhotoAnswer(seed, clientId, {
      photoTemplateId: templateId,
      response: "accepted",
      body: LONG_PHOTO_BODY,
    });
    await seedPortalSignature(seed, clientId, templateId, "denied");

    await openReview(page, seed, clientId);

    const status = page.getByTestId("review-portal-photo-status");
    await expect(status).toBeVisible();
    await expect(status).toHaveText("Consent denied");

    // ORDER, measured rather than assumed: the current answer must sit above
    // the history disclosure on the page.
    const statusBox = await status.boundingBox();
    const historyBox = await page
      .getByTestId("consent-history-block")
      .boundingBox();
    expect(statusBox).not.toBeNull();
    expect(historyBox).not.toBeNull();
    expect(statusBox!.y).toBeLessThan(historyBox!.y);

    // No horizontal scrolling: the status must be readable as laid out.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflows).toBe(false);

    // The answer is in the FIRST viewport of the consent section, not buried
    // under paragraphs of legal copy.
    const section = await page.getByTestId("consent-current-block").boundingBox();
    expect(section).not.toBeNull();
    expect(statusBox!.y - section!.y).toBeLessThan(844);
  });
});
