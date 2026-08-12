import { test, expect, type Page, type Locator } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eRepeatClientTwoAreas,
  getSessionBlocksWithFacts,
  getSessionBlockCount,
  getSessionContentDigest,
  getCopyOperationCount,
  bumpSourceBlockEnergy,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Repeat-client fast charting — "Start from last session".
//
// THE WORKFLOW THIS REPLACES, for a client Chloe has treated before:
//   1. tap "Preview last session's areas"
//   2. read the preview and review each draft card
//   3. tap "Add these areas to today's chart"
//   4. the panel closes and the page refreshes
//   5. scroll back down to the newly created area
//   6. tap "Edit" to reopen it
//   7. only NOW can she type today's minutes / hairs / observations
//
// THE WORKFLOW NOW: one tap, and she is typing. This spec MEASURES that —
// every practitioner interaction is counted through a wrapper, so the assertion
// "one click to typeable" is a number the run produced, not a claim.
//
// It also proves the two halves of the product invariant on the real stack:
// the reusable SETUP comes forward, and today's clinical FACTS do not.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const T = 20_000;

// Counts every interaction the practitioner makes, so "clicks to typeable" is
// measured rather than asserted by inspection.
function makeCounter() {
  let clicks = 0;
  return {
    get count() {
      return clicks;
    },
    async click(target: Locator) {
      clicks += 1;
      await target.click();
    },
  };
}

async function noOverflow(page: Page) {
  const [sw, cw] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(sw, `no horizontal overflow (${sw} vs ${cw})`).toBeLessThanOrEqual(cw);
}

test("ONE tap goes from repeat-client chart to typing today's facts; setup copies, outcomes do not @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, todaySessionId, previousSessionId } =
    await seedE2eRepeatClientTwoAreas(seed);
  await loginAsOwner(page, seed);
  const url = `/clients/${clientId}/sessions/${todaySessionId}`;
  const tap = makeCounter();

  // The historical visit, digested BEFORE anything happens today.
  const historyBefore = await getSessionContentDigest(previousSessionId);

  await test.step("the repeat client's empty chart leads with the fast path", async () => {
    await page.goto(url);
    await expect(page.getByTestId("copy-previous-fast-start")).toBeVisible({ timeout: T });
    await expect(page.getByTestId("copy-previous-fast-start")).toHaveText(
      /Start from last session/,
    );
    // The cautious route is still offered, secondary.
    await expect(page.getByTestId("copy-previous-preview")).toHaveText(/Preview first/);
    // The visit being brought forward is named WITHOUT opening a preview.
    await expect(page.getByTestId("copy-previous-idle-source-date")).toContainText(
      /From the visit on/,
    );
    expect(await getSessionBlockCount(todaySessionId)).toBe(0);
    await noOverflow(page);
  });

  const minutes = page.getByLabel("Minutes performed (optional)");
  const hairs = page.getByLabel("Hairs treated");

  await test.step("ONE tap lands directly in today's editor — no preview, no reopen", async () => {
    await tap.click(page.getByTestId("copy-previous-fast-start"));

    // Typeable, with no further interaction of any kind.
    await expect(minutes).toBeVisible({ timeout: T });
    await expect(hairs).toBeVisible();
    await expect(page.getByTestId("save-treatment-area")).toBeVisible();

    // THE MEASUREMENT: exactly one practitioner interaction to a typeable form.
    expect(tap.count, "taps from open chart to typing today's facts").toBe(1);

    // The removed loop, proven absent rather than described:
    //  * the preview panel never rendered;
    await expect(page.getByTestId("copy-previous-preview-panel")).toHaveCount(0);
    //  * the copy panel is gone (the chart is no longer empty);
    await expect(page.getByTestId("copy-previous-fast-start")).toHaveCount(0);
    //  * no "Edit" reopen was needed — the landed area exposes no Edit button
    //    precisely because it is already open;
    const blocks = await getSessionBlocksWithFacts(todaySessionId);
    expect(blocks).toHaveLength(2);
    const landing = blocks[0];
    await expect(page.getByTestId(`edit-area-${landing.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`area-section-${landing.id}`)).toHaveAttribute(
      "data-editing",
      "true",
    );
    //  * she never left this session page.
    expect(new URL(page.url()).pathname).toBe(url);
    await noOverflow(page);
  });

  await test.step("the copy brought BOTH areas forward, with their own settings", async () => {
    const blocks = await getSessionBlocksWithFacts(todaySessionId);
    expect(blocks.map((b) => b.primary_area)).toEqual(["Chin", "Upper lip"]);
    expect(blocks.map((b) => b.side)).toEqual(["left", "bilateral"]);
    expect(blocks.map((b) => Number(b.energy_level))).toEqual([11, 24]);
    expect(blocks.map((b) => b.machine_frequency)).toEqual(["13.56 MHz", "27.12 MHz"]);
    expect(blocks.map((b) => b.thermolysis_intensity_percent)).toEqual([44, 44]);
    // She lands in the FIRST area — the one the previous chart listed first.
    expect(blocks[0].sort_order).toBe(1);
    expect(blocks[0].primary_area).toBe("Chin");
  });

  await test.step("today's clinical facts start BLANK — nothing was manufactured", async () => {
    // In the form she is looking at.
    await expect(minutes).toHaveValue("");
    await expect(hairs).toHaveValue("");
    await expect(page.getByTestId("additional-notes")).toHaveValue("");
    await expect(page.getByTestId("obs-chip-Coarse hair")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // And in the database, on BOTH copied areas.
    for (const b of await getSessionBlocksWithFacts(todaySessionId)) {
      expect(b.minutes_performed).toBeNull();
      expect(b.hairs_treated).toBeNull();
      expect(b.comments).toBeNull();
      expect(b.tolerance_rating).toBeNull();
      expect(b.reaction_type).toBeNull();
      expect(b.reaction_notes).toBeNull();
      expect(b.caution_for_next_session).toBe(false);
      expect(b.caution_note).toBeNull();
      expect(b.observation_chips ?? []).toEqual([]);
    }
  });

  await test.step("she types TODAY'S facts and saves", async () => {
    await minutes.fill("12");
    await hairs.fill("140");
    await tap.click(page.getByTestId("obs-chip-Fine hair"));
    await page.getByTestId("additional-notes").fill("settled quickly today");
    await tap.click(page.getByTestId("save-treatment-area"));

    await expect
      .poll(async () => (await getSessionBlocksWithFacts(todaySessionId))[0].minutes_performed, {
        timeout: T,
      })
      .toBe(12);
  });

  await test.step("today's record holds TODAY'S facts, on the area she edited only", async () => {
    const blocks = await getSessionBlocksWithFacts(todaySessionId);
    expect(blocks[0].minutes_performed).toBe(12);
    expect(blocks[0].hairs_treated).toBe(140);
    expect(blocks[0].comments).toBe("settled quickly today");
    expect(blocks[0].observation_chips).toEqual(["Fine hair"]); // hers, not the source's
    // The reusable setup she did not touch survived the save.
    expect(blocks[0].primary_area).toBe("Chin");
    expect(Number(blocks[0].energy_level)).toBe(11);
    expect(blocks[0].machine_frequency).toBe("13.56 MHz");
    // The second copied area is untouched and still blank — saving one area did
    // not write facts into another.
    expect(blocks[1].primary_area).toBe("Upper lip");
    expect(blocks[1].minutes_performed).toBeNull();
    expect(blocks[1].hairs_treated).toBeNull();
  });

  await test.step("the HISTORICAL visit is byte-identical — Treatment Memory was not rewritten", async () => {
    expect(await getSessionContentDigest(previousSessionId)).toBe(historyBefore);
    // Its own outcomes are still its own.
    const prev = await getSessionBlocksWithFacts(previousSessionId);
    expect(prev).toHaveLength(2);
    expect(prev[0].minutes_performed).toBe(19);
    expect(prev[0].hairs_treated).toBe(71);
    expect(prev[0].comments).toBe("last visit narrative");
    expect(prev[0].observation_chips).toEqual(["Coarse hair"]);
  });

  await test.step("exactly ONE copy operation was ever committed", async () => {
    expect(await getCopyOperationCount(todaySessionId)).toBe(1);
  });
});

test("a double tap on the fast path does not duplicate the copied setup @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, todaySessionId } = await seedE2eRepeatClientTwoAreas(seed);
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${clientId}/sessions/${todaySessionId}`);

  const cta = page.getByTestId("copy-previous-fast-start");
  await expect(cta).toBeVisible({ timeout: T });

  // Two taps as fast as the browser will deliver them, with no wait between.
  await cta.dispatchEvent("click");
  await cta.dispatchEvent("click");

  await expect
    .poll(() => getSessionBlockCount(todaySessionId), { timeout: T })
    .toBe(2); // the two source areas — never four
  // Give any second in-flight request time to land before asserting stability.
  await expect(page.getByTestId("save-treatment-area")).toBeVisible({ timeout: T });
  expect(await getSessionBlockCount(todaySessionId)).toBe(2);
  expect(await getCopyOperationCount(todaySessionId)).toBe(1);
});

test("the fast path refuses a source that changed under it, and writes nothing @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, todaySessionId, previousSessionId } =
    await seedE2eRepeatClientTwoAreas(seed);
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${clientId}/sessions/${todaySessionId}`);
  await expect(page.getByTestId("copy-previous-fast-start")).toBeVisible({ timeout: T });

  // Freeze the fast path mid-flight: hold the COMMIT request — and ONLY the
  // commit — until the previous visit has been edited underneath it, so the
  // fingerprint the read returned is genuinely stale by the time the server
  // evaluates it. This is the real concurrency window, not a simulated one.
  //
  // The fast path issues TWO server-action POSTs to this URL (read, then
  // commit). Holding "the first POST" would hold the READ, which would then
  // observe the edit and succeed — proving nothing. The commit is identified by
  // its own argument name instead.
  let released: (() => void) | null = null;
  const editDone = new Promise<void>((resolve) => {
    released = resolve;
  });
  let held = false;
  await page.route("**/clients/**/sessions/**", async (route, request) => {
    const isCommit =
      request.method() === "POST" &&
      (request.postData() ?? "").includes("idempotencyKey");
    if (isCommit && !held) {
      held = true;
      await editDone;
    }
    await route.continue();
  });

  await page.getByTestId("copy-previous-fast-start").click();
  await expect
    .poll(() => held, { timeout: T, message: "the commit request was never identified" })
    .toBe(true);
  await bumpSourceBlockEnergy(previousSessionId);
  released!();

  // Fail CLOSED: a truthful, non-leaky message and zero rows.
  const alert = page.getByRole("alert").filter({ hasText: /previous visit|try again/i });
  await expect(alert.first()).toBeVisible({ timeout: T });
  const text = (await alert.first().textContent()) ?? "";
  expect(text).not.toMatch(/HN0\d\d|SQLSTATE|constraint|relation|session_copy_operations/i);
  expect(await getSessionBlockCount(todaySessionId)).toBe(0);
  expect(await getCopyOperationCount(todaySessionId)).toBe(0);
});

test("the retained Preview route still reviews and commits, and also lands in the editor @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, todaySessionId } = await seedE2eRepeatClientTwoAreas(seed);
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${clientId}/sessions/${todaySessionId}`);
  const tap = makeCounter();

  await tap.click(page.getByTestId("copy-previous-preview"));
  await expect(page.getByTestId("copy-previous-preview-panel")).toBeVisible({ timeout: T });
  // Reviewing is still non-destructive.
  expect(await getSessionBlockCount(todaySessionId)).toBe(0);
  // Both prior areas are offered for review.
  await expect(page.getByTestId(/^copy-draft-[0-9a-f-]+$/)).toHaveCount(2);

  // Removing one before committing still works — her ability to alter the copy
  // before recording today's treatment is preserved.
  await tap.click(page.getByTestId(/^copy-draft-remove-/).first());
  await expect(page.getByTestId(/^copy-draft-[0-9a-f-]+$/)).toHaveCount(1);

  await tap.click(page.getByTestId("copy-previous-commit"));
  await expect.poll(() => getSessionBlockCount(todaySessionId), { timeout: T }).toBe(1);

  // The reviewed route lands in today's editor too — the reopen loop is gone on
  // BOTH routes. It simply costs more taps than the fast path.
  await expect(page.getByTestId("save-treatment-area")).toBeVisible({ timeout: T });
  await expect(page.getByLabel("Minutes performed (optional)")).toHaveValue("");
  expect(tap.count, "the cautious route costs more taps than the fast path").toBe(3);
});
