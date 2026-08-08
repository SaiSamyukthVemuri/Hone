import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  getIntakeRow,
  mintIntakeToken,
  seedE2eClient,
  seedE2eIntake,
  seedE2eStudio,
  setIntakeCurrentStep,
  sql,
  type E2eSeed,
} from "./helpers/seed";
import { INTAKE_STEPS, TOTAL_STEPS } from "@/lib/intake/questions";
import { INTAKE_CONSENT_RESPONSES } from "@/lib/intake/consent-forms";

// Live consent forms inside the client intake, proven in a real browser
// against the real local database.
//
// DATABASE STATE IS THE ORACLE. Every assertion that matters reads
// client_intake_forms back with getIntakeRow(); on-screen text is asserted
// only where it IS the deliverable — namely that the STUDIO'S OWN consent
// wording is what the client sees, which is the entire point of the feature.
//
// WHAT THESE PROVE
//   A. the primary product journey: real studio text, an unticked treatment
//      checkbox that blocks submission, and a photo DENIAL that completes the
//      form and submits successfully;
//   C. the stale-template race: a client answering v1 after the studio
//      published v2 is refused, and completes after reviewing v2.
//
// WHAT THEY DO NOT PROVE. That any of this is a signature. It is not — no
// typed name is collected anywhere in this flow, and the portal's separate
// signing ceremony is untouched.

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

const TREATMENT_BODY =
  "WILLOW TREATMENT CONSENT. Electrolysis permanently removes hair by treating each follicle individually. Temporary redness, swelling or scabbing can follow a session. I understand a course of treatment is required and that results vary between individuals.";
const PHOTO_BODY =
  "WILLOW PHOTO CONSENT. We photograph treatment areas before and after sessions to track progress. Photographs are stored in your clinical record. You may accept or decline; declining does not affect your treatment in any way.";

// A FRESH STUDIO PER TEST, deliberately.
//
// These journeys assert against "every live consent form this studio has", so
// they cannot share one studio: the forms seeded by the first test would still
// be live in the second, and the gate would correctly demand answers to forms
// that test never rendered. A per-test studio keeps each journey's live-form
// set exactly what it seeded.

// Seed one live consent template for the studio. Mirrors exactly what the
// practitioner-side template management writes: status='active', is_live=true.
async function seedLiveTemplate(
  studioId: string,
  formType: "treatment_consent" | "photo_consent",
  title: string,
  body: string,
): Promise<string> {
  const id = randomUUID();
  await sql(
    `insert into public.consent_form_templates
       (id, studio_id, title, body, form_type, version, status, is_live)
     values ($1,$2,$3,$4,$5,1,'active',true)`,
    [id, studioId, title, body, formType],
  );
  return id;
}

// Exactly what updateConsentTemplateAction does: rewrite the body and bump the
// version, touching neither status nor is_live — so the row stays live and the
// stale race is genuinely reachable.
async function studioEditsTemplate(templateId: string, body: string) {
  await sql(
    `update public.consent_form_templates
        set body = $2, version = version + 1
      where id = $1`,
    [templateId, body],
  );
}

// Seed a real portal signature for the CURRENT text of a template — exactly
// what recordConsentSignature writes, including the typed name that only the
// portal ceremony collects. The intake must READ this and never touch it.
async function seedPortalSignature(
  studioId: string,
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
            encode(digest(t.title || E'\n---\n' || t.body || E'\n---\n' || t.version::text, 'sha256'), 'hex'),
            'Dana Reyes', $4
       from public.consent_form_templates t
      where t.id = $3`,
    [studioId, clientId, templateId, response],
  );
}

async function countSignatures(clientId: string): Promise<number> {
  const rows = await sql<{ n: string }>(
    `select count(*)::int n from public.client_consent_signatures where client_id = $1`,
    [clientId],
  );
  return Number(rows[0]?.n ?? 0);
}

// Every required, unconditional questionnaire answer, so the intake is
// complete except for the consent phase under test.
function answeredQuestionnaire(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const step of INTAKE_STEPS) {
    for (const q of step.questions) {
      if (!q.required || q.conditional) continue;
      if (q.type === "multi_select") out[q.key] = [q.options?.[0]?.value ?? "x"];
      else if (q.type === "checkbox") out[q.key] = true;
      else if (q.type === "single_select") out[q.key] = q.options?.[0]?.value ?? "x";
      else if (q.type === "yes_no") out[q.key] = "no";
      else if (q.type === "date") out[q.key] = "1990-01-01";
      else out[q.key] = "provided";
    }
  }
  return out;
}

// A draft parked on the last questionnaire step with everything answered, so
// one "Continue" reaches the consent phase.
async function seedDraftOnLastStep(seed: E2eSeed): Promise<{
  clientId: string;
  intakeId: string;
  token: string;
}> {
  const { clientId } = await seedE2eClient(seed);
  const intakeId = await seedE2eIntake(
    seed.studioId,
    clientId,
    "in_progress",
    answeredQuestionnaire(),
  );
  await setIntakeCurrentStep(intakeId, TOTAL_STEPS);
  return { clientId, intakeId, token: mintIntakeToken(intakeId) };
}

function storedConsent(row: { responses: Record<string, unknown> } | null) {
  return row?.responses?.[INTAKE_CONSENT_RESPONSES.id] as
    | { version: number; forms: Array<Record<string, unknown>> }
    | undefined;
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const o = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(o.scroll).toBeLessThanOrEqual(o.client + 1);
}

// ---------------------------------------------------------------------------
test.describe("live consent forms in the intake", () => {
  test("A. real studio forms: treatment blocks until ticked, photo DENY completes and submits", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE);
    const seed = await seedE2eStudio();
    await seedLiveTemplate(
      seed.studioId,
      "treatment_consent",
      "Treatment Consent",
      TREATMENT_BODY,
    );
    await seedLiveTemplate(
      seed.studioId,
      "photo_consent",
      "Photo Consent",
      PHOTO_BODY,
    );
    const { intakeId, token } = await seedDraftOnLastStep(seed);

    await page.goto(`/intake/${token}`);
    // Step 5 -> the consent phase.
    await page.getByRole("button", { name: "Continue" }).click();

    // --- the STUDIO'S OWN text is what the client reads
    await expect(
      page.getByRole("heading", { name: "Consent forms" }),
    ).toBeVisible();
    await expect(page.getByText(TREATMENT_BODY)).toBeVisible();
    await expect(page.getByText(PHOTO_BODY)).toBeVisible();
    // Nothing on this surface asks for a signature.
    const body = (await page.locator("body").innerText()).toLowerCase();
    expect(body).not.toContain("signature");
    expect(body).not.toContain("type your full name");
    await expect(page.locator('input[type="text"]')).toHaveCount(0);

    // --- nothing is pre-answered
    const agree = page.getByTestId("intake-consent-agree");
    await expect(agree).not.toBeChecked();
    await expect(page.getByTestId("intake-consent-photo-accepted")).not.toBeChecked();
    await expect(page.getByTestId("intake-consent-photo-denied")).not.toBeChecked();
    await assertNoHorizontalOverflow(page);

    // --- submitting with the treatment box unticked does NOT submit
    await page.getByRole("button", { name: "Submit intake" }).click();
    await expect(page.getByTestId("intake-consent-error").first()).toBeVisible();
    expect((await getIntakeRow(intakeId))?.status).toBe("in_progress");

    // --- tick treatment, choose DENY for photo
    await agree.check();
    await expect(agree).toBeChecked();
    await page.getByTestId("intake-consent-photo-denied").check();

    await page.getByRole("button", { name: "Submit intake" }).click();
    await page.waitForURL("**/intake/thank-you");

    // --- the DENIAL did not block the submission
    const row = await getIntakeRow(intakeId);
    expect(row?.status).toBe("submitted");
    expect(row?.submitted_at).not.toBeNull();

    // --- and the stored record is truthful, with server-owned snapshots
    const consent = storedConsent(row)!;
    expect(consent.version).toBe(1);
    expect(consent.forms).toHaveLength(2);
    const treatment = consent.forms.find(
      (f) => f.form_type === "treatment_consent",
    )!;
    const photo = consent.forms.find((f) => f.form_type === "photo_consent")!;
    expect(treatment.response).toBe("accepted");
    expect(treatment.body_snapshot).toBe(TREATMENT_BODY);
    expect(photo.response).toBe("denied");
    expect(photo.body_snapshot).toBe(PHOTO_BODY);
    // A server clock stamped these, and no signature field exists anywhere.
    expect(typeof treatment.responded_at).toBe("string");
    expect(JSON.stringify(consent)).not.toContain("signature_name");

    // --- no portal signature row was fabricated by any of this
    const sigs = await sql<{ n: string }>(
      `select count(*)::int n from public.client_consent_signatures
        where studio_id = $1`,
      [seed.studioId],
    );
    expect(Number(sigs[0]?.n ?? 0)).toBe(0);
  });

  test("D. a CURRENT portal completion is credited — no duplicate answer demanded", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const seed = await seedE2eStudio();
    const treatmentId = await seedLiveTemplate(
      seed.studioId,
      "treatment_consent",
      "Treatment Consent",
      TREATMENT_BODY,
    );
    const photoId = await seedLiveTemplate(
      seed.studioId,
      "photo_consent",
      "Photo Consent",
      PHOTO_BODY,
    );
    const { clientId, intakeId, token } = await seedDraftOnLastStep(seed);

    // The client already completed BOTH forms in the portal — and DENIED
    // photo use. That denial must survive as a denial.
    await seedPortalSignature(seed.studioId, clientId, treatmentId, "accepted");
    await seedPortalSignature(seed.studioId, clientId, photoId, "denied");
    expect(await countSignatures(clientId)).toBe(2);

    await page.goto(`/intake/${token}`);
    await page.getByRole("button", { name: "Continue" }).click();

    // --- both forms render a read-only completed state...
    await expect(
      page.getByRole("heading", { name: "Consent forms" }),
    ).toBeVisible();
    const completed = page.getByTestId("intake-consent-already-completed");
    await expect(completed).toHaveCount(2);
    // ...the photo denial is shown as Denied, not reset to unanswered...
    await expect(
      page.locator('[data-testid="intake-consent-already-completed"][data-response="denied"]'),
    ).toHaveCount(1);
    // ...and NO duplicate control is offered for either form.
    await expect(page.getByTestId("intake-consent-agree")).toHaveCount(0);
    await expect(page.getByTestId("intake-consent-photo-accepted")).toHaveCount(0);
    await expect(page.getByTestId("intake-consent-photo-denied")).toHaveCount(0);

    // --- submission succeeds with no further consent input
    await page.getByRole("button", { name: "Submit intake" }).click();
    await page.waitForURL("**/intake/thank-you");

    const row = await getIntakeRow(intakeId);
    expect(row?.status).toBe("submitted");
    // Nothing was completed DURING the intake, so no consent record is written.
    expect(storedConsent(row)).toBeUndefined();
    // The portal signatures are untouched: same count, denial intact.
    expect(await countSignatures(clientId)).toBe(2);
    const denied = await sql<{ response: string; signature_name: string }>(
      `select response, signature_name from public.client_consent_signatures
        where client_id = $1 and template_id = $2`,
      [clientId, photoId],
    );
    expect(denied[0].response).toBe("denied");
    expect(denied[0].signature_name).toBe("Dana Reyes");
  });

  test("C. a form edited mid-review is refused, then completes against the current version", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const seed = await seedE2eStudio();
    const templateId = await seedLiveTemplate(
      seed.studioId,
      "treatment_consent",
      "Treatment Consent",
      TREATMENT_BODY,
    );
    const { intakeId, token } = await seedDraftOnLastStep(seed);

    await page.goto(`/intake/${token}`);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText(TREATMENT_BODY)).toBeVisible();

    // The client ticks the box against v1...
    await page.getByTestId("intake-consent-agree").check();

    // ...and the studio publishes v2 while the tab is still open.
    const V2 = "WILLOW TREATMENT CONSENT v2. Revised wording the client has not read.";
    await studioEditsTemplate(templateId, V2);

    // Submitting now must be REFUSED — v1 cannot satisfy v2.
    await page.getByRole("button", { name: "Submit intake" }).click();
    await expect(
      page.getByText("This form changed while you were reviewing it."),
    ).toBeVisible();

    // Nothing was written: no acknowledgement of v2, and no submission.
    let row = await getIntakeRow(intakeId);
    expect(row?.status).toBe("in_progress");
    const draft = storedConsent(row);
    if (draft) {
      // A draft entry may exist, but it must NOT claim the client read v2.
      for (const form of draft.forms) {
        expect(form.body_snapshot).not.toBe(V2);
      }
    }

    // Refreshing shows the CURRENT version...
    await page.goto(`/intake/${token}`);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText(V2)).toBeVisible();
    // ...unticked again, because this is text the client has not yet agreed to.
    await expect(page.getByTestId("intake-consent-agree")).not.toBeChecked();

    await page.getByTestId("intake-consent-agree").check();
    await page.getByRole("button", { name: "Submit intake" }).click();
    await page.waitForURL("**/intake/thank-you");

    row = await getIntakeRow(intakeId);
    expect(row?.status).toBe("submitted");
    const consent = storedConsent(row)!;
    // The stored snapshot is the version the client actually read.
    expect(consent.forms[0].body_snapshot).toBe(V2);
    expect(consent.forms[0].template_version).toBe(2);
    expect(consent.forms[0].response).toBe("accepted");
  });
});
