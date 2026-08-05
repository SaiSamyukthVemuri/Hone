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
