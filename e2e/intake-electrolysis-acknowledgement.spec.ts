import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  getIntakeRow,
  mintIntakeToken,
  seedE2eClient,
  seedE2eIntake,
  seedE2eStudio,
  setIntakeCurrentStep,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import {
  ACKNOWLEDGEMENT_REVIEW_COPY,
  ELECTROLYSIS_ACKNOWLEDGEMENT as CANON,
} from "@/lib/intake/acknowledgements";
import { INTAKE_STEPS } from "@/lib/intake/questions";

// PR #518: the versioned electrolysis acknowledgement, proven in a real
// browser against the real local database.
//
// DATABASE STATE IS THE ORACLE, exactly as in intake-review-integrity.spec.ts:
// every assertion that matters reads client_intake_forms back with
// getIntakeRow(). On-screen copy is asserted only where the copy IS the
// deliverable, the approved v1 wording, the help text, and the four
// practitioner-facing states, which are the whole point of the feature.
//
// WHY THE WORDING IS NOT WRITTEN OUT HERE. lib/intake/acknowledgements.ts is
// deliberately the only copy of the approved string in the tree, and
// tests/lib/intake/electrolysis-acknowledgement.test.ts pins the LITERAL text
// so an edit without a version bump turns that suite red. Repeating the
// paragraph here would create the third copy that design forbids. This spec
// therefore imports the constant and proves what a unit test cannot: that the
// approved text actually reaches the client's screen, unclipped, at the width
// the operator's clients use.
//
// WHAT THIS IS NOT. An acknowledgement checkbox inside the health intake, not
// consent, not an electronic signature, not clearance to treat. The assertions
// below include that boundary rather than assuming it.

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

const ACK_STEP = 5;
const REQUIRED_ERROR = "Please confirm to continue.";

// Answer every required, unconditional question EXCEPT the acknowledgement, so
// a seeded draft can be parked on the final step with only the box outstanding.
// Generated from INTAKE_STEPS rather than hand-listed: a future required
// question is picked up automatically instead of silently making these tests
// submit-blocked for the wrong reason.
function answeredExceptAcknowledgement(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const step of INTAKE_STEPS) {
    for (const q of step.questions) {
      if (!q.required) continue;
      if (q.conditional) continue; // conditionally hidden is not "missing"
      if (q.key === CANON.questionKey) continue; // the box under test
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

// A draft parked on the Acknowledgments step with everything else answered.
async function seedDraftOnAckStep(
  seed: E2eSeed,
  responses: Record<string, unknown> = {},
): Promise<{ clientId: string; intakeId: string; token: string }> {
  const { clientId } = await seedE2eClient(seed);
  const intakeId = await seedE2eIntake(seed.studioId, clientId, "in_progress", {
    ...answeredExceptAcknowledgement(),
    ...responses,
  });
  await setIntakeCurrentStep(intakeId, ACK_STEP);
  return { clientId, intakeId, token: mintIntakeToken(intakeId) };
}

function ackCheckbox(page: Page): Locator {
  return page.getByRole("checkbox", { name: CANON.wording });
}

// The <section> the practitioner review renders the acknowledgement into,
// resolved from its heading so this never accidentally matches a parent.
function reviewSection(page: Page): Locator {
  return page
    .getByRole("heading", { name: ACKNOWLEDGEMENT_REVIEW_COPY.heading })
    .locator("xpath=ancestor::section[1]");
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const o = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  // 1px rounding tolerance; more than that is a real horizontal scroll.
  expect(o.scroll).toBeLessThanOrEqual(o.client + 1);
}

// Measured in a live layout, a screenshot cannot prove this.
async function assertWithinViewport(
  locator: Locator,
  viewportWidth: number,
  label: string,
): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${label} should be laid out`).not.toBeNull();
  expect(box!.x, `${label} left edge`).toBeGreaterThanOrEqual(-1);
  expect(
    box!.x + box!.width,
    `${label} right edge within ${viewportWidth}px`,
  ).toBeLessThanOrEqual(viewportWidth + 1);
  expect(box!.height, `${label} must have height`).toBeGreaterThan(0);
}

let seed: E2eSeed;

test.beforeAll(async () => {
  seed = await seedE2eStudio();
});

// ---------------------------------------------------------------------------
// A. Client intake, the checkbox itself
// ---------------------------------------------------------------------------

// RETIRED (#518): describes A (client collection), B (390px control) and C
// (control accessibility) drove a checkbox that no longer exists, #529's real
// studio consent forms replaced it and are proven in
// e2e/intake-live-consent-forms.spec.ts. They are removed with the collection
// they covered.
//
// D remains, and matters MORE after retirement: every intake that already
// recorded an acknowledgement must keep rendering its stored wording and
// version forever.

test.describe("D. practitioner review", () => {
  test("D1. renders the STORED wording and version, never today's constant", async ({
    page,
  }) => {
    // THE test that matters. A record written under an older version must
    // render the text that client actually read. If the page substituted the
    // current constant, a practitioner would be told the client agreed to
    // wording they were never shown.
    const OLD_WORDING =
      "Superseded v0 wording: I understand electrolysis takes multiple sessions.";
    const OLD_VERSION = "v0";
    const ACCEPTED_AT = "2026-03-04T15:20:00.000Z";

    const { clientId } = await seedE2eClient(seed);
    await seedE2eIntake(seed.studioId, clientId, "submitted", {
      ...answeredExceptAcknowledgement(),
      [CANON.questionKey]: true,
      [CANON.id]: {
        id: CANON.id,
        version: OLD_VERSION,
        wording: OLD_WORDING,
        accepted: true,
        accepted_at: ACCEPTED_AT,
      },
    });

    await loginAsOwner(page, seed);

    for (const viewport of [DESKTOP, MOBILE]) {
      await page.setViewportSize(viewport);
      await page.goto(`/clients/${clientId}/intake`);

      const section = reviewSection(page);
      await expect(section).toContainText(
        ACKNOWLEDGEMENT_REVIEW_COPY.acknowledged,
      );
      // The stored snapshot.
      await expect(section).toContainText(OLD_WORDING);
      await expect(section).toContainText(`Version ${OLD_VERSION}`);
      // NOT today's constant.
      await expect(section).not.toContainText(CANON.wording);
      await expect(section).not.toContainText(`Version ${CANON.version}`);

      await assertNoHorizontalOverflow(page);
    }

    // The stored acceptance date is shown (rendered in the studio's zone, so
    // assert the date parts rather than an exact formatted string).
    await expect(reviewSection(page)).toContainText("2026");
    await expect(reviewSection(page)).toContainText(/Mar(ch)?/);
  });

  test("D2. a current-version acceptance renders its date", async ({ page }) => {
    const ACCEPTED_AT = "2026-07-15T12:00:00.000Z";
    const { clientId } = await seedE2eClient(seed);
    await seedE2eIntake(seed.studioId, clientId, "reviewed", {
      ...answeredExceptAcknowledgement(),
      [CANON.questionKey]: true,
      [CANON.id]: {
        id: CANON.id,
        version: CANON.version,
        wording: CANON.wording,
        accepted: true,
        accepted_at: ACCEPTED_AT,
      },
    });

    await loginAsOwner(page, seed);
    await page.setViewportSize(DESKTOP);
    await page.goto(`/clients/${clientId}/intake`);

    const section = reviewSection(page);
    await expect(section).toContainText(ACKNOWLEDGEMENT_REVIEW_COPY.acknowledged);
    await expect(section).toContainText(CANON.wording);
    await expect(section).toContainText(`Version ${CANON.version}`);
    await expect(section).toContainText("2026");
    await expect(section).toContainText(/Jul(y)?/);
  });

  test("D3. a submitted intake with no record says so NEUTRALLY, never 'predates'", async ({
    page,
  }) => {
    const { clientId } = await seedE2eClient(seed);
    await seedE2eIntake(seed.studioId, clientId, "submitted", {
      ...answeredExceptAcknowledgement(),
    });

    await loginAsOwner(page, seed);
    await page.setViewportSize(DESKTOP);
    await page.goto(`/clients/${clientId}/intake`);

    const section = reviewSection(page);
    await expect(section).toContainText(ACKNOWLEDGEMENT_REVIEW_COPY.notRecorded);
    // Never dressed up as an acceptance, and never confused with a draft.
    await expect(section).not.toContainText(
      ACKNOWLEDGEMENT_REVIEW_COPY.acknowledged,
    );
    await expect(section).not.toContainText(ACKNOWLEDGEMENT_REVIEW_COPY.noRecord);
  });

  test("D4. an in-progress intake with no record says NO RECORD", async ({
    page,
  }) => {
    const { clientId } = await seedE2eClient(seed);
    await seedE2eIntake(seed.studioId, clientId, "in_progress", {
      ...answeredExceptAcknowledgement(),
    });

    await loginAsOwner(page, seed);
    await page.setViewportSize(DESKTOP);
    await page.goto(`/clients/${clientId}/intake`);

    const section = reviewSection(page);
    await expect(section).toContainText(ACKNOWLEDGEMENT_REVIEW_COPY.noRecord);
    // The two absences are different facts and must never be conflated.
    await expect(section).not.toContainText(ACKNOWLEDGEMENT_REVIEW_COPY.notRecorded);
    await expect(section).not.toContainText(
      ACKNOWLEDGEMENT_REVIEW_COPY.acknowledged,
    );
  });

  test("D5. malformed stored data fails truthfully rather than reading as accepted", async ({
    page,
  }) => {
    const { clientId } = await seedE2eClient(seed);
    await seedE2eIntake(seed.studioId, clientId, "submitted", {
      ...answeredExceptAcknowledgement(),
      [CANON.questionKey]: true,
      // Shaped like an acknowledgement, but not one we wrote.
      [CANON.id]: { id: "something_else", accepted: true },
    });

    await loginAsOwner(page, seed);
    await page.setViewportSize(DESKTOP);
    await page.goto(`/clients/${clientId}/intake`);

    const section = reviewSection(page);
    await expect(section).toContainText(ACKNOWLEDGEMENT_REVIEW_COPY.unreadable);
    await expect(section).not.toContainText(
      ACKNOWLEDGEMENT_REVIEW_COPY.acknowledged,
    );
  });

  test("D6. the section carries the not-consent caveat and offers no way to change the answer", async ({
    page,
  }) => {
    const { clientId } = await seedE2eClient(seed);
    await seedE2eIntake(seed.studioId, clientId, "submitted", {
      ...answeredExceptAcknowledgement(),
      [CANON.questionKey]: true,
      [CANON.id]: {
        id: CANON.id,
        version: CANON.version,
        wording: CANON.wording,
        accepted: true,
        accepted_at: "2026-07-15T12:00:00.000Z",
      },
    });

    await loginAsOwner(page, seed);
    await page.setViewportSize(DESKTOP);
    await page.goto(`/clients/${clientId}/intake`);

    const section = reviewSection(page);
    // The boundary is stated on the practitioner's screen, not just in a comment.
    await expect(section).toContainText(ACKNOWLEDGEMENT_REVIEW_COPY.caveat);

    // No affirmative clinical framing anywhere in the section.
    const text = (await section.innerText()).toLowerCase();
    for (const forbidden of [
      "signature on file",
      "signed by",
      "consent given",
      "consent obtained",
      "cleared to treat",
      "clearance to treat",
      "safe to treat",
      "approved to treat",
    ]) {
      expect(text, `review section must not claim "${forbidden}"`).not.toContain(
        forbidden,
      );
    }

    // A practitioner cannot edit the client's acknowledgement: the section
    // contains no control at all.
    await expect(section.locator("input, textarea, select, button")).toHaveCount(
      0,
    );
  });
});
