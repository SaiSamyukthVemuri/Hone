import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  getIntakeRow,
  mintIntakeToken,
  seedE2eClient,
  seedE2eIntake,
  seedE2eStudio,
  setIntakeCurrentStep,
  sql,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { INTAKE_STEPS } from "@/lib/intake/questions";
import { INTAKE_CONSENT_RESPONSES } from "@/lib/intake/consent-forms";

// The diabetes / thyroid subtype conditionals, proven in a real browser.
//
// WHY THIS SPEC EXISTS. The subtype feature is covered exhaustively by unit
// tests that drive the real server actions, but until now NOTHING exercised it
// through the actual intake UI — `grep -rln "diabetes\|thyroid\|medical_conditions" e2e/`
// returned nothing. Unit tests cannot prove that the conditional actually
// renders, that the required marker blocks the client, or that the value the
// client tapped is the value the practitioner later reads.
//
// DELIBERATELY ONE SCENARIO. Exhaustive enum validation is owned by
// tests/lib/intake/diabetes-thyroid-conditionals.test.ts and the two action
// tests; duplicating every canonical value here would buy nothing and cost
// browser minutes. This spec proves only what a browser can prove and unit
// tests cannot:
//
//   1. the subtype control is ABSENT until its parent option is selected;
//   2. it APPEARS when the parent is selected;
//   3. leaving it blank BLOCKS the step through the real required-field UX;
//   4. RETRACTING the parent hides the control and stops rendering the stale
//      value — the browser half of the non-authoritative-stale-child rule;
//   5. the chosen values PERSIST through the current live consent flow,
//      including a photo DENIAL, to a successful submission;
//   6. the practitioner review surface RENDERS both subtypes truthfully.
//
// DATABASE STATE IS THE ORACLE for what was stored, exactly as the sibling
// intake specs do. On-screen text is asserted where the screen IS the
// deliverable: the conditional's presence/absence, the blocking error, and the
// review grid's rendered labels.
//
// SELECTORS ARE THE EXISTING SEMANTIC ONES. `label[for="<key>"]` and
// `#<key>_error` are what IntakeQuestionField already emits for every question,
// and options are real `<button>` elements named by their own label text. No
// data-testid was added for this spec.

const MOBILE = { width: 390, height: 844 };

const TREATMENT_BODY =
  "WILLOW TREATMENT CONSENT. Electrolysis permanently removes hair by treating each follicle individually. I understand a course of treatment is required and that results vary.";
const PHOTO_BODY =
  "WILLOW PHOTO CONSENT. We photograph treatment areas to track progress. You may accept or decline; declining does not affect your treatment in any way.";

// Mirrors what practitioner-side template management writes.
async function seedLiveTemplate(
  studioId: string,
  formType: "treatment_consent" | "photo_consent",
  title: string,
  body: string,
): Promise<void> {
  await sql(
    `insert into public.consent_form_templates
       (id, studio_id, title, body, form_type, version, status, is_live)
     values ($1,$2,$3,$4,$5,1,'active',true)`,
    [randomUUID(), studioId, title, body, formType],
  );
}

// Every required, UNCONDITIONAL answer — so the only thing standing between the
// client and submission is the conditional pair under test. Conditional
// questions are skipped deliberately (the repo-wide fixture convention): this
// scenario selects their parents through the UI instead.
//
// Note `medical_conditions` lands on options[0] = "pregnancy", so the intake
// starts with a condition reported but NEITHER diabetes nor thyroid — which is
// precisely the state assertion (1) needs.
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

// The medical-history step, derived rather than hard-coded as 3 so a renumber
// cannot silently point this spec at the wrong step.
const MEDICAL_STEP = INTAKE_STEPS.find((s) =>
  s.questions.some((q) => q.key === "medical_conditions"),
)!;

test.describe("diabetes / thyroid subtypes through the real intake UI", () => {
  test("absent until reported, required once reported, retractable, and truthful on review", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE);

    // A fresh studio: the consent gate demands an answer for every live form
    // this studio has, so a shared studio would leak another test's forms in.
    const seed = await seedE2eStudio();
    await seedLiveTemplate(seed.studioId, "treatment_consent", "Treatment Consent", TREATMENT_BODY);
    await seedLiveTemplate(seed.studioId, "photo_consent", "Photo Consent", PHOTO_BODY);

    const { clientId } = await seedE2eClient(seed);
    const intakeId = await seedE2eIntake(
      seed.studioId,
      clientId,
      "in_progress",
      answeredQuestionnaire(),
    );
    await setIntakeCurrentStep(intakeId, MEDICAL_STEP.id);

    await page.goto(`/intake/${mintIntakeToken(intakeId)}`);
    await expect(
      page.getByRole("heading", { name: MEDICAL_STEP.title }),
    ).toBeVisible();

    const diabetesOption = page.getByRole("button", { name: "Diabetes", exact: true });
    const thyroidOption = page.getByRole("button", {
      name: "Thyroid disorder (hyper or hypothyroid)",
      exact: true,
    });
    const diabetesSubtype = page.locator('label[for="diabetes_type"]');
    const thyroidSubtype = page.locator('label[for="thyroid_type"]');
    const type1 = page.getByRole("button", { name: "Type 1", exact: true });

    // --- (1) the client has not reported diabetes, so they are not asked which
    // type. The parent option itself is on screen; its child is not.
    await expect(diabetesOption).toBeVisible();
    await expect(diabetesSubtype).toHaveCount(0);
    await expect(thyroidSubtype).toHaveCount(0);

    // --- (2) reporting diabetes asks which type, and marks it required
    await diabetesOption.click();
    await expect(diabetesSubtype).toBeVisible();
    await expect(diabetesSubtype).toContainText("Which type of diabetes?");
    // The required marker is the design system's asterisk inside the label.
    // Asserted as text rather than by class so a restyle cannot silently turn
    // this into a pass that proves nothing.
    await expect(diabetesSubtype).toContainText("*");
    // Reporting diabetes says nothing about the thyroid.
    await expect(thyroidSubtype).toHaveCount(0);

    // --- (3) the required rule BLOCKS the step through the real UX
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator("#diabetes_type_error")).toHaveText(
      "Please answer this question to continue.",
    );
    // Still on the same step, and nothing was persisted by the refused attempt.
    await expect(
      page.getByRole("heading", { name: MEDICAL_STEP.title }),
    ).toBeVisible();
    const blocked = await getIntakeRow(intakeId);
    expect(blocked?.status).toBe("in_progress");
    expect(blocked?.responses).not.toHaveProperty("diabetes_type");

    // --- (4) retraction: answer it, then un-report diabetes entirely.
    await type1.click();
    await expect(diabetesSubtype).toBeVisible();

    await diabetesOption.click(); // toggles the parent option back off
    // The question is gone...
    await expect(diabetesSubtype).toHaveCount(0);
    // ...and so is the answer. A stale value surviving in the response map must
    // never be presented as though the client still stood behind it.
    await expect(type1).toHaveCount(0);
    await expect(page.locator("#diabetes_type_error")).toHaveCount(0);

    // Re-report it and answer for real. `onChange` always SETS (single_select
    // never toggles off), so this click is idempotent whether or not the
    // retracted value is still sitting in component state.
    await diabetesOption.click();
    await expect(diabetesSubtype).toBeVisible();
    await type1.click();

    // --- (5) the thyroid pair behaves identically and independently
    await thyroidOption.click();
    await expect(thyroidSubtype).toBeVisible();
    await expect(thyroidSubtype).toContainText("Which type of thyroid condition?");
    await page.getByRole("button", { name: "Hypothyroidism", exact: true }).click();

    // --- through the remaining questionnaire steps to the consent phase.
    // The consent phase sits one past the last questionnaire step, so from the
    // medical step that is (TOTAL_STEPS - id) + 1 advances. Derived, not the
    // literal 3, so adding a step cannot leave this spec one click short.
    //
    // Every intermediate step is already answered by the seed, so each advance
    // just saves and moves on. The button relabels itself to "Saving..." while
    // the transition is in flight, so waiting for "Continue" to be clickable
    // again is what serialises these — no explicit wait is needed.
    const advancesToConsent = INTAKE_STEPS.length - MEDICAL_STEP.id + 1;
    for (let i = 0; i < advancesToConsent; i++) {
      await page.getByRole("button", { name: "Continue" }).click();
    }

    // --- (6) the CURRENT live consent flow, with a photo DENIAL
    await expect(page.getByRole("heading", { name: "Consent forms" })).toBeVisible();
    await expect(page.getByText(TREATMENT_BODY)).toBeVisible();
    await page.getByTestId("intake-consent-agree").check();
    await page.getByTestId("intake-consent-photo-denied").check();

    await page.getByRole("button", { name: "Submit intake" }).click();
    await page.waitForURL("**/intake/thank-you");

    // --- the durable record: both subtypes stored as their canonical tokens,
    // alongside the parent options that made them applicable.
    const row = await getIntakeRow(intakeId);
    expect(row?.status).toBe("submitted");
    expect(row?.responses.diabetes_type).toBe("type_1");
    expect(row?.responses.thyroid_type).toBe("hypothyroidism");
    expect(row?.responses.medical_conditions).toEqual(
      expect.arrayContaining(["diabetes", "thyroid"]),
    );
    // The denial did not block the submission, and is recorded as a denial.
    const consent = row?.responses[INTAKE_CONSENT_RESPONSES.id] as {
      forms: Array<Record<string, unknown>>;
    };
    expect(
      consent.forms.find((f) => f.form_type === "photo_consent")!.response,
    ).toBe("denied");

    // --- (7) the practitioner reads back exactly what the client chose,
    // as LABELS rather than raw enum tokens.
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/intake`);

    const answerFor = (label: string) =>
      page.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");

    await expect(answerFor("Which type of diabetes?")).toHaveText("Type 1");
    await expect(answerFor("Which type of thyroid condition?")).toHaveText(
      "Hypothyroidism",
    );
    // Neither reads as an omission the client never made.
    await expect(answerFor("Which type of diabetes?")).not.toHaveText(
      "Not collected on this intake",
    );
  });
});
