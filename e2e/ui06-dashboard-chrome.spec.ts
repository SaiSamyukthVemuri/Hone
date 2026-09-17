import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { seedE2eStudio, seedE2eDashboardMemoryClient, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// UI-06 — the flattened memory cards, proved at three widths.
//
// The source proof pins the vocabulary (one label, one border token, one row
// treatment, no depth-4 box). What it CANNOT show is the thing the slice is
// actually for: that removing per-row boxes did not cost scanning, and that a
// flatter composition still reads as distinct sections on a phone.
//
// So this asserts the rendered result: rows are separated by a real painted
// divider rather than by nothing, the page never scrolls sideways, and the
// section labels remain visible at every width.
//
// NOT claimed: that it looks good. Automation cannot judge that; the visual
// critique is in the PR body.

const WIDTHS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1440, height: 900 },
] as const;

/**
 * The shared memory seed creates exactly ONE treated area, so a divider test
 * guarded on "at least two rows" could never run — and on the first pass it
 * SKIPPED, silently taking the slice's central claim with it. A visibly
 * skipped assertion is better than a falsely passing one, but it still proved
 * nothing about whether flattening cost scanning.
 *
 * So a second area is seeded here rather than in the shared helper, which
 * other specs depend on. Mirrors the helper's own inserts with a different
 * area and side.
 */
async function addSecondArea(studioId: string, clientId: string): Promise<void> {
  const rows = await sql<{ id: string }>(
    `select s.id from public.sessions s
      where s.client_id = $1 and s.studio_id = $2
      order by s.started_at desc limit 1`,
    [clientId, studioId],
  );
  const sessionId = rows[0]?.id;
  if (!sessionId) throw new Error("fixture: no prior session to attach a second area to");

  const blockId = randomUUID();
  await sql(
    `insert into public.session_blocks
       (id, studio_id, session_id, sort_order, primary_area, side, mode, apilus_modality,
        energy_level, minutes_performed, machine_frequency, probe_label,
        caution_for_next_session, caution_note)
     values ($1,$2,$3,2,'Chin','right','thermolysis','Synchro',
        7, 15, '27.12 MHz', 'Ballet · Gold · Two-piece · F3 Short', false, null)`,
    [blockId, studioId, sessionId],
  );
  await sql(
    `insert into public.session_block_areas (id, studio_id, session_block_id, area, laterality, display_order)
     values ($1,$2,$3,'Chin','right',0)`,
    [randomUUID(), studioId, blockId],
  );
  await sql(
    `insert into public.electrolysis_entries
       (id, session_id, block_id, area, areas, mode, energy_level, minutes_performed,
        machine_frequency, hairs_treated)
     values ($1,$2,$3,'Chin',array['Chin']::text[],'thermo',7,15,'27.12 MHz',30)`,
    [randomUUID(), sessionId, blockId],
  );
}

async function openDashboardMemory(page: Page) {
  const seed = await seedE2eStudio();
  // A caution note is required by the seed helper, and it is also what makes
  // the BLUE callout render — the surface whose fourth label spelling this
  // slice reconciled. Seeding without one would have proved the flattening on
  // a card missing the very region under test.
  const { clientId } = await seedE2eDashboardMemoryClient(seed, {
    cautionNote: "E2E caution: watch the upper lip for reactive erythema.",
    nextVisitNote: "E2E next visit: drop to 3.5s dwell if reaction persists.",
  });
  await addSecondArea(seed.studioId, clientId);
  await loginAsOwner(page, seed);
  await page.goto("/dashboard");
  const toggle = page.getByTestId("dashboard-memory-toggle").first();
  if (await toggle.count()) await toggle.click();
  return seed;
}

for (const vp of WIDTHS) {
  test.describe(`UI-06 at ${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("no horizontal overflow after flattening", async ({ page }) => {
      await openDashboardMemory(page);
      // The whole point of a flatter composition is that it fits better, not
      // worse. A flattened row that overflows would be a regression, not polish.
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, `${vp.name} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
    });

    test("flattened rows are still separated by a PAINTED divider", async ({ page }) => {
      await openDashboardMemory(page);
      const rows = page.getByTestId("prep-setup-area");
      await expect(rows.first()).toBeVisible({ timeout: 20_000 });
      // ASSERTED, not skipped. Two areas are seeded above precisely so this
      // claim always runs; fewer than two now means the FIXTURE broke, which
      // must fail rather than quietly excuse the assertion.
      expect(
        await rows.count(),
        "fixture must seed two areas so separation is observable",
      ).toBeGreaterThanOrEqual(2);

      // Asserting the COMPUTED border, not the class: a tokened divider that
      // failed to resolve would still carry `divide-line` in the class list
      // while painting nothing, and scanning would be gone.
      //
      // EDGE-AGNOSTIC, and that correction matters. The first version measured
      // `borderTopWidth` on the second row and failed with 0 at every width —
      // which I nearly read as "the flattening removed the separation". It had
      // not: Tailwind v4's `divide-y` compiles to
      //   .divide-y > :not(:last-child) { border-bottom-width: 1px }
      // so the separator lives on the BOTTOM of every row except the last, and
      // border-top is legitimately 0. Checking the compiled CSS rather than
      // trusting the assertion stopped me changing working code.
      //
      // So this asks the real question — is there a painted horizontal rule
      // BETWEEN two rows — and accepts it on either edge, which also means the
      // test survives Tailwind changing which edge it uses.
      const painted = await rows.first().evaluate((el) => {
        const row = el as HTMLElement;
        const next = row.nextElementSibling as HTMLElement | null;
        const read = (e: HTMLElement) => {
          const cs = getComputedStyle(e);
          return {
            top: parseFloat(cs.borderTopWidth || "0"),
            bottom: parseFloat(cs.borderBottomWidth || "0"),
            topColour: cs.borderTopColor,
            bottomColour: cs.borderBottomColor,
          };
        };
        return { first: read(row), second: next ? read(next) : null };
      });
      expect(painted.second, "needs a second row to separate from").not.toBeNull();

      const bottomOfFirst = painted.first.bottom;
      const topOfSecond = painted.second!.top;
      expect(
        Math.max(bottomOfFirst, topOfSecond),
        `no painted rule between rows (bottom=${bottomOfFirst}, top=${topOfSecond})`,
      ).toBeGreaterThan(0);

      const colour = bottomOfFirst > 0 ? painted.first.bottomColour : painted.second!.topColour;
      expect(colour).not.toBe("rgba(0, 0, 0, 0)");
      expect(colour).not.toBe("transparent");
    });

    test("sections stay distinguishable — labels visible, rows not collapsed", async ({
      page,
    }) => {
      await openDashboardMemory(page);
      const card = page.getByTestId("appointment-prep-memory").first();
      await expect(card).toBeVisible({ timeout: 20_000 });

      // A flatter card must not become an undifferentiated wall of text: the
      // shared section labels are what carry the grouping now that the boxes
      // are gone, so they have to be ON SCREEN at every width.
      //
      // THIRD VERSION OF THIS ASSERTION, and the first two were both wrong in
      // opposite directions:
      //
      //   count() > 0                  too weak — passes for hidden labels,
      //                                which is what Codex flagged
      //   toBeVisible() on p/h2/h3/h4/span
      //   filtered by capitalised text too strong AND imprecise — that locator
      //                                was a heuristic for "looks like a label"
      //                                and swept in unrelated elements that are
      //                                legitimately hidden, so it failed on
      //                                correct markup at all three widths
      //
      // The claim is about SECTION LABELS specifically, so this targets the
      // primitive's own signature (uppercase + tracking-wider) instead of
      // guessing from tag and capitalisation. Every label the card actually
      // renders must be visible with a real box; the failure message names the
      // offending element so a future failure is diagnosable rather than a
      // second round of guessing.
      const labels = card.locator('[class*="uppercase"][class*="tracking-wider"]');
      const n = await labels.count();
      expect(n, "the card must render section labels").toBeGreaterThan(0);

      for (let i = 0; i < n; i += 1) {
        const label = labels.nth(i);
        const info = await label.evaluate((el) => {
          const e = el as HTMLElement;
          const cs = getComputedStyle(e);
          const r = e.getBoundingClientRect();
          return {
            text: (e.textContent ?? "").trim().slice(0, 40),
            cls: e.className,
            display: cs.display,
            visibility: cs.visibility,
            w: r.width,
            h: r.height,
          };
        });
        expect(
          info.display !== "none" && info.visibility !== "hidden",
          `label ${i} "${info.text}" is hidden (display=${info.display} visibility=${info.visibility} class="${info.cls}")`,
        ).toBe(true);
        expect(
          info.w > 0 && info.h > 0,
          `label ${i} "${info.text}" has no area (${info.w}x${info.h})`,
        ).toBe(true);
      }

      // Rows must retain real height — flattening should not have produced
      // zero-height or overlapping rows.
      const rows = page.getByTestId("prep-setup-area");
      if (await rows.count()) {
        const h = await rows.first().evaluate((el) => (el as HTMLElement).offsetHeight);
        expect(h, "flattened row collapsed").toBeGreaterThan(16);
      }
    });
  });
}

test.describe("UI-06 motion", () => {
  test("the memory cards introduce NO transition or animation", async ({ page }) => {
    await openDashboardMemory(page);
    const card = page.getByTestId("appointment-prep-memory").first();
    await expect(card).toBeVisible({ timeout: 20_000 });

    // find-animation-opportunities rejected every candidate on this surface:
    // server-rendered branches have no client state change to bridge, list
    // staggers would delay clinical data on a many-times-daily surface, and the
    // <details> accordions would need a client boundary plus a height
    // animation. This asserts that verdict held in the rendered output.
    const moving = await card.evaluate((root) => {
      const all = [root, ...Array.from(root.querySelectorAll("*"))];
      return all.filter((el) => {
        const cs = getComputedStyle(el as HTMLElement);
        const dur = (cs.transitionDuration || "0s")
          .split(",")
          .some((d) => parseFloat(d) > 0);
        const anim = cs.animationName !== "none" && cs.animationName !== "";
        return dur || anim;
      }).length;
    });
    expect(moving, `${moving} element(s) in the card animate`).toBe(0);
  });
});
