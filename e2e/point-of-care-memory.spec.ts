import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { seedE2eStudio, sql, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// POINT-OF-CARE TREATMENT MEMORY — real browser, real stack.
//
// The journey being proved is Chloe's actual complaint: standing over a client
// mid-treatment, she could not see what was done last time without navigating
// away. This spec asserts that the "Last treatment" card is on the live
// charting screen, that it reflects the newest CHARTED session rather than a
// newer empty one, that it carries the setup fields that used to be missing,
// and that it does not get in the way of charting.
//
// Everything is seeded through the exported `sql` helper inside this file, so
// e2e/helpers/seed.ts stays untouched.

const T = 20_000;

const PREVIOUS_AT = "2026-01-01T10:00:00Z";
const NEWER_EMPTY_AT = "2026-05-01T10:00:00Z";
const CURRENT_AT = "2026-06-01T10:00:00Z";

type Fixture = {
  clientId: string;
  previousSessionId: string;
  newerEmptySessionId: string;
  currentSessionId: string;
};

// One charted prior session with two structured areas and mixed laterality,
// frequency, probe + lot, mode/modality/readings, hairs, minutes, response,
// tolerance, numbing, caution and plan — plus a consultation note and a
// skin/hair analysis note. Then a NEWER, completely empty session, then the
// session being charted now.
async function seedMemoryFixture(seed: E2eSeed): Promise<Fixture> {
  const prac = (
    await sql<{ id: string }>(
      `select id from public.practitioners where studio_id = $1 and role = 'owner' limit 1`,
      [seed.studioId],
    )
  )[0];

  const clientId = randomUUID();
  const previousSessionId = randomUUID();
  const newerEmptySessionId = randomUUID();
  const currentSessionId = randomUUID();
  const blockId = randomUUID();
  const uniq = randomUUID().slice(0, 8);

  await sql(
    `insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`,
    [
      clientId,
      seed.studioId,
      `Memory Client ${seed.runId}-${uniq}`,
      `e2e-memory-${seed.runId}-${uniq}@harness.local`,
    ],
  );

  // ---- the REAL previous treatment -------------------------------------
  await sql(
    `insert into public.sessions
       (id, studio_id, client_id, practitioner_id, modality, started_at, next_session_note)
     values ($1,$2,$3,$4,'electrolysis',$5,'Start lower on the sideburn')`,
    [previousSessionId, seed.studioId, clientId, prac.id, PREVIOUS_AT],
  );
  await sql(
    `insert into public.session_blocks
       (id, studio_id, session_id, sort_order, block_name,
        primary_area, side, mode, apilus_modality, energy_level,
        minutes_performed, machine_frequency,
        probe_key, probe_brand, probe_material, probe_piece_type, probe_shank,
        probe_size_value, probe_length, probe_label,
        probe_lot_number, probe_lot_confirmed,
        numbing_status, numbing_notes,
        tolerance_rating, reaction_type, reaction_notes,
        caution_for_next_session, caution_note)
     values ($1,$2,$3,1,'Main',
             'Cheek', null, 'blend', 'Picoblend', 14,
             30, '13.56 MHz',
             'sterex-gold-two-piece-f3-short','Sterex','Gold','Two-piece','F','3','Short',
             'Sterex · Gold · Two-piece · F3 Short',
             'LOT-A12', true,
             'used', 'Emla 30 minutes before',
             3, 'mild_redness', 'Settled within the hour',
             true, 'Watch the sideburn')`,
    [blockId, seed.studioId, previousSessionId],
  );
  await sql(
    `insert into public.session_block_areas (id, studio_id, session_block_id, area, laterality, display_order)
     values ($1,$2,$3,'Cheek','left',0), ($4,$2,$3,'Sideburn','right',1)`,
    [randomUUID(), seed.studioId, blockId, randomUUID()],
  );
  // Two live passes: hairs are summable, and the canonical (earliest) pass
  // supplies the readings.
  await sql(
    `insert into public.electrolysis_entries
       (id, session_id, block_id, area, areas, mode, energy_level, minutes_performed,
        machine_frequency, hairs_treated,
        thermolysis_intensity_percent, thermolysis_duration_seconds,
        galvanic_ma, galvanic_duration_seconds, units_of_lye, pulse_count, created_at)
     values ($1,$2,$3,'Cheek',array['Cheek']::text[],'blend',14,30,'13.56 MHz',40,
             40, 0.733, 1.2, 8, 30, 1, '2026-01-01T10:05:00Z'),
            ($4,$2,$3,'Cheek',array['Cheek']::text[],'blend',14,30,'13.56 MHz',25,
             45, 0.9, 1.2, 8, 30, 1, '2026-01-01T10:20:00Z')`,
    [randomUUID(), previousSessionId, blockId, randomUUID()],
  );
  // SESSION 1A CONTRACT, end to end: "Sensitive skin" is a safety-relevant
  // response chip with no coded enum member of its own. Before 1A the
  // classifier ignored it, so it was invisible on every response surface. It
  // must reach the Last treatment card, alongside the legacy reaction_type.
  // "Coarse hair" is an ordinary morphology chip and must NOT.
  await sql(
    `update public.electrolysis_entries
        set observation_chips = $2::jsonb
      where session_id = $1 and created_at = '2026-01-01T10:05:00Z'`,
    [previousSessionId, JSON.stringify(["Sensitive skin", "Coarse hair"])],
  );

  // ---- clinical note context -------------------------------------------
  await sql(
    `insert into public.client_clinical_notes
       (id, client_id, studio_id, practitioner_id, kind, body, occurred_at)
     values ($1,$2,$3,$4,'consultation',$5,'2026-01-01T09:00:00Z'),
            ($6,$2,$3,$4,'skin_hair_analysis',$7,'2026-01-01T09:10:00Z')`,
    [
      randomUUID(),
      clientId,
      seed.studioId,
      prac.id,
      "Goal is full clearance on the lower face over 18 months.",
      randomUUID(),
      "Fitzpatrick III, coarse dark hair, no post-inflammatory pigmentation.",
    ],
  );

  // ---- a NEWER, completely empty session -------------------------------
  // This is the row that used to win `order started_at desc limit 1` and hide
  // the treatment above.
  await sql(
    `insert into public.sessions
       (id, studio_id, client_id, practitioner_id, modality, started_at)
     values ($1,$2,$3,$4,'electrolysis',$5)`,
    [newerEmptySessionId, seed.studioId, clientId, prac.id, NEWER_EMPTY_AT],
  );

  // ---- the session being charted right now ------------------------------
  await sql(
    `insert into public.sessions
       (id, studio_id, client_id, practitioner_id, modality, started_at)
     values ($1,$2,$3,$4,'electrolysis',$5)`,
    [currentSessionId, seed.studioId, clientId, prac.id, CURRENT_AT],
  );

  return {
    clientId,
    previousSessionId,
    newerEmptySessionId,
    currentSessionId,
  };
}

function memoryCard(page: Page) {
  return page.getByTestId("last-treatment-memory");
}

// A page must never scroll sideways on a phone or a tablet.
async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
    };
  });
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.describe("point-of-care treatment memory", () => {
  test("the Last treatment card is on the charting screen and shows the real previous treatment", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const fx = await seedMemoryFixture(seed);
    await loginAsOwner(page, seed);

    await test.step("open the CURRENT charting session", async () => {
      await page.goto(`/clients/${fx.clientId}/sessions/${fx.currentSessionId}`);
      await expect(
        page.getByRole("heading", { name: /electrolysis session/i }),
      ).toBeVisible({ timeout: T });
    });

    const card = memoryCard(page);

    await test.step("the memory is visible WITHOUT leaving the page", async () => {
      await expect(card).toBeVisible({ timeout: T });
      await expect(card.getByText("Last treatment")).toBeVisible();
      // It sits above the charting surface, not below it.
      const cardBox = await card.boundingBox();
      const cta = page.getByTestId("add-settings-block-cta");
      const ctaBox = await cta.boundingBox();
      expect(cardBox).not.toBeNull();
      expect(ctaBox).not.toBeNull();
      expect(cardBox!.y).toBeLessThan(ctaBox!.y);
    });

    await test.step("it uses the CHARTED session, not the newer empty one", async () => {
      // The card deep-links to the session it is summarizing.
      await expect(
        card.getByRole("link", { name: /Open full chart/i }),
      ).toHaveAttribute(
        "href",
        `/clients/${fx.clientId}/sessions/${fx.previousSessionId}`,
      );
      // And it says so out loud.
      //
      // NOTE ON SCOPE. This is the CHARTING screen's card
      // (components/last-treatment-memory-card.tsx), not the Dashboard
      // disclosure. It keeps the longer wording deliberately: it is fed by the
      // SINGLE-client loader, whose candidate window is at most
      // DEFAULT_CHARTED_SESSION_LIMIT sessions, so the batched block cap that
      // made this claim unprovable on the Dashboard is not reachable here.
      await expect(
        card.getByText(/newer session has no treatment details yet/i),
      ).toBeVisible();
    });

    await test.step("the FULL structured area label, with laterality", async () => {
      // The defect was that only the FIRST area survived; both must be here.
      await expect(card.getByTestId("last-treatment-areas")).toHaveText(
        "Left Cheek · Right Sideburn",
      );
      await expect(
        card.getByTestId("last-treatment-setup-area").first(),
      ).toContainText("Left Cheek · Right Sideburn");
    });

    await test.step("frequency, probe lot, numbing and hairs", async () => {
      await expect(card.getByText("13.56 MHz")).toBeVisible();
      await expect(card.getByText(/Lot #LOT-A12 \(confirmed\)/)).toBeVisible();
      await expect(card.getByText("Numbing used")).toBeVisible();
      await expect(card.getByText("Emla 30 minutes before")).toBeVisible();
      // 40 + 25 across the two live passes.
      await expect(card.getByText("65 hairs")).toBeVisible();
      await expect(card.getByText("2 passes")).toBeVisible();
      await expect(card.getByText("30 min", { exact: true })).toBeVisible();
    });

    await test.step("mode-valid readings at full stored precision", async () => {
      await expect(card.getByText("Blend", { exact: true })).toBeVisible();
      await expect(card.getByText("PicoBlend", { exact: true })).toBeVisible();
      // The canonical (earliest) pass, exact to 3 decimals.
      await expect(card.getByText("0.733 seconds")).toBeVisible();
      await expect(card.getByText("EL 14")).toBeVisible();
      await expect(card.getByText("30 UL")).toBeVisible();
      // The retired input never appears.
      await expect(card.getByText(/galvanic intensity/i)).toHaveCount(0);
    });

    await test.step("a Session 1A safety-response chip reaches the card", async () => {
      // Widened classifier (Session 1A) flowing through unifiedReactionLabels
      // into the point-of-care memory. Not a second classifier.
      await expect(card.getByText(/Sensitive skin/)).toBeVisible();
      // …and an ordinary morphology chip stays out of the response line.
      await expect(card.getByText(/Coarse hair/)).toHaveCount(0);
    });

    await test.step("response, tolerance and caution", async () => {
      await expect(card.getByText(/Mild redness/)).toBeVisible();
      await expect(card.getByText(/3\/5 - Moderate discomfort/)).toBeVisible();
      await expect(card.getByText(/Settled within the hour/)).toBeVisible();
      await expect(card.getByText(/Watch the sideburn/)).toBeVisible();
    });

    await test.step("consultation and skin/hair context, as excerpts with a link out", async () => {
      await expect(card.getByText(/Goal is full clearance/)).toBeVisible();
      await expect(card.getByText(/Fitzpatrick III/)).toBeVisible();
      await expect(card.getByRole("link", { name: /Full notes/i })).toHaveAttribute(
        "href",
        `/clients/${fx.clientId}?tab=consultation`,
      );
    });

    await test.step("the plan is shown once, not twice", async () => {
      await expect(
        page.getByText("Start lower on the sideburn"),
      ).toHaveCount(1);
    });

    await test.step("charting still works with the card on the page", async () => {
      await page.getByTestId("add-settings-block-cta").click({ timeout: T });
      await expect(
        page.getByText(/Areas treated with these settings/i),
      ).toBeVisible({ timeout: T });
      const before = (
        await sql<{ n: number }>(
          `select count(*)::int as n from public.session_blocks
            where session_id = $1 and deleted_at is null`,
          [fx.currentSessionId],
        )
      )[0].n;
      expect(before).toBe(0);
    });

    await test.step("the memory panel wrote nothing", async () => {
      const rows = await sql<{ n: number }>(
        `select count(*)::int as n from public.session_blocks
          where session_id = $1`,
        [fx.newerEmptySessionId],
      );
      expect(rows[0].n).toBe(0);
    });
  });

  test("with NO newer empty session, the card does not claim one exists", async ({
    page,
  }) => {
    // The TRUE branch of supersededByEmptySession is asserted above. Without
    // this, hard-coding the flag true would survive the whole suite.
    const seed = await seedE2eStudio();
    const fx = await seedMemoryFixture(seed);
    // Remove the newer empty session, so the charted visit IS the newest
    // candidate. Hard delete is fine: this row is e2e scaffolding that was
    // never charted on.
    await sql(`delete from public.sessions where id = $1`, [
      fx.newerEmptySessionId,
    ]);
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${fx.clientId}/sessions/${fx.currentSessionId}`);

    const card = memoryCard(page);
    await expect(card).toBeVisible({ timeout: T });
    // Still the same charted session…
    await expect(
      card.getByRole("link", { name: /Open full chart/i }),
    ).toHaveAttribute(
      "href",
      `/clients/${fx.clientId}/sessions/${fx.previousSessionId}`,
    );
    // …but the "a newer session has no treatment details yet" line is GONE.
    await expect(
      card.getByText(/newer session has no treatment details yet/i),
    ).toHaveCount(0);
  });

  test("a LASER prior visit says what it is instead of claiming nothing was recorded", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const fx = await seedMemoryFixture(seed);
    const prac = (
      await sql<{ id: string }>(
        `select id from public.practitioners where studio_id = $1 and role = 'owner' limit 1`,
        [seed.studioId],
      )
    )[0];
    // A laser visit AFTER the electrolysis one. Laser charts into
    // laser_entries and never creates a session_block, so it is genuinely
    // charted but carries no treatment areas.
    const laserId = randomUUID();
    await sql(
      `insert into public.sessions
         (id, studio_id, client_id, practitioner_id, modality, started_at)
       values ($1,$2,$3,$4,'laser','2026-05-15T10:00:00Z')`,
      [laserId, seed.studioId, fx.clientId, prac.id],
    );
    await sql(
      `insert into public.laser_entries (id, session_id, zone) values ($1,$2,'Chin')`,
      [randomUUID(), laserId],
    );

    await loginAsOwner(page, seed);
    await page.goto(`/clients/${fx.clientId}/sessions/${fx.currentSessionId}`);

    const card = memoryCard(page);
    await expect(card).toBeVisible({ timeout: T });
    // The laser visit is the newest charted treatment.
    await expect(
      card.getByRole("link", { name: /Open full chart/i }),
    ).toHaveAttribute("href", `/clients/${fx.clientId}/sessions/${laserId}`);
    // It says what it is, rather than "Area not recorded / Not recorded".
    await expect(card.getByTestId("last-treatment-no-blocks")).toContainText(
      /charted as laser passes/i,
    );
    await expect(card.getByTestId("last-treatment-areas")).toHaveCount(0);
    await expect(card.getByText("Area not recorded")).toHaveCount(0);
  });

  test("the new-session context also uses the charted session, not the newest row", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const fx = await seedMemoryFixture(seed);
    await loginAsOwner(page, seed);

    await page.goto(`/clients/${fx.clientId}/sessions/new`);
    await expect(page.getByText("Previous session context")).toBeVisible({
      timeout: T,
    });
    // The panel's date link points at the CHARTED session, not the newer empty
    // one — the exact regression this PR fixes.
    await expect(
      page.locator(
        `a[href="/clients/${fx.clientId}/sessions/${fx.previousSessionId}"]`,
      ),
    ).toBeVisible();
    await expect(
      page.locator(
        `a[href="/clients/${fx.clientId}/sessions/${fx.newerEmptySessionId}"]`,
      ),
    ).toHaveCount(0);
    // And the panel is no longer an empty shell: it names the treated areas.
    await expect(
      page.getByText("Left Cheek · Right Sideburn", { exact: true }),
    ).toBeVisible();
  });

  // ---- /sessions/new with a BLOCKLESS charted visit -----------------------
  //
  // The selector correctly accepts laser-only and legacy entry-only treatments.
  // But /sessions/new renders a BLOCK-shaped summary, and buildLastSessionSummary
  // returns a TRUTHY object with `areas: []` for them — so the panel used to
  // render its heading and date over nothing at all. Both journeys prove the
  // truthful fallback instead.

  test("/sessions/new: a LASER-only newest charted visit gets a truthful fallback", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const fx = await seedMemoryFixture(seed);
    const prac = (
      await sql<{ id: string }>(
        `select id from public.practitioners where studio_id = $1 and role = 'owner' limit 1`,
        [seed.studioId],
      )
    )[0];

    // A laser visit NEWER than the electrolysis one, with a plan note.
    const laserId = randomUUID();
    await sql(
      `insert into public.sessions
         (id, studio_id, client_id, practitioner_id, modality, started_at, next_session_note)
       values ($1,$2,$3,$4,'laser','2026-05-20T10:00:00Z','Recheck the patch test')`,
      [laserId, seed.studioId, fx.clientId, prac.id],
    );
    await sql(
      `insert into public.laser_entries (id, session_id, zone) values ($1,$2,'Chin')`,
      [randomUUID(), laserId],
    );
    // fx already seeded a NEWER empty session (2026-05-01) — but the laser
    // visit is newer still, so add one above it to keep the empty-session
    // control in play.
    await sql(
      `insert into public.sessions
         (id, studio_id, client_id, practitioner_id, modality, started_at)
       values ($1,$2,$3,$4,'electrolysis','2026-05-25T10:00:00Z')`,
      [randomUUID(), seed.studioId, fx.clientId, prac.id],
    );

    await loginAsOwner(page, seed);
    await page.goto(`/clients/${fx.clientId}/sessions/new`);

    await expect(page.getByText("Previous session context")).toBeVisible({
      timeout: T,
    });
    // The CHARTED laser visit was selected, not the newer empty session.
    await expect(
      page.locator(`a[href="/clients/${fx.clientId}/sessions/${laserId}"]`).first(),
    ).toBeVisible();
    // Truthful fallback, shared copy.
    await expect(page.getByTestId("previous-context-blockless")).toContainText(
      "This previous visit was charted as laser passes. Open the full chart to review what was recorded.",
    );
    // No empty area summary and no false "Area not recorded".
    await expect(page.getByText("Area not recorded")).toHaveCount(0);
    await expect(page.getByText("Treatment area 1")).toHaveCount(0);
    // The plan still shows.
    await expect(page.getByText("Recheck the patch test")).toBeVisible();
  });

  test("/sessions/new: a LEGACY entry-only electrolysis visit gets its own fallback", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const prac = (
      await sql<{ id: string }>(
        `select id from public.practitioners where studio_id = $1 and role = 'owner' limit 1`,
        [seed.studioId],
      )
    )[0];
    const clientId = randomUUID();
    const legacyId = randomUUID();
    const uniq = randomUUID().slice(0, 8);
    await sql(
      `insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`,
      [
        clientId,
        seed.studioId,
        `Legacy Client ${seed.runId}-${uniq}`,
        `e2e-legacy-${seed.runId}-${uniq}@harness.local`,
      ],
    );
    // Pre-0019 shape: live electrolysis entries with NO settings block.
    await sql(
      `insert into public.sessions
         (id, studio_id, client_id, practitioner_id, modality, started_at, next_session_note)
       values ($1,$2,$3,$4,'electrolysis','2026-01-01T10:00:00Z','Go gently on the chin')`,
      [legacyId, seed.studioId, clientId, prac.id],
    );
    await sql(
      `insert into public.electrolysis_entries
         (id, session_id, block_id, area, areas, mode, pulse_count, created_at)
       values ($1,$2,null,'Chin',array['Chin']::text[],'blend',1,'2026-01-01T10:05:00Z')`,
      [randomUUID(), legacyId],
    );
    // A NEWER, completely empty session above it.
    await sql(
      `insert into public.sessions
         (id, studio_id, client_id, practitioner_id, modality, started_at)
       values ($1,$2,$3,$4,'electrolysis','2026-06-01T10:00:00Z')`,
      [randomUUID(), seed.studioId, clientId, prac.id],
    );

    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/sessions/new`);

    await expect(page.getByText("Previous session context")).toBeVisible({
      timeout: T,
    });
    await expect(
      page.locator(`a[href="/clients/${clientId}/sessions/${legacyId}"]`).first(),
    ).toBeVisible();
    // Says what the record IS. The old copy ended "...WITHOUT SETTINGS BLOCKS",
    // an assertion about a child collection that a bounded block read cannot
    // support: a short read is indistinguishable from an empty one, so the
    // visit may well have blocks that were not returned.
    await expect(page.getByTestId("previous-context-blockless")).toContainText(
      "This previous visit was charted as legacy treatment entries. Open the full chart to review what was recorded.",
    );
    await expect(page.getByText(/without settings blocks/i)).toHaveCount(0);
    await expect(page.getByText("Area not recorded")).toHaveCount(0);
    await expect(page.getByText("Treatment area 1")).toHaveCount(0);
    await expect(page.getByText("Go gently on the chin")).toBeVisible();
  });

  test("/sessions/new: a visit WITH blocks still renders the ordinary area summary", async ({
    page,
  }) => {
    // The control: the fallback must not swallow the normal path.
    const seed = await seedE2eStudio();
    const fx = await seedMemoryFixture(seed);
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${fx.clientId}/sessions/new`);

    await expect(page.getByTestId("previous-context-blockless")).toHaveCount(0);
    await expect(
      page.getByText("Left Cheek · Right Sideburn", { exact: true }),
    ).toBeVisible();
  });

  test("multi-area treatment time is credited to the combined area exactly once", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const fx = await seedMemoryFixture(seed);
    await loginAsOwner(page, seed);

    await page.goto(`/clients/${fx.clientId}?tab=sessions`);
    // Scope every assertion to the treatment-time tracker; "Cheek" appears in
    // the visit history on the same tab.
    const tracker = page
      .locator("section")
      .filter({ hasText: "Total electrolysis treatment time" })
      .first();
    await expect(tracker).toBeVisible({ timeout: T });

    // ONE bucket, naming BOTH areas, carrying the block's single duration.
    await expect(tracker.getByTitle("Cheek · Sideburn")).toBeVisible();
    await expect(tracker.getByTitle("Cheek · Sideburn")).toHaveCount(1);
    await expect(tracker.getByText("30m", { exact: true })).toHaveCount(2); // total + the one row

    // The old behaviour credited the whole 30 minutes to "Cheek" and dropped
    // "Sideburn" entirely. Neither bare area may appear as its own bucket.
    await expect(tracker.getByTitle("Cheek", { exact: true })).toHaveCount(0);
    await expect(tracker.getByTitle("Sideburn", { exact: true })).toHaveCount(0);

    // 100%, not 200% — the duration is not counted once per area.
    await expect(tracker.getByText("100%", { exact: true })).toHaveCount(1);
    await expect(tracker.getByText("200%")).toHaveCount(0);

    // And the rendered total matches the stored total.
    const stored = await sql<{ total: number }>(
      `select coalesce(sum(minutes_performed),0)::int as total
         from public.session_blocks
        where session_id = $1 and deleted_at is null`,
      [fx.previousSessionId],
    );
    expect(stored[0].total).toBe(30);
  });
});

test.describe("narrow mobile — 390px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the headline is readable, nothing scrolls sideways, and Save stays usable", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const fx = await seedMemoryFixture(seed);
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${fx.clientId}/sessions/${fx.currentSessionId}`);

    const card = memoryCard(page);
    await expect(card).toBeVisible({ timeout: T });

    await test.step("the important summary is visible with zero taps", async () => {
      await expect(card.getByTestId("last-treatment-areas")).toHaveText(
        "Left Cheek · Right Sideburn",
      );
      await expect(card.getByText(/Mild redness/)).toBeVisible();
      await expect(card.getByText(/Watch the sideburn/)).toBeVisible();
    });

    await test.step("no horizontal overflow at 390px", async () => {
      await assertNoHorizontalOverflow(page);
      const box = await card.boundingBox();
      expect(box!.width).toBeLessThanOrEqual(390);
    });

    await test.step("the setup disclosure is reachable and collapses", async () => {
      const summary = card.getByText("Setup used");
      await expect(summary).toBeVisible();
      // Default-expanded: the setup is readable without a tap.
      await expect(card.getByText("13.56 MHz")).toBeVisible();
      await summary.click();
      await expect(card.getByText("13.56 MHz")).toBeHidden();
      await summary.click();
      await expect(card.getByText("13.56 MHz")).toBeVisible();
    });

    await test.step("the charting form is still usable below the card", async () => {
      await page.getByTestId("add-settings-block-cta").click({ timeout: T });
      const save = page.getByRole("button", { name: /save/i }).first();
      await expect(save).toBeVisible({ timeout: T });
      const box = await save.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(40);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(391);
      await assertNoHorizontalOverflow(page);
    });
  });
});

test.describe("iPad — 820px, Chloe's device", () => {
  test.use({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });

  test("the card is default-expanded and does not crowd the charting form", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const fx = await seedMemoryFixture(seed);
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${fx.clientId}/sessions/${fx.currentSessionId}`);

    const card = memoryCard(page);
    await expect(card).toBeVisible({ timeout: T });
    await expect(card.getByTestId("last-treatment-areas")).toHaveText(
      "Left Cheek · Right Sideburn",
    );
    await expect(card.getByText(/Lot #LOT-A12/)).toBeVisible();
    await expect(card.getByText("65 hairs")).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await test.step("the charting form opens and remains fully on screen", async () => {
      await page.getByTestId("add-settings-block-cta").click({ timeout: T });
      await expect(
        page.getByText(/Areas treated with these settings/i),
      ).toBeVisible({ timeout: T });
      await assertNoHorizontalOverflow(page);
      const save = page.getByRole("button", { name: /save/i }).first();
      const box = await save.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(821);
    });
  });
});

// ---------------------------------------------------------------------------
// HYDRATION DETERMINISM for clinical dates.
//
// <ClinicalDate> is a Client Component, so it renders TWICE: once by Node on
// the server, once by the browser during hydration. `toLocaleDateString` with
// no locale means "this runtime's default", and those two runtimes disagree —
// Node emits "Jul 21, 2026" while an fr-CA browser emits "21 juill. 2026".
// Same day, mismatched markup, React hydration error on a clinical screen.
//
// timeZone: "UTC" pins the DAY but not the locale-dependent TEXT. This spec
// drives a REAL browser whose locale is fr-CA — the strongest cross-runtime
// evidence available — and proves the date is stable, correct, and warning-free.
// ---------------------------------------------------------------------------
test.describe("clinical dates hydrate deterministically (fr-CA browser)", () => {
  test.use({ locale: "fr-CA", timezoneId: "America/Toronto" });

  // A hydration mismatch in a Next PRODUCTION build (which this lane runs)
  // surfaces as a console ERROR — "Hydration failed…", "Text content does not
  // match server-rendered HTML". So errors are the signal.
  //
  // Chromium WARNINGS are environment chatter that varies by browser build and
  // by runner (the CI runner, for instance, warns that the app's own
  // Permissions-Policy header names a feature it does not recognise). Asserting
  // an empty warning list would make this spec fail for reasons that have
  // nothing to do with the contract under test — so warnings are only inspected
  // for hydration content, never required to be empty.
  const HYDRATION_RE =
    /hydrat|did not match|Text content does not match|server-rendered/i;

  // ERROR-level noise this app emits for reasons unrelated to hydration. Each
  // one is named: a broad filter would swallow the very errors under test.
  const IRRELEVANT = [
    /Download the React DevTools/i,
    /Failed to load resource/i,
    /favicon/i,
    /\[Fast Refresh\]/i,
    // The e2e stack configures no PostHog token on purpose; the SDK complains
    // once per page.
    /\[PostHog\.js\] PostHog was initialized without a token/i,
    // Vercel Analytics / Speed Insights are served by the Vercel edge in
    // production; locally the path 404s to HTML and the browser refuses the
    // script. Named explicitly — not a broad "MIME type" filter.
    /_vercel\/(insights|speed-insights)/i,
    // Chromium build-specific header parsing chatter.
    /Permissions-Policy header/i,
  ];
  const isIrrelevant = (text: string) => IRRELEVANT.some((re) => re.test(text));

  // Arms console capture on a page BEFORE navigation. Returns both buckets:
  // `errors` (strictly asserted, minus the named artifacts) and
  // `hydration` (asserted across errors AND warnings — a hydration complaint
  // fails this spec whichever level it arrives at).
  function captureConsole(page: import("@playwright/test").Page) {
    const errors: string[] = [];
    const hydration: string[] = [];
    page.on("console", (msg) => {
      const type = msg.type();
      if (type !== "error" && type !== "warning") return;
      const text = msg.text();
      if (HYDRATION_RE.test(text)) hydration.push(`${type}: ${text}`);
      if (type === "error" && !isIrrelevant(text)) errors.push(`error: ${text}`);
    });
    page.on("pageerror", (err) => {
      const text = err.message;
      if (HYDRATION_RE.test(text)) hydration.push(`pageerror: ${text}`);
      if (!isIrrelevant(text)) errors.push(`pageerror: ${text}`);
    });
    return { errors, hydration };
  }

  test("the note date is stable, correct and hydration-clean at fr-CA / Toronto", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const fx = await seedMemoryFixture(seed);
    const prac = (
      await sql<{ id: string }>(
        `select id from public.practitioners where studio_id = $1 and role = 'owner' limit 1`,
        [seed.studioId],
      )
    )[0];
    // A note dated JULY 21 — stored as a calendar date, i.e. midnight UTC.
    // Toronto is UTC-4 in July, so a naive instant conversion shows July 20.
    await sql(
      `insert into public.client_clinical_notes
         (id, client_id, studio_id, practitioner_id, kind, body, occurred_at)
       values ($1,$2,$3,$4,'consultation',$5,'2026-07-21')`,
      [
        randomUUID(),
        fx.clientId,
        seed.studioId,
        prac.id,
        "Hydration probe consultation.",
      ],
    );

    // Armed BEFORE navigation so the hydration pass is covered.
    const { errors, hydration } = captureConsole(page);

    await loginAsOwner(page, seed);
    await page.goto(`/clients/${fx.clientId}?tab=consultation`);

    const section = page.getByText("Consultation notes").first();
    await expect(section).toBeVisible({ timeout: T });

    await test.step("the stored day is shown, not the prior day", async () => {
      await expect(page.getByText("Jul 21, 2026").first()).toBeVisible({
        timeout: T,
      });
      // The defect: Toronto would have rendered July 20.
      await expect(page.getByText("Jul 20, 2026")).toHaveCount(0);
    });

    await test.step("the text follows Hone's en-CA contract, NOT the fr-CA browser", async () => {
      // A browser-locale-derived rendering would read "21 juill. 2026".
      await expect(page.getByText(/juill\./)).toHaveCount(0);
      await expect(page.getByText(/juillet/)).toHaveCount(0);
    });

    await test.step("the date does NOT change after hydration", async () => {
      const before = await page
        .getByText("Jul 21, 2026")
        .first()
        .textContent();
      // Give React a full hydration + settle window.
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(750);
      const after = await page.getByText("Jul 21, 2026").first().textContent();
      expect(after).toBe(before);
      expect(after?.trim()).toBe("Jul 21, 2026");
    });

    await test.step("no React hydration mismatch was reported", async () => {
      // THE contract: nothing complained about hydration, at any level.
      expect(hydration, hydration.join("\n")).toEqual([]);
      // And no unexplained console ERROR either.
      expect(errors, errors.join("\n")).toEqual([]);
    });
  });

  test("the memory card's note date is deterministic while the session time stays an instant", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const fx = await seedMemoryFixture(seed);
    const { errors, hydration } = captureConsole(page);

    await loginAsOwner(page, seed);
    await page.goto(`/clients/${fx.clientId}/sessions/${fx.currentSessionId}`);

    const card = memoryCard(page);
    await expect(card).toBeVisible({ timeout: T });

    // THE TWO FORMATTERS, side by side in one card, behaving differently on
    // purpose. This is the clearest possible proof of the contract.
    //
    // (a) NOTE dates are CIVIL dates → pinned to Hone's en-CA, so an fr-CA
    //     browser still reads "Jan 1, 2026".
    const noteDates = card.getByTestId("last-treatment-note-date");
    await expect(noteDates.first()).toContainText("Jan 1, 2026");
    for (const dt of await noteDates.all()) {
      await expect(dt).not.toContainText("janv.");
    }

    // (b) SESSION START is a real INSTANT → still FormattedDateTime, which
    //     deliberately follows the viewer. Under fr-CA it reads "1 janv. 2026",
    //     and that is CORRECT — instants are not civil dates.
    await expect(card.getByText(/janv\./).first()).toBeVisible();

    // Neither changes after hydration.
    const noteBefore = await noteDates.first().textContent();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(750);
    expect(await noteDates.first().textContent()).toBe(noteBefore);
    await expect(noteDates.first()).toContainText("Jan 1, 2026");

    expect(hydration, hydration.join("\n")).toEqual([]);
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
