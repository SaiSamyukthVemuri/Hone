import { test, expect, type Locator, type Page } from "@playwright/test";
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

/**
 * The section labels this slice's grouping claim actually depends on.
 *
 * WHY EXACT TEXT AND NOT A CLASS MATCH. The previous version asserted that
 * every element matching `[class*="uppercase"][class*="tracking-wider"]` was
 * visible — which proves nothing about PRESENCE. Five unrelated elements in
 * this card share that signature ("Last treatment" twice, "Watch today",
 * "Show", and the unmigrated h2/h4 headings), so "Areas treated" could vanish
 * entirely and the assertion would still pass on the distractors. Codex was
 * right; the operator was right to reject the head.
 *
 * "Areas treated" is additionally rendered by last-treatment-memory-card, so
 * the report is scoped to the prep card rather than the page.
 */
const REQUIRED_LABELS = ["Areas treated", "Last session notes", "What happened"] as const;

/** Every label-signature element in the card, with exact text and real visibility. */
async function labelReport(
  card: Locator,
): Promise<Array<{ text: string; visible: boolean; w: number; h: number }>> {
  return card.evaluate((root: Element) =>
    Array.from(
      root.querySelectorAll('[class*="uppercase"][class*="tracking-wider"]'),
    ).map((el) => {
      const e = el as HTMLElement;
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return {
        text: (e.textContent ?? "").trim(),
        visible:
          cs.display !== "none" &&
          cs.visibility !== "hidden" &&
          r.width > 0 &&
          r.height > 0,
        w: r.width,
        h: r.height,
      };
    }),
  );
}

/** Which required labels are absent or invisible. Empty array = the claim holds. */
function missingRequired(
  report: Array<{ text: string; visible: boolean }>,
): string[] {
  const out: string[] = [];
  for (const want of REQUIRED_LABELS) {
    const exact = report.filter(
      (r) => r.text.toLowerCase() === want.toLowerCase(),
    );
    if (exact.length === 0) out.push(`${want}: ABSENT`);
    else if (!exact.some((r) => r.visible)) out.push(`${want}: present but HIDDEN`);
  }
  return out;
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

      // EACH REQUIRED LABEL, INDEPENDENTLY, BY EXACT TEXT.
      //
      // The claim is that typography still carries the grouping now the boxes
      // are gone, so the three shared labels have to be present AND visible —
      // not merely that something label-shaped is visible somewhere.
      const report = await labelReport(card);
      const missing = missingRequired(report);
      expect(
        missing,
        `required labels not satisfied: ${missing.join(" | ")} — saw: ${report.map((r) => `"${r.text}"${r.visible ? "" : "(hidden)"}`).join(", ")}`,
      ).toEqual([]);

      // AND THE DISTRACTORS MUST NOT BE ABLE TO STAND IN. These share the class
      // signature and are deliberately NOT in the required set; proving they
      // are present alongside shows the exact-text match is doing real work
      // rather than the locator happening to match only what I wanted.
      //
      // The distractor names here are MEASURED, not guessed. My first version
      // asserted a distractor called "show"; the real element is a <summary>
      // whose textContent concatenates its heading and both toggle spans into
      // "setup usedshowhide". Guessing a string instead of reading one is the
      // same habit this whole slice keeps tripping over, so the brittle
      // concatenation is not pinned — only the two stable distractors are named,
      // plus a count that survives that summary's text changing.
      const seen = report.map((r) => r.text.toLowerCase());
      const requiredLower = REQUIRED_LABELS.map((l) => l.toLowerCase());

      for (const distractor of ["last treatment", "watch today"]) {
        expect(
          seen,
          `expected distractor "${distractor}" present but NOT counted as required — saw: ${seen.join(", ")}`,
        ).toContain(distractor);
      }

      const nonRequired = seen.filter((t) => !requiredLower.includes(t));
      expect(
        nonRequired.length,
        `the locator must match unrelated labels too, or this proof is not discriminating — saw: ${seen.join(", ")}`,
      ).toBeGreaterThanOrEqual(3);

      for (const want of REQUIRED_LABELS) {
        expect(
          seen.filter((t) => t === want.toLowerCase()).length,
          `"${want}" must be matched by exact text in this card`,
        ).toBeGreaterThan(0);
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

test.describe("UI-06 label proof: negative control", () => {
  test("hiding ONE required label turns the proof RED, and only for that label", async ({
    page,
  }) => {
    await openDashboardMemory(page);
    const card = page.getByTestId("appointment-prep-memory").first();
    await expect(card).toBeVisible({ timeout: 20_000 });

    // Baseline: the claim holds.
    expect(missingRequired(await labelReport(card))).toEqual([]);

    // Hide EXACTLY ONE required label, leaving every unrelated matching
    // element — "Last treatment", "Watch today", "Show" — untouched. This is
    // the mutation the previous assertion could not detect: it would have
    // stayed green on the surviving distractors.
    const hidden = await card.evaluate((root) => {
      const el = Array.from(
        root.querySelectorAll('[class*="uppercase"][class*="tracking-wider"]'),
      ).find((e) => (e.textContent ?? "").trim().toLowerCase() === "areas treated");
      if (!el) return null;
      (el as HTMLElement).style.display = "none";
      return (el.textContent ?? "").trim();
    });
    expect(hidden, "fixture: the label to hide must exist").toBe("Areas treated");

    const after = missingRequired(await labelReport(card));

    // RED, and specifically about the label that was hidden...
    expect(after.some((m) => m.startsWith("Areas treated"))).toBe(true);
    // ...and NOT about the ones left alone, so the control is specific rather
    // than merely failing.
    expect(after.some((m) => m.startsWith("Last session notes"))).toBe(false);
    expect(after.some((m) => m.startsWith("What happened"))).toBe(false);

    // The distractors are still on screen, which is the whole point: their
    // presence must not rescue the assertion.
    // PRESENCE AND VISIBILITY ARE DIFFERENT THINGS, which is the entire subject
    // of this repair and which I then conflated one more time here: `display:
    // none` HIDES the element, it does not remove it, so its text is still in
    // the report. My first version asserted the text had disappeared and failed
    // on correct behaviour — `missingRequired` had already classified it
    // correctly as "present but HIDDEN", which is why every assertion above
    // passed.
    //
    // So this asserts the property that actually changed: still in the DOM,
    // no longer visible, while the other two stay visible.
    const after2 = await labelReport(card);
    const byText = (t: string) =>
      after2.find((r) => r.text.toLowerCase() === t);

    const areas = byText("areas treated");
    expect(areas, "the hidden label is still in the DOM").toBeTruthy();
    expect(areas!.visible, "but it must no longer be visible").toBe(false);

    expect(byText("last session notes")?.visible, "untouched label stays visible").toBe(true);
    expect(byText("what happened")?.visible, "untouched label stays visible").toBe(true);

    // The distractors are still on screen, which is the whole point: their
    // presence must not rescue the assertion.
    expect(byText("last treatment")?.visible).toBe(true);
    expect(byText("watch today")?.visible).toBe(true);
  });
});
