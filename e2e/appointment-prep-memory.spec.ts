import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  seedE2eStudio,
  getOwnerPractitionerId,
  getStudioTimezone,
  seedFutureAppointmentAt,
  sql,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// APPOINTMENT PREPARATION MEMORY — real browser, real stack.
//
// The journey being proved is Chloe's actual complaint: opening today's
// appointment before the client arrives and NOT being able to see what happened
// last time without opening the prior chart, or entering Edit to read a note.
//
// Everything is seeded through the exported `sql` helper inside this file, so
// e2e/helpers/seed.ts stays untouched.
//
// THE FIXTURE IS THE PROOF. Every scenario below seeds a NEWER EMPTY SESSION
// whose started_at falls strictly between the real treatment and the
// appointment's start. Without it this spec would pass against the old
// newest-row query and prove nothing at all.

const T = 20_000;

const PREVIOUS_AT = "2026-01-01T10:00:00Z";
const NEWER_EMPTY_AT = "2026-05-01T10:00:00Z";

const SESSION_NOTES =
  "Client arrived early and was very comfortable throughout.\n\nWe discussed spacing the next two visits further apart.\nShe wants to keep the same probe.";
const NEXT_VISIT_NOTE = "Start lower on the sideburn and check sensitivity";
const CAUTION_NOTE = "Sideburn reacted more than the cheek — go slowly";
const LONG_RESPONSE_NOTE = `${"Erythema persisted noticeably longer than usual across the whole area. ".repeat(4)}Fully resolved by the evening.`;
const PASS_ONE_NOTE = "First pass was slow going near the jawline.";
const PASS_TWO_NOTE = "Second pass:\nmuch faster once the area had warmed up.";
const CHIN_NOTE = "Chin needed a lower energy level than last time.";
const FOREIGN_MARKER = "FOREIGN-STUDIO-TREATMENT-NOTE";

type Fixture = {
  clientId: string;
  appointmentId: string;
  previousSessionId: string;
  newerEmptySessionId: string;
};

async function seedClient(seed: E2eSeed, label: string): Promise<string> {
  const clientId = randomUUID();
  const uniq = randomUUID().slice(0, 8);
  await sql(
    `insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`,
    [
      clientId,
      seed.studioId,
      `Prep ${label} ${seed.runId}-${uniq}`,
      `e2e-prep-${label}-${seed.runId}-${uniq}@harness.local`,
    ],
  );
  return clientId;
}

async function appointmentFor(seed: E2eSeed, clientId: string): Promise<string> {
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  return seedFutureAppointmentAt(seed.studioId, ownerId, clientId, tz, "14:00");
}

// A returning electrolysis client: one multi-area block (Left Cheek + Right
// Sideburn) with the full setup, two live passes with their own Additional
// notes, a second single-area block, the full narrative — and then a NEWER
// EMPTY session that used to win the lookup.
async function seedReturningClient(seed: E2eSeed): Promise<Fixture> {
  const prac = await getOwnerPractitionerId(seed.studioId);
  const clientId = await seedClient(seed, "returning");
  const previousSessionId = randomUUID();
  const newerEmptySessionId = randomUUID();
  const blockId = randomUUID();
  const chinBlockId = randomUUID();

  await sql(
    `insert into public.sessions
       (id, studio_id, client_id, practitioner_id, modality, started_at,
        session_notes, next_session_note)
     values ($1,$2,$3,$4,'electrolysis',$5,$6,$7)`,
    [
      previousSessionId,
      seed.studioId,
      clientId,
      prac,
      PREVIOUS_AT,
      SESSION_NOTES,
      NEXT_VISIT_NOTE,
    ],
  );

  await sql(
    `insert into public.session_blocks
       (id, studio_id, session_id, sort_order, block_name, primary_area, side,
        mode, apilus_modality, energy_level, minutes_performed, machine_frequency,
        probe_label, probe_lot_number, probe_lot_confirmed,
        numbing_status, numbing_notes,
        tolerance_rating, reaction_type, reaction_notes,
        caution_for_next_session, caution_note)
     values ($1,$2,$3,1,'Main','Cheek',null,
             'blend','Picoblend',14,30,'13.56 MHz',
             'Ballet F3','LOT-A12',true,
             'used','Emla applied 30 minutes before',
             3,'mild_redness',$4,
             true,$5)`,
    [blockId, seed.studioId, previousSessionId, LONG_RESPONSE_NOTE, CAUTION_NOTE],
  );
  await sql(
    `insert into public.session_block_areas (session_block_id, area, laterality, display_order)
     values ($1,'Cheek','left',0), ($1,'Sideburn','right',1)`,
    [blockId],
  );
  await sql(
    `insert into public.electrolysis_entries
       (session_id, block_id, area, mode, hairs_treated,
        thermolysis_duration_seconds, thermolysis_intensity_percent,
        galvanic_ma, galvanic_duration_seconds, units_of_lye, pulse_count,
        comments, created_at)
     values ($1,$2,'Cheek','blend',40,0.733,40,1.2,8,30,1,$3,'2026-01-01T10:05:00Z'),
            ($1,$2,'Cheek','blend',25,0.9,45,1.2,8,30,1,$4,'2026-01-01T10:20:00Z')`,
    [previousSessionId, blockId, PASS_ONE_NOTE, PASS_TWO_NOTE],
  );

  // A SECOND area, with its own settings and its own note.
  await sql(
    `insert into public.session_blocks
       (id, studio_id, session_id, sort_order, primary_area, side, mode,
        energy_level, minutes_performed, machine_frequency, probe_label, caution_note)
     values ($1,$2,$3,2,'Chin','center','thermo',9,12,'27.12 MHz','Ballet F2',$4)`,
    [chinBlockId, seed.studioId, previousSessionId, CHIN_NOTE],
  );
  await sql(
    `insert into public.session_block_areas (session_block_id, area, laterality, display_order)
     values ($1,'Chin','midline',0)`,
    [chinBlockId],
  );

  // THE DECOY: newer, non-deleted, and completely empty.
  await sql(
    `insert into public.sessions
       (id, studio_id, client_id, practitioner_id, modality, started_at)
     values ($1,$2,$3,$4,'electrolysis',$5)`,
    [newerEmptySessionId, seed.studioId, clientId, prac, NEWER_EMPTY_AT],
  );

  const appointmentId = await appointmentFor(seed, clientId);
  return { clientId, appointmentId, previousSessionId, newerEmptySessionId };
}

function prepCard(page: Page) {
  return page.getByTestId("appointment-prep-memory");
}

// A page must never scroll sideways on a phone or a tablet.
async function assertNoHorizontalOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({
    s: document.documentElement.scrollWidth,
    c: document.documentElement.clientWidth,
  }));
  expect(
    w.s,
    `${label}: no horizontal overflow (${w.s} vs ${w.c})`,
  ).toBeLessThanOrEqual(w.c + 1);
}

// Reads the card's rendered text ONCE, so "appears exactly once" assertions
// cannot be satisfied by a hidden duplicate elsewhere on the page.
async function cardText(page: Page): Promise<string> {
  return (await prepCard(page).innerText()).replace(/\r\n/g, "\n");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test.describe("appointment prep memory — returning electrolysis client", () => {
  test("the appointment page shows the real prior treatment, complete, with full notes", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const fx = await seedReturningClient(seed);
    await loginAsOwner(page, seed);

    await page.goto(`/calendar/${fx.appointmentId}`);
    const card = prepCard(page);
    await expect(card).toBeVisible({ timeout: T });

    await test.step("the REAL treatment is selected, not the newer empty row", async () => {
      // The full-chart link is the unambiguous proof of WHICH session won.
      await expect(card.getByTestId("prep-full-chart-link")).toHaveAttribute(
        "href",
        `/clients/${fx.clientId}/sessions/${fx.previousSessionId}`,
      );
      const html = await card.innerHTML();
      expect(html).not.toContain(fx.newerEmptySessionId);
      // And the page says so out loud.
      await expect(card.getByTestId("prep-superseded")).toBeVisible();
    });

    await test.step("EVERY treated area is visible, with laterality", async () => {
      await expect(card.getByTestId("prep-areas")).toHaveText(
        "Left Cheek · Right Sideburn · Midline Chin",
      );
      const text = await cardText(page);
      // Not just the first area of the first block.
      expect(text).toContain("Right Sideburn");
      expect(text).toContain("Midline Chin");
      // One outcome row and one setup row per block — never a duplicate block.
      await expect(card.getByTestId("prep-outcome-area")).toHaveCount(2);
      await expect(card.getByTestId("prep-setup-area")).toHaveCount(2);
    });

    await test.step("the complete setup is readable WITHOUT entering Edit", async () => {
      const setup = card.getByTestId("prep-setup-area");
      const cheek = setup.first();
      await expect(cheek).toContainText("13.56 MHz");
      await expect(cheek).toContainText("Ballet F3 · Lot #LOT-A12 (confirmed)");
      await expect(cheek).toContainText("Blend");
      await expect(cheek).toContainText("EL 14");
      await expect(cheek).toContainText("30 UL");
      await expect(cheek).toContainText("1.2 mA");
      // 3dp exact — never 0.73 and never 0.
      await expect(cheek).toContainText("0.733 seconds");
      await expect(cheek).toContainText("40%");
      // The second block keeps its OWN settings.
      const chin = setup.nth(1);
      await expect(chin).toContainText("27.12 MHz");
      await expect(chin).toContainText("Ballet F2");
      await expect(chin).not.toContainText("13.56 MHz");
      // NON-VACUITY FIRST: `not.toContainText` is satisfied by an empty node,
      // so prove this block rendered readings at all before asserting which
      // ones it withheld.
      await expect(chin).toContainText("EL 9");
      // A thermolysis block shows no stale galvanic reading.
      await expect(chin).not.toContainText("mA");
      await expect(chin).not.toContainText("UL");
    });

    await test.step("outcomes are a SEPARATE section from setup", async () => {
      const outcome = card.getByTestId("prep-outcome-area").first();
      await expect(outcome).toContainText("30 min");
      await expect(outcome).toContainText("65 hairs");
      await expect(outcome).toContainText("2 passes");
      await expect(outcome).toContainText("Numbing used");
      await expect(outcome).toContainText("Mild redness");
      await expect(outcome).toContainText("Tolerance 3/5");
      // The outcome row is not the setup row.
      await expect(outcome).not.toContainText("Ballet F3");
      await expect(outcome).not.toContainText("0.733 seconds");
      await expect(card.getByText("What happened")).toBeVisible();
      await expect(card.getByText("Setup used")).toBeVisible();
    });

    await test.step("the FULL narrative is readable on this page", async () => {
      const notes = card.getByTestId("prep-notes");
      await expect(notes).toBeVisible();
      const text = await cardText(page);
      // Whole, untruncated, and every source present.
      expect(text).toContain(SESSION_NOTES.split("\n")[0]);
      expect(text).toContain("She wants to keep the same probe.");
      expect(text).toContain(NEXT_VISIT_NOTE);
      expect(text).toContain(CAUTION_NOTE);
      expect(text).toContain(CHIN_NOTE);
      expect(text).toContain(PASS_ONE_NOTE);
      expect(text).toContain("much faster once the area had warmed up.");
      expect(text).toContain("Emla applied 30 minutes before");
      // A response note far longer than the 140-char cap the compact summary
      // applies survives here, to its last word.
      expect(LONG_RESPONSE_NOTE.length).toBeGreaterThan(140);
      expect(text).toContain("Fully resolved by the evening.");
      expect(text).not.toContain("…");
    });

    await test.step("line breaks survive — the notes are not flattened", async () => {
      const text = await cardText(page);
      // The blank line between the first two paragraphs of the session notes.
      expect(text).toContain(
        "Client arrived early and was very comfortable throughout.\n",
      );
      expect(text).toContain("Second pass:\nmuch faster");
      // A CSS-level guarantee, not just a text one.
      const ws = await card
        .getByTestId("prep-note-item")
        .first()
        .evaluate((el) => getComputedStyle(el).whiteSpace);
      expect(["pre-wrap", "break-spaces"]).toContain(ws);
    });

    await test.step("no note is shown twice", async () => {
      const text = await cardText(page);
      for (const note of [
        NEXT_VISIT_NOTE,
        CAUTION_NOTE,
        CHIN_NOTE,
        PASS_ONE_NOTE,
        "Emla applied 30 minutes before",
        "Fully resolved by the evening.",
      ]) {
        expect(occurrences(text, note), `"${note}" must appear exactly once`).toBe(1);
      }
    });

    await test.step("nothing requires opening the prior chart or Edit", async () => {
      // The full-chart link exists as an escape hatch, but the card is not a
      // stub that forces the trip.
      await expect(card.getByTestId("prep-full-chart-link")).toBeVisible();
      await expect(card.getByRole("button", { name: /edit/i })).toHaveCount(0);
      await expect(card.locator("form")).toHaveCount(0);
    });

    await test.step("no horizontal overflow at desktop width", async () => {
      await assertNoHorizontalOverflow(page, "appointment prep @desktop");
    });
  });

  test("a linked current session never becomes its own previous treatment", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const fx = await seedReturningClient(seed);
    const prac = await getOwnerPractitionerId(seed.studioId);
    await loginAsOwner(page, seed);

    // Link a charted session to THIS appointment, starting a few minutes before
    // the booked time — the reachable case where only appointment_id can
    // exclude it.
    const linkedId = randomUUID();
    const startsAt = (
      await sql<{ starts_at: string }>(
        `select starts_at from public.appointments where id = $1`,
        [fx.appointmentId],
      )
    )[0].starts_at;
    const linkedStart = new Date(
      new Date(startsAt).getTime() - 5 * 60_000,
    ).toISOString();
    await sql(
      `insert into public.sessions
         (id, studio_id, client_id, practitioner_id, modality, started_at, appointment_id)
       values ($1,$2,$3,$4,'electrolysis',$5,$6)`,
      [linkedId, seed.studioId, fx.clientId, prac, linkedStart, fx.appointmentId],
    );
    await sql(
      `insert into public.session_blocks
         (id, studio_id, session_id, sort_order, primary_area, minutes_performed, caution_note)
       values ($1,$2,$3,1,'Neck',15,'CURRENT-VISIT-MARKER')`,
      [randomUUID(), seed.studioId, linkedId],
    );

    await page.goto(`/calendar/${fx.appointmentId}`);
    const card = prepCard(page);
    await expect(card).toBeVisible({ timeout: T });

    await test.step("Last treatment still points at the EARLIER charted session", async () => {
      await expect(card.getByTestId("prep-full-chart-link")).toHaveAttribute(
        "href",
        `/clients/${fx.clientId}/sessions/${fx.previousSessionId}`,
      );
      const text = await cardText(page);
      expect(text).not.toContain("CURRENT-VISIT-MARKER");
      expect(text).not.toContain("Neck");
    });

    await test.step("the View-session affordance still points at the LINKED session", async () => {
      const section = page
        .locator("section")
        .filter({ hasText: "Session for this appointment" });
      await expect(section).toBeVisible({ timeout: T });
      await expect(
        section.locator(`a[href="/clients/${fx.clientId}/sessions/${linkedId}"]`),
      ).toBeVisible();
    });
  });

  test("a laser-only prior treatment is described truthfully, with its notes", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const prac = await getOwnerPractitionerId(seed.studioId);
    const clientId = await seedClient(seed, "laser");
    const laserId = randomUUID();

    await sql(
      `insert into public.sessions
         (id, studio_id, client_id, practitioner_id, modality, started_at,
          session_notes, next_session_note)
       values ($1,$2,$3,$4,'laser',$5,'Full-face laser pass, no adverse response.','Reduce fluence next time')`,
      [laserId, seed.studioId, clientId, prac, PREVIOUS_AT],
    );
    await sql(
      `insert into public.laser_entries (session_id, zone, observation_notes)
       values ($1,'Chin','Zone cleared well.\nSlight warmth only.')`,
      [laserId],
    );
    // The decoy again.
    await sql(
      `insert into public.sessions
         (id, studio_id, client_id, practitioner_id, modality, started_at)
       values ($1,$2,$3,$4,'electrolysis',$5)`,
      [randomUUID(), seed.studioId, clientId, prac, NEWER_EMPTY_AT],
    );
    const appointmentId = await appointmentFor(seed, clientId);

    await loginAsOwner(page, seed);
    await page.goto(`/calendar/${appointmentId}`);
    const card = prepCard(page);
    await expect(card).toBeVisible({ timeout: T });

    await expect(card.getByTestId("prep-no-blocks")).toContainText(
      "charted as laser passes",
    );
    // No empty electrolysis shell, and no false negative.
    await expect(card.getByTestId("prep-setup-area")).toHaveCount(0);
    await expect(card.getByTestId("prep-outcome-area")).toHaveCount(0);
    const text = await cardText(page);
    expect(text).not.toContain("Area not recorded");
    expect(text).not.toContain("Setup not recorded");
    // The full chart is reachable, and the notes are visible right here.
    await expect(card.getByTestId("prep-full-chart-link")).toHaveAttribute(
      "href",
      `/clients/${clientId}/sessions/${laserId}`,
    );
    expect(text).toContain("Full-face laser pass, no adverse response.");
    expect(text).toContain("Reduce fluence next time");
    expect(text).toContain("Zone cleared well.");
    expect(text).toContain("Slight warmth only.");
  });

  test("a legacy entry-only prior treatment is described truthfully, with its notes", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const prac = await getOwnerPractitionerId(seed.studioId);
    const clientId = await seedClient(seed, "legacy");
    const legacyId = randomUUID();

    await sql(
      `insert into public.sessions
         (id, studio_id, client_id, practitioner_id, modality, started_at, session_notes)
       values ($1,$2,$3,$4,'electrolysis',$5,'Charted before settings blocks existed.')`,
      [legacyId, seed.studioId, clientId, prac, PREVIOUS_AT],
    );
    await sql(
      `insert into public.electrolysis_entries
         (session_id, area, mode, hairs_treated, comments, created_at)
       values ($1,'Chin','thermo',18,'Legacy pass note.','2026-01-01T10:05:00Z')`,
      [legacyId],
    );
    await sql(
      `insert into public.sessions
         (id, studio_id, client_id, practitioner_id, modality, started_at)
       values ($1,$2,$3,$4,'electrolysis',$5)`,
      [randomUUID(), seed.studioId, clientId, prac, NEWER_EMPTY_AT],
    );
    const appointmentId = await appointmentFor(seed, clientId);

    await loginAsOwner(page, seed);
    await page.goto(`/calendar/${appointmentId}`);
    const card = prepCard(page);
    await expect(card).toBeVisible({ timeout: T });

    await expect(card.getByTestId("prep-no-blocks")).toContainText(
      "legacy treatment entries",
    );
    const text = await cardText(page);
    expect(text).not.toContain("Area not recorded");
    expect(text).not.toContain("Setup not recorded");
    expect(text).toContain("Charted before settings blocks existed.");
  });

  test("a first-visit client sees no misleading previous-treatment card", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const clientId = await seedClient(seed, "first");
    const appointmentId = await appointmentFor(seed, clientId);

    await loginAsOwner(page, seed);
    await page.goto(`/calendar/${appointmentId}`);

    await expect(page.getByTestId("appointment-prep-empty")).toBeVisible({
      timeout: T,
    });
    await expect(page.getByTestId("appointment-prep-memory")).toHaveCount(0);
    await expect(
      page.getByText("No previous treatment charted for this client."),
    ).toBeVisible();
    // The rest of the appointment page still works.
    await expect(page.getByText("Session for this appointment")).toBeVisible();
    await assertNoHorizontalOverflow(page, "first visit @desktop");
  });

  test("the notes section is never silently absent", async ({ page }) => {
    const seed = await seedE2eStudio();
    const prac = await getOwnerPractitionerId(seed.studioId);
    const clientId = await seedClient(seed, "nonotes");
    const sessionId = randomUUID();

    await sql(
      `insert into public.sessions
         (id, studio_id, client_id, practitioner_id, modality, started_at)
       values ($1,$2,$3,$4,'electrolysis',$5)`,
      [sessionId, seed.studioId, clientId, prac, PREVIOUS_AT],
    );
    await sql(
      `insert into public.session_blocks
         (id, studio_id, session_id, sort_order, primary_area, side, mode, minutes_performed)
       values ($1,$2,$3,1,'Chin','center','thermo',10)`,
      [randomUUID(), seed.studioId, sessionId],
    );
    const appointmentId = await appointmentFor(seed, clientId);

    await loginAsOwner(page, seed);
    await page.goto(`/calendar/${appointmentId}`);
    const card = prepCard(page);
    await expect(card).toBeVisible({ timeout: T });

    // Present, and explicit — never suppressed, which would read as "the query
    // failed" rather than "there is nothing here to show".
    //
    // SCOPED TO THIS SURFACE, not to the record. Four of the five note families
    // are harvested per AREA, i.e. from the block collection, which is read
    // under a bound — so "No notes recorded at the last session." could deny
    // notes that exist and were simply not returned.
    await expect(card.getByTestId("prep-notes")).toBeVisible();
    await expect(card.getByTestId("prep-notes-empty")).toHaveText(
      "No notes to show for this visit. Open the full chart to review what was recorded.",
    );
    await expect(card.getByText(/No notes recorded/i)).toHaveCount(0);
  });

  // SCOPE OF THIS TEST, stated plainly. The AUTHORITATIVE tenant-isolation
  // proof is the DB suite, which queries as the authenticated role and shows
  // RLS itself returning zero rows for a foreign studio
  // (tests/db/appointment-prep-memory.db.test.ts). This is a rendered-output
  // leak check: studio B's clinical text must not appear anywhere in the
  // markup studio A's practitioner receives. It asserts on innerHTML, not
  // innerText, because a session id only ever appears in an href ATTRIBUTE —
  // innerText can never contain one, which would make the assertion
  // unfalsifiable.
  test("no foreign-studio treatment text appears in the rendered markup", async ({ page }) => {
    const seedA = await seedE2eStudio();
    const seedB = await seedE2eStudio();
    const fx = await seedReturningClient(seedA);

    // Studio B: a matching-looking client with a newer, fully charted treatment.
    const pracB = await getOwnerPractitionerId(seedB.studioId);
    const clientB = await seedClient(seedB, "foreign");
    const sessionB = randomUUID();
    await sql(
      `insert into public.sessions
         (id, studio_id, client_id, practitioner_id, modality, started_at, session_notes)
       values ($1,$2,$3,$4,'electrolysis',$5,$6)`,
      [
        sessionB,
        seedB.studioId,
        clientB,
        pracB,
        NEWER_EMPTY_AT,
        FOREIGN_MARKER,
      ],
    );
    await sql(
      `insert into public.session_blocks
         (id, studio_id, session_id, sort_order, primary_area, minutes_performed, caution_note)
       values ($1,$2,$3,1,'Cheek',44,$4)`,
      [randomUUID(), seedB.studioId, sessionB, FOREIGN_MARKER],
    );

    await loginAsOwner(page, seedA);
    await page.goto(`/calendar/${fx.appointmentId}`);
    await expect(prepCard(page)).toBeVisible({ timeout: T });

    const markup = await page.locator("body").innerHTML();
    expect(markup).not.toContain(FOREIGN_MARKER);
    expect(markup).not.toContain(sessionB);
    expect(markup).not.toContain(clientB);
    // Non-vacuity: the page really did render studio A's own treatment, so the
    // assertions above are about exclusion rather than about an empty page.
    expect(markup).toContain(fx.previousSessionId);
  });
});

test.describe("appointment prep memory — 390px phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("everything is readable at phone width with no sideways scroll", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const fx = await seedReturningClient(seed);
    await loginAsOwner(page, seed);
    await page.goto(`/calendar/${fx.appointmentId}`);

    const card = prepCard(page);
    await expect(card).toBeVisible({ timeout: T });
    await assertNoHorizontalOverflow(page, "appointment prep @390");

    // The clinical headline needs ZERO taps.
    await expect(card.getByTestId("prep-areas")).toHaveText(
      "Left Cheek · Right Sideburn · Midline Chin",
    );
    const text = await cardText(page);
    expect(text).toContain(NEXT_VISIT_NOTE);
    expect(text).toContain(CAUTION_NOTE);
    // Setup is expanded by default at phone width too — nothing hidden behind a
    // tap that Chloe has to discover.
    await expect(card.getByTestId("prep-setup-area").first()).toBeVisible();
    await expect(card.getByTestId("prep-setup-area").first()).toContainText(
      "Lot #LOT-A12",
    );

    await test.step("the setup disclosure still collapses, and re-expands", async () => {
      const summary = card.getByText("Setup used");
      await summary.click();
      await expect(card.getByTestId("prep-setup-area").first()).toBeHidden();
      await summary.click();
      await expect(card.getByTestId("prep-setup-area").first()).toBeVisible();
      await assertNoHorizontalOverflow(page, "appointment prep @390 after toggle");
    });

    await test.step("a very long note wraps instead of scrolling the page", async () => {
      expect(text).toContain("Fully resolved by the evening.");
      await assertNoHorizontalOverflow(page, "long note @390");
    });
  });
});

test.describe("appointment prep memory — iPad 820px, Chloe's device", () => {
  test.use({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });

  test("the complete memory reads without navigation on the iPad", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const fx = await seedReturningClient(seed);
    await loginAsOwner(page, seed);
    await page.goto(`/calendar/${fx.appointmentId}`);

    const card = prepCard(page);
    await expect(card).toBeVisible({ timeout: T });
    await assertNoHorizontalOverflow(page, "appointment prep @820");

    await expect(card.getByTestId("prep-outcome-area")).toHaveCount(2);
    await expect(card.getByTestId("prep-setup-area")).toHaveCount(2);

    const text = await cardText(page);
    expect(text).toContain("Ballet F3 · Lot #LOT-A12 (confirmed)");
    expect(text).toContain("65 hairs");
    expect(text).toContain(SESSION_NOTES.split("\n")[0]);
    expect(text).toContain("Fully resolved by the evening.");
    expect(text).toContain(PASS_TWO_NOTE.split("\n")[1]);
    expect(text).not.toContain("…");

    // Nothing sits off the right edge.
    const box = await card.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(821);
  });
});
