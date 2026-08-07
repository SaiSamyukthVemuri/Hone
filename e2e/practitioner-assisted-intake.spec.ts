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
  INTAKE_STEPS,
  PRACTITIONER_ENTERABLE_STEPS,
  TOTAL_STEPS,
} from "@/lib/intake/questions";
import { PRACTITIONER_ASSISTED_ENTRY } from "@/lib/intake/entry-provenance";

// Practitioner-assisted intake, proven in a real browser against the real
// local database.
//
// DATABASE STATE IS THE ORACLE. Every assertion that matters reads
// client_intake_forms back with getIntakeRow(). On-screen copy is asserted
// only where the copy IS the deliverable — the assisted banner, the
// "Client confirmation required" hand-off, and the review-page provenance
// section, which are the whole point of the feature.
//
// WHAT THIS PROVES, precisely:
//   * a practitioner can record the questionnaire across multiple steps;
//   * conditional questions behave identically to the client wizard;
//   * leaving and resuming keeps the answers;
//   * the hand-off lands on the CLIENT's own wizard with the acknowledgements
//     unticked, and the client's submission is what flips the row;
//   * provenance survives the client's own save and submit;
//   * the review page states who recorded the answers, separately from the
//     client's acknowledgement.
//
// WHAT THIS DOES NOT PROVE. Which physical human held the device. The intake
// link is a bearer token. Nothing below claims otherwise.

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

const PROV_KEY = PRACTITIONER_ASSISTED_ENTRY.id;
const ACK_STEP = TOTAL_STEPS;
const FIRST_STEP = PRACTITIONER_ENTERABLE_STEPS[0].id;
const LAST_ENTERABLE =
  PRACTITIONER_ENTERABLE_STEPS[PRACTITIONER_ENTERABLE_STEPS.length - 1].id;

// Every required, unconditional question on the practitioner-enterable steps,
// generated from the catalogue so a future required question is picked up
// automatically rather than silently blocking these tests for the wrong
// reason. Client-owned steps are excluded by construction.
function answeredQuestionnaire(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const step of PRACTITIONER_ENTERABLE_STEPS) {
    for (const q of step.questions) {
      if (!q.required || q.conditional) continue;
      if (q.type === "multi_select") out[q.key] = [q.options?.[0]?.value ?? "x"];
      else if (q.type === "single_select") out[q.key] = q.options?.[0]?.value ?? "x";
      else if (q.type === "yes_no") out[q.key] = "no";
      else if (q.type === "date") out[q.key] = "1990-01-01";
      else if (q.key === "email") out[q.key] = "dana@example.test";
      else out[q.key] = "provided";
    }
  }
  return out;
}

// The client's own acknowledgement answers, used ONLY to drive the client's
// wizard in the hand-off test. Never sent by the practitioner surface.
function clientOwnedAnswers(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ackStep = INTAKE_STEPS[INTAKE_STEPS.length - 1];
  for (const q of ackStep.questions) out[q.key] = true;
  return out;
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const o = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  // 1px rounding tolerance; more than that is a real horizontal scroll.
  expect(o.scroll).toBeLessThanOrEqual(o.client + 1);
}

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

function provenanceOf(row: { responses: Record<string, unknown> } | null) {
  return row?.responses?.[PROV_KEY] as Record<string, unknown> | undefined;
}

// getIntakeRow() does not project current_step, and e2e/helpers/seed.ts is a
// shared-infrastructure path (editing it forces EXTENDED browser coverage on
// every PR), so this reads the column directly rather than widening it.
async function currentStepOf(intakeId: string): Promise<number> {
  const { sql } = await import("./helpers/seed");
  const rows = await sql<{ current_step: number }>(
    `select current_step from public.client_intake_forms where id = $1`,
    [intakeId],
  );
  return rows[0].current_step;
}

let seed: E2eSeed;

test.beforeAll(async () => {
  seed = await seedE2eStudio();
});

// ---------------------------------------------------------------------------
test.describe("practitioner-assisted intake", () => {
  test("desktop: record the questionnaire, resume, hand off, client submits, review shows provenance", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const { clientId } = await seedE2eClient(seed);
    const intakeId = await seedE2eIntake(seed.studioId, clientId, "in_progress", {});
    await loginAsOwner(page, seed);

    // --- the CTA exists on the intake review page for an in-progress intake
    await page.goto(`/clients/${clientId}/intake`);
    const cta = page.getByRole("link", { name: "Complete intake with client" });
    await expect(cta).toBeVisible();
    await cta.click();

    // --- the assisted editor states what is happening, unmissably
    await expect(
      page.getByText("Completing with client", { exact: false }),
    ).toBeVisible();
    // ...and never claims to be the client.
    const bodyText = (await page.locator("body").innerText()).toLowerCase();
    expect(bodyText).not.toContain("on behalf of");
    expect(bodyText).not.toContain("acting as");
    expect(bodyText).not.toContain("sign for");

    // --- step 1: record answers
    const legalName = page.locator("#legal_name");
    await expect(legalName).toBeVisible();
    await legalName.fill("Dana Reyes");
    await page.locator("#email").fill("dana@example.test");
    await page.locator("#phone").fill("5551230000");
    await page.locator("#date_of_birth").fill("1990-04-02");
    await page.locator("#pronouns").fill("they/them");
    await page.locator("#address").fill("1 Test Street");
    await page.locator("#emergency_contact_name").fill("Sam Reyes");
    await page.locator("#emergency_contact_phone").fill("5559998888");

    await page.getByRole("button", { name: "Continue" }).click();

    // --- the answers AND the provenance are in the database now
    await expect
      .poll(async () => (await getIntakeRow(intakeId))?.responses?.legal_name)
      .toBe("Dana Reyes");
    let row = await getIntakeRow(intakeId);
    const prov = provenanceOf(row)!;
    expect(prov, "assisted provenance must be recorded").toBeTruthy();
    expect(prov.mode).toBe("practitioner_assisted");
    expect((prov.started_by as Record<string, unknown>).display_name).toBeTruthy();
    const startedAt = prov.started_at as string;

    // --- multi-step: keep going, and prove a CONDITIONAL question behaves
    // exactly as it does in the client wizard.
    await expect(
      page.getByRole("heading", { name: INTAKE_STEPS[1].title }),
    ).toBeVisible();

    // `most_recent_method` is conditional on `other_methods` including a
    // non-"none" option. It must be absent until the parent is satisfied.
    await expect(page.locator("#most_recent_method")).toHaveCount(0);
    await page.getByRole("button", { name: "Waxing", exact: true }).click();
    await expect(page.locator("#most_recent_method")).toHaveCount(1);
    // ...and disappear again when the parent no longer matches.
    await page.getByRole("button", { name: "Waxing", exact: true }).click();
    await expect(page.locator("#most_recent_method")).toHaveCount(0);

    // --- leave, then resume: the answers persist
    await page.getByRole("button", { name: "Save and leave" }).click();
    await page.waitForURL(`**/clients/${clientId}/intake`);
    await page.getByRole("link", { name: "Complete intake with client" }).click();
    await expect(page.getByText("Completing with client")).toBeVisible();
    // Resumed on the step we left, with the recorded answer intact.
    // "Back to previous step", not "Back": the body-area question renders an
    // option button also labelled "Back".
    await page.getByRole("button", { name: "Back to previous step" }).click();
    await expect(page.locator("#legal_name")).toHaveValue("Dana Reyes");

    // --- fast-forward the rest of the questionnaire by seeding the answers,
    // then reload so the editor picks them up. (Typing 50 fields in a browser
    // proves nothing this spec has not already proven.)
    await seedResponses(intakeId, answeredQuestionnaire());
    await page.goto(`/clients/${clientId}/intake/assist?intake=${intakeId}`);

    // Walk to the last practitioner-enterable step.
    for (let s = FIRST_STEP; s < LAST_ENTERABLE; s += 1) {
      await page.getByRole("button", { name: /Continue|Save and continue/ }).click();
    }
    await page
      .getByRole("button", { name: /Continue|Save and continue/ })
      .click();

    // --- the hand-off panel, not a submit button
    await expect(
      page.getByRole("heading", { name: "Client confirmation required" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Hand to client" })).toBeVisible();
    // The practitioner surface offers NO way to submit.
    await expect(page.getByRole("button", { name: /^Submit/ })).toHaveCount(0);

    // The intake is still a draft, with nothing acknowledged.
    row = await getIntakeRow(intakeId);
    expect(row?.status).toBe("in_progress");
    expect(row?.submitted_at).toBeNull();
    for (const q of INTAKE_STEPS[INTAKE_STEPS.length - 1].questions) {
      expect(
        row?.responses?.[q.key],
        `${q.key} must NOT be ticked by the practitioner`,
      ).toBeUndefined();
    }

    // --- hand over
    await page.getByRole("button", { name: "Hand to client" }).click();
    // NOT waitForURL("**/intake/**") — that also matches the assist route we
    // are leaving, so it resolves before the handoff has landed. The database
    // is the oracle; the navigation is asserted separately below.
    await expect
      .poll(
        async () => provenanceOf(await getIntakeRow(intakeId))?.handoff_at,
        { message: "handoff must be stamped server-side" },
      )
      .toBeTruthy();
    // The client's own tokenized route: /intake/<token>, not /clients/.../intake.
    await page.waitForURL(/\/intake\/[^/?#]+$/);
    expect(new URL(page.url()).pathname).not.toContain("/clients/");

    row = await getIntakeRow(intakeId);
    const handed = provenanceOf(row)!;
    expect(handed.handoff_at, "handoff must be stamped").toBeTruthy();
    expect(handed.started_at, "started_at must not move").toBe(startedAt);
    expect(await currentStepOf(intakeId)).toBe(ACK_STEP);

    // --- we are now on the CLIENT's own wizard, on the acknowledgements step,
    // with every box UNTICKED.
    const ackStep = INTAKE_STEPS[INTAKE_STEPS.length - 1];
    await expect(
      page.getByRole("heading", { name: ackStep.title }),
    ).toBeVisible();
    for (const q of ackStep.questions) {
      const box = page.locator(`#${q.key}`);
      await expect(box, `${q.key} must render for the client`).toHaveCount(1);
      await expect(box, `${q.key} must start unticked`).not.toBeChecked();
    }

    // --- the client ticks their own boxes and submits
    for (const q of ackStep.questions) {
      await page.locator(`#${q.key}`).check();
    }
    await page.getByRole("button", { name: "Submit intake" }).click();
    await page.waitForURL("**/intake/thank-you");

    // --- the row is submitted, by the CLIENT path, provenance intact
    row = await getIntakeRow(intakeId);
    expect(row?.status).toBe("submitted");
    expect(row?.submitted_at).not.toBeNull();
    const after = provenanceOf(row)!;
    expect(after.started_at).toBe(startedAt);
    expect(after.handoff_at).toBe(handed.handoff_at);
    expect(after.started_by).toEqual(handed.started_by);

    // --- the review page tells the practitioner the truth
    await page.goto(`/clients/${clientId}/intake`);
    const entrySection = page
      .getByRole("heading", { name: "Intake entry" })
      .locator("xpath=ancestor::section[1]");
    await expect(entrySection).toBeVisible();
    await expect(entrySection).toContainText(
      "Questionnaire answers were recorded with the client by",
    );
    // The acknowledgement stays a SEPARATE record.
    await expect(
      page.getByRole("heading", { name: "Electrolysis acknowledgement" }),
    ).toBeVisible();
    // Nothing on this page says the practitioner accepted anything.
    const reviewText = (await page.locator("body").innerText()).toLowerCase();
    expect(reviewText).not.toContain("on behalf of");
  });

  // The entry point. Everything above assumes an in_progress intake already
  // exists; until this shipped, a client with NO intake row was a dead end on
  // Health & Forms and the only way in was a six-step detour through the
  // dedicated intake page. This proves the one-click path, and that it lands
  // the practitioner in the editor the tests above exercise.
  test("no intake on file: Start intake with client creates one and opens the assisted editor", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const { clientId } = await seedE2eClient(seed);
    // Ground truth before the click: this client has no intake at all.
    expect(await intakesFor(clientId)).toHaveLength(0);

    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}?tab=health`);

    const cta = page.getByTestId("start-intake-with-client");
    await expect(cta).toBeVisible();
    await expect(cta).toHaveText("Start intake with client");
    await cta.click();

    // --- we are in the assisted editor, on the AUTHENTICATED route
    await page.waitForURL(/\/clients\/[^/]+\/intake\/assist\?intake=/);
    await expect(page.getByText("Completing with client")).toBeVisible();
    // ...with step 1 of the real questionnaire rendered.
    await expect(page.locator("#legal_name")).toBeVisible();
    // Not the client's bearer link. That hand-off belongs to Hand to client.
    expect(new URL(page.url()).pathname).toBe(
      `/clients/${clientId}/intake/assist`,
    );

    // --- EXACTLY ONE intake now exists, and it is the one the URL addresses
    const rows = await intakesFor(clientId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("in_progress");
    expect(new URL(page.url()).searchParams.get("intake")).toBe(rows[0].id);

    // --- no email was sent: an emailed link stamps this column, and it is
    // still null. (stampIntakeLinkIssued only sets it when emailed is true.)
    //
    // NECESSARY BUT NOT SUFFICIENT, and measured rather than assumed. A
    // negative control that flipped send_email to true left this test GREEN:
    // this lane runs with a dummy RESEND_API_KEY, so the send is genuinely
    // attempted, fails ("API key is invalid"), and the column is never
    // stamped either way. The load-bearing proof that this path cannot email
    // lives in the unit lane — tests/app/clients/start-intake-with-client.ts
    // asserts the sender is never called and the client-email rate limiter is
    // never even consulted, and those DO go red on that mutation.
    expect(rows[0].intake_link_last_sent_at).toBeNull();

    // --- the row is a blank draft: nothing submitted, nothing acknowledged
    const row = await getIntakeRow(rows[0].id);
    expect(row?.submitted_at).toBeNull();
    for (const q of INTAKE_STEPS[INTAKE_STEPS.length - 1].questions) {
      expect(
        row?.responses?.[q.key],
        `${q.key} must not be ticked by starting an intake`,
      ).toBeUndefined();
    }

    // --- back on Health & Forms the state has moved on: the card shows the
    // in-progress intake and the start CTA is gone, so a second blank row
    // cannot be started from here.
    await page.goto(`/clients/${clientId}?tab=health`);
    await expect(page.getByTestId("start-intake-with-client")).toHaveCount(0);
    await expect(page.getByText("not yet submitted")).toBeVisible();
    expect(await intakesFor(clientId)).toHaveLength(1);
  });

  test("a submitted intake offers no Start intake with client CTA", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const { clientId } = await seedE2eClient(seed);
    const intakeId = await seedE2eIntake(seed.studioId, clientId, "submitted", {
      ...answeredQuestionnaire(),
      ...clientOwnedAnswers(),
    });
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}?tab=health`);

    await expect(
      page.getByRole("heading", { name: "Health intake" }),
    ).toBeVisible();
    await expect(page.getByTestId("start-intake-with-client")).toHaveCount(0);
    // The terminal record is untouched, and still the only row.
    expect(await intakesFor(clientId)).toHaveLength(1);
    expect((await getIntakeRow(intakeId))?.status).toBe("submitted");
  });

  test("an ordinary self-completed intake shows no assisted badge", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const { clientId } = await seedE2eClient(seed);
    const intakeId = await seedE2eIntake(seed.studioId, clientId, "submitted", {
      ...answeredQuestionnaire(),
      ...clientOwnedAnswers(),
    });
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/intake?intake=${intakeId}`);

    await expect(
      page.getByRole("heading", { name: "Health intake" }),
    ).toBeVisible();
    // The section must be entirely absent — not empty, absent.
    await expect(
      page.getByRole("heading", { name: "Intake entry" }),
    ).toHaveCount(0);
    const row = await getIntakeRow(intakeId);
    expect(provenanceOf(row)).toBeUndefined();
  });

  test("a submitted intake offers no assisted entry", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const { clientId } = await seedE2eClient(seed);
    const intakeId = await seedE2eIntake(seed.studioId, clientId, "submitted", {
      ...answeredQuestionnaire(),
      ...clientOwnedAnswers(),
    });
    await loginAsOwner(page, seed);

    await page.goto(`/clients/${clientId}/intake?intake=${intakeId}`);
    await expect(
      page.getByRole("link", { name: "Complete intake with client" }),
    ).toHaveCount(0);

    // ...and the route itself refuses, rather than relying on the hidden CTA.
    await page.goto(`/clients/${clientId}/intake/assist?intake=${intakeId}`);
    await page.waitForURL(`**/clients/${clientId}/intake`);
    await expect(page.getByText("Completing with client")).toHaveCount(0);

    const row = await getIntakeRow(intakeId);
    expect(row?.status).toBe("submitted");
  });

  test("390px: the assisted editor and the hand-off fit the viewport", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE);
    const { clientId } = await seedE2eClient(seed);
    const intakeId = await seedE2eIntake(
      seed.studioId,
      clientId,
      "in_progress",
      answeredQuestionnaire(),
    );
    await setIntakeCurrentStep(intakeId, LAST_ENTERABLE);
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/intake/assist?intake=${intakeId}`);

    // The banner is the thing that must never be missed on a small screen.
    const banner = page
      .getByText("Completing with client")
      .locator("xpath=ancestor::div[1]");
    await expect(banner).toBeVisible();
    await assertWithinViewport(banner, MOBILE.width, "assisted banner");
    await assertNoHorizontalOverflow(page);

    // The step indicator carries one more column than the client wizard
    // (the client's own step); it must still fit.
    const indicator = page.getByLabel("Assisted intake progress");
    await assertWithinViewport(indicator, MOBILE.width, "step indicator");

    // Reach the hand-off panel and measure it too.
    await page
      .getByRole("button", { name: /Continue|Save and continue/ })
      .click();
    const panel = page
      .getByRole("heading", { name: "Client confirmation required" })
      .locator("xpath=ancestor::section[1]");
    await expect(panel).toBeVisible();
    await assertWithinViewport(panel, MOBILE.width, "hand-off panel");
    await assertNoHorizontalOverflow(page);

    const handButton = page.getByRole("button", { name: "Hand to client" });
    await assertWithinViewport(handButton, MOBILE.width, "hand to client button");
    // Touch target.
    const box = await handButton.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test("390px: the review page's entry section fits", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    const { clientId } = await seedE2eClient(seed);
    const intakeId = await seedE2eIntake(seed.studioId, clientId, "in_progress", {
      ...answeredQuestionnaire(),
      [PROV_KEY]: {
        mode: "practitioner_assisted",
        version: "v1",
        started_at: "2026-08-07T10:00:00.000Z",
        started_by: {
          practitioner_id: "00000000-0000-0000-0000-000000000001",
          display_name: "A Practitioner With A Fairly Long Display Name",
        },
        last_updated_at: "2026-08-07T10:05:00.000Z",
        last_updated_by: {
          practitioner_id: "00000000-0000-0000-0000-000000000002",
          display_name: "Another Practitioner With A Long Name",
        },
        handoff_at: "2026-08-07T10:10:00.000Z",
        handoff_by: {
          practitioner_id: "00000000-0000-0000-0000-000000000002",
          display_name: "Another Practitioner With A Long Name",
        },
      },
    });
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/intake?intake=${intakeId}`);

    const section = page
      .getByRole("heading", { name: "Intake entry" })
      .locator("xpath=ancestor::section[1]");
    await expect(section).toBeVisible();
    // Two DIFFERENT practitioners: both must be named, truthfully.
    await expect(section).toContainText("A Practitioner With A Fairly Long Display Name");
    await expect(section).toContainText("Another Practitioner With A Long Name");
    await assertWithinViewport(section, MOBILE.width, "intake entry section");
    await assertNoHorizontalOverflow(page);
  });
});

// Every non-deleted intake row for one client, oldest first. The count IS the
// duplicate-safety oracle for the Start-intake-with-client journey, and
// intake_link_last_sent_at is the "no email was sent" oracle. getIntakeRow()
// projects neither, and e2e/helpers/seed.ts is a shared-infrastructure path
// (editing it forces EXTENDED browser coverage on every PR), so this reads the
// columns directly rather than widening it.
async function intakesFor(clientId: string): Promise<
  Array<{ id: string; status: string; intake_link_last_sent_at: string | null }>
> {
  const { sql } = await import("./helpers/seed");
  return sql<{
    id: string;
    status: string;
    intake_link_last_sent_at: string | null;
  }>(
    `select id, status, intake_link_last_sent_at::text as intake_link_last_sent_at
       from public.client_intake_forms
      where client_id = $1 and deleted_at is null
      order by created_at`,
    [clientId],
  );
}

// Seed extra answers onto an existing intake without going through the UI.
// Uses the same `sql` escape hatch the other specs use for setup-only writes.
async function seedResponses(
  intakeId: string,
  responses: Record<string, unknown>,
): Promise<void> {
  const { sql } = await import("./helpers/seed");
  await sql(
    `update public.client_intake_forms
        set responses = coalesce(responses, '{}'::jsonb) || $2::jsonb
      where id = $1`,
    [intakeId, JSON.stringify(responses)],
  );
}
