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

// PR #518 — the versioned electrolysis acknowledgement, proven in a real
// browser against the real local database.
//
// DATABASE STATE IS THE ORACLE, exactly as in intake-review-integrity.spec.ts:
// every assertion that matters reads client_intake_forms back with
// getIntakeRow(). On-screen copy is asserted only where the copy IS the
// deliverable — the approved v1 wording, the help text, and the four
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
// WHAT THIS IS NOT. An acknowledgement checkbox inside the health intake — not
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

// Measured in a live layout — a screenshot cannot prove this.
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
// A. Client intake — the checkbox itself
// ---------------------------------------------------------------------------

test.describe("A. client intake acknowledgement", () => {
  test("A1. renders on the Acknowledgments step, unchecked, with the approved wording and help text", async ({
    page,
  }) => {
    const { intakeId, token } = await seedDraftOnAckStep(seed);

    await page.setViewportSize(DESKTOP);
    await page.goto(`/intake/${token}`);

    // The step the acknowledgement belongs to, by its own heading.
    await expect(
      page.getByRole("heading", { name: "Acknowledgments" }),
    ).toBeVisible();

    const box = ackCheckbox(page);
    await expect(box).toBeVisible();
    // THE default. Nothing on the way in ticks it.
    await expect(box).not.toBeChecked();

    // The approved v1 text, on screen, in full.
    await expect(page.getByText(CANON.wording, { exact: false })).toBeVisible();
    await expect(page.getByText(CANON.helpText, { exact: false })).toBeVisible();

    // ORACLE: opening the step wrote no acknowledgement record at all.
    const row = await getIntakeRow(intakeId);
    expect(row?.status).toBe("in_progress");
    expect((row?.responses as Record<string, unknown>)[CANON.id]).toBeUndefined();
    expect(
      (row?.responses as Record<string, unknown>)[CANON.questionKey],
    ).toBeUndefined();
  });

  test("A2. submitting while unticked is refused, and writes nothing", async ({
    page,
  }) => {
    const { intakeId, token } = await seedDraftOnAckStep(seed);

    await page.setViewportSize(DESKTOP);
    await page.goto(`/intake/${token}`);
    await expect(ackCheckbox(page)).not.toBeChecked();

    await page.getByRole("button", { name: "Submit intake" }).click();

    // Refused, and said so where a screen reader will hear it.
    const err = page.getByRole("alert").filter({ hasText: REQUIRED_ERROR });
    await expect(err).toBeVisible();

    // Still on the wizard — no navigation to the thank-you page.
    await expect(page).not.toHaveURL(/thank-you/);

    // ORACLE: nothing was submitted and nothing was recorded.
    const row = await getIntakeRow(intakeId);
    expect(row?.status).toBe("in_progress");
    expect(row?.submitted_at).toBeNull();
    expect((row?.responses as Record<string, unknown>)[CANON.id]).toBeUndefined();
  });

  test("A3. ticking then submitting stores the canonical record with a server timestamp", async ({
    page,
  }) => {
    const { intakeId, token } = await seedDraftOnAckStep(seed);

    await page.setViewportSize(DESKTOP);
    await page.goto(`/intake/${token}`);

    const before = Date.now();
    await ackCheckbox(page).check();
    await expect(ackCheckbox(page)).toBeChecked();
    await page.getByRole("button", { name: "Submit intake" }).click();
    await page.waitForURL(/thank-you/);
    const after = Date.now();

    // ORACLE: the row, not the screen.
    const row = await getIntakeRow(intakeId);
    expect(row?.status).toBe("submitted");
    expect(row?.submitted_at).not.toBeNull();

    const responses = row?.responses as Record<string, unknown>;
    // The boolean answer and the provenance record are two SEPARATE keys.
    expect(CANON.id).not.toBe(CANON.questionKey);
    expect(responses[CANON.questionKey]).toBe(true);

    const rec = responses[CANON.id] as Record<string, unknown>;
    expect(rec).toBeTruthy();
    expect(rec.id).toBe(CANON.id);
    expect(rec.version).toBe(CANON.version);
    // Rebuilt from the server's own constant.
    expect(rec.wording).toBe(CANON.wording);
    expect(rec.accepted).toBe(true);

    // Stamped by the server, within the window this test was running.
    expect(typeof rec.accepted_at).toBe("string");
    const stamped = Date.parse(rec.accepted_at as string);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before - 60_000);
    expect(stamped).toBeLessThanOrEqual(after + 60_000);
  });

  test("A4. unticking overwrites the draft record instead of leaving a stale acceptance", async ({
    page,
  }) => {
    // The failure this guards: the server merge is a spread, so a client that
    // ticked, saved, then unticked would keep `accepted: true` on the row if the
    // wizard stopped sending the claim.
    const { intakeId, token } = await seedDraftOnAckStep(seed);

    await page.setViewportSize(DESKTOP);
    await page.goto(`/intake/${token}`);

    await ackCheckbox(page).check();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();

    await expect
      .poll(async () => {
        const r = await getIntakeRow(intakeId);
        const rec = (r?.responses as Record<string, unknown>)[CANON.id] as
          | Record<string, unknown>
          | undefined;
        return rec?.accepted;
      })
      .toBe(true);

    // A draft acceptance is NOT an acceptance: no timestamp is stamped.
    const drafted = await getIntakeRow(intakeId);
    const draftRec = (drafted?.responses as Record<string, unknown>)[
      CANON.id
    ] as Record<string, unknown>;
    expect(draftRec.accepted_at).toBeUndefined();
    expect(drafted?.status).toBe("in_progress");

    // Back to the step, untick, save again.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(ackCheckbox(page)).toBeChecked();
    await ackCheckbox(page).uncheck();
    await page.getByRole("button", { name: "Back" }).click();

    await expect
      .poll(async () => {
        const r = await getIntakeRow(intakeId);
        const rec = (r?.responses as Record<string, unknown>)[CANON.id] as
          | Record<string, unknown>
          | undefined;
        return rec?.accepted;
      })
      .toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. 390px — the width the operator's clients actually use
// ---------------------------------------------------------------------------

test.describe("B. acknowledgement at 390px", () => {
  test("B1. no horizontal overflow, and every part of the control stays inside the viewport", async ({
    page,
  }) => {
    const { token } = await seedDraftOnAckStep(seed);

    await page.setViewportSize(MOBILE);
    await page.goto(`/intake/${token}`);

    const box = ackCheckbox(page);
    await expect(box).toBeVisible();

    // The page itself must not scroll sideways.
    await assertNoHorizontalOverflow(page);

    // The whole control block — border, checkbox and the wording beside it.
    const control = box.locator("xpath=ancestor::label[1]");
    await assertWithinViewport(control, MOBILE.width, "acknowledgement control");
    // Comfortably tappable: the label is the touch target, not the 20px input.
    const controlBox = await control.boundingBox();
    expect(controlBox!.height).toBeGreaterThanOrEqual(44);

    // The wording is readable, not clipped to a sliver.
    const wording = page.getByText(CANON.wording, { exact: false });
    await assertWithinViewport(wording, MOBILE.width, "acknowledgement wording");

    // The help text carrying the not-a-signature boundary is readable too.
    const help = page.getByText(CANON.helpText, { exact: false });
    await expect(help).toBeVisible();
    await assertWithinViewport(help, MOBILE.width, "acknowledgement help text");

    // It is genuinely usable at this width.
    await box.check();
    await expect(box).toBeChecked();
    await assertNoHorizontalOverflow(page);
  });

  test("B2. the required-state message is visible and inside the viewport after a refused submit", async ({
    page,
  }) => {
    const { token } = await seedDraftOnAckStep(seed);

    await page.setViewportSize(MOBILE);
    await page.goto(`/intake/${token}`);
    await page.getByRole("button", { name: "Submit intake" }).click();

    const err = page.getByRole("alert").filter({ hasText: REQUIRED_ERROR });
    await expect(err).toBeVisible();
    await assertWithinViewport(err, MOBILE.width, "required-state message");
    // A message that pushes the page sideways is not discoverable either.
    await assertNoHorizontalOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// C. Accessibility sanity
// ---------------------------------------------------------------------------

test.describe("C. accessibility", () => {
  test("C1. accessible name, label activation, keyboard operation", async ({
    page,
  }) => {
    const { token } = await seedDraftOnAckStep(seed);

    await page.setViewportSize(DESKTOP);
    await page.goto(`/intake/${token}`);

    // Resolving by role+name IS the accessible-name assertion.
    const box = ackCheckbox(page);
    await expect(box).toHaveCount(1);
    await expect(box).not.toBeChecked();
    await expect(box).toHaveAttribute("aria-required", "true");

    // Clicking the wording (not the input) toggles it — the label is wired.
    await page.getByText(CANON.wording, { exact: false }).click();
    await expect(box).toBeChecked();

    // Keyboard: focus lands on it and Space toggles.
    await box.focus();
    await expect(box).toBeFocused();
    await page.keyboard.press("Space");
    await expect(box).not.toBeChecked();
    await page.keyboard.press("Space");
    await expect(box).toBeChecked();
  });

  test("C2. help text and error state are programmatically associated", async ({
    page,
  }) => {
    const { token } = await seedDraftOnAckStep(seed);

    await page.setViewportSize(DESKTOP);
    await page.goto(`/intake/${token}`);

    const box = ackCheckbox(page);

    // Help text is described-by before any interaction.
    const helpId = `${CANON.questionKey}_help`;
    await expect(box).toHaveAttribute(
      "aria-describedby",
      new RegExp(helpId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    await expect(page.locator(`#${helpId}`)).toHaveText(CANON.helpText);

    // No error state until one is earned.
    await expect(box).not.toHaveAttribute("aria-invalid", "true");

    await page.getByRole("button", { name: "Submit intake" }).click();

    // Now invalid, described by a real element that exists and announces.
    await expect(box).toHaveAttribute("aria-invalid", "true");
    const errorId = `${CANON.questionKey}_error`;
    const described = await box.getAttribute("aria-describedby");
    expect(described).toContain(errorId);
    const errorEl = page.locator(`#${errorId}`);
    await expect(errorEl).toHaveText(REQUIRED_ERROR);
    await expect(errorEl).toHaveAttribute("role", "alert");
    // The help text is still associated, not replaced by the error.
    expect(described).toContain(helpId);
  });
});

// ---------------------------------------------------------------------------
// D. Practitioner review — the STORED snapshot, and the legacy states
// ---------------------------------------------------------------------------

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

  test("D3. a submitted intake with no record says it PREDATES the acknowledgement", async ({
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
    await expect(section).toContainText(ACKNOWLEDGEMENT_REVIEW_COPY.predates);
    // Never dressed up as an acceptance, and never confused with a draft.
    await expect(section).not.toContainText(
      ACKNOWLEDGEMENT_REVIEW_COPY.acknowledged,
    );
    await expect(section).not.toContainText(ACKNOWLEDGEMENT_REVIEW_COPY.noRecord);
  });

  test("D4. an in-progress intake with no record says NO RECORD, not predates", async ({
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
    await expect(section).not.toContainText(ACKNOWLEDGEMENT_REVIEW_COPY.predates);
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
