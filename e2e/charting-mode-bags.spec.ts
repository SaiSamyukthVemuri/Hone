import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eDraftElectrolysisSession,
  getSessionBlockCount,
  sql,
  setPlatformRolloutMode,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// P3: the per-mode reading bags and the view switch, in a real browser on the LOCAL stack, LOCAL SYNTHETIC studio only (seedE2eStudio; nothing hosted is read or touched).
//
// THE ROLLOUT IS A DATABASE ROW. The bags exist only for a studio the platform rollout enables, so this spec sets the row to "all" on the OWNED LOCAL stack before
// its tests and back to "off" after them (files run serially, one worker). The first test fails loudly if the switch is absent, rather than passing without the feature.
//
// What it proves, with database rows as ground truth:
//   1. readings typed under one mode are KEPT (not saved) when another mode is picked, a notice names the mode and never the value, and picking the first mode back
//      restores them; entries shared by every mode (the note) survive the whole trip;
//   2. Save with readings parked for another mode ASKS first; confirming saves the shown mode only: the parked mode's column stays null while the shared note is written;
//   3. a view switch (Current <-> New) followed by a mode switch loses nothing: the bag survives both, and the restored value is what is saved.
test.beforeAll(async () => { await setPlatformRolloutMode("all"); });
test.afterAll(async () => { await setPlatformRolloutMode("off"); });

const T = 20_000;
const NOTICE = "Thermolysis readings is kept in this draft and will not be saved.";
const root = (page: Page) => page.getByTestId("charting-view-root");
const pill = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const intensity = (page: Page) => page.getByLabel("Thermolysis intensity %");
const notice = (page: Page) => page.getByTestId("hidden-mode-readings-notice");

async function openNewBlock(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByTestId("charting-view-toggle"), "the switch must exist: the platform rollout row must be set to all").toBeVisible({ timeout: T });
  await page.getByTestId("add-settings-block-cta").click();
  await pill(page, "Chin").click();
}

async function setView(page: Page, view: "current" | "new") {
  const toggle = page.getByTestId("charting-view-toggle");
  if ((await toggle.getAttribute("aria-checked")) === String(view === "new")) return;
  await toggle.click();
  await expect(root(page)).toHaveAttribute("data-charting-view", view, { timeout: T });
}

async function savedBlock(sessionId: string) {
  const rows = await sql<{ mode: string | null; thermolysis_intensity_percent: string | null; comments: string | null }>(
    `select b.mode, e.thermolysis_intensity_percent::text as thermolysis_intensity_percent, e.comments
       from public.session_blocks b
       left join lateral (select thermolysis_intensity_percent, comments from public.electrolysis_entries where block_id = b.id and deleted_at is null order by created_at limit 1) e on true
      where b.session_id = $1 and b.deleted_at is null order by b.sort_order, b.created_at`,
    [sessionId],
  );
  return rows;
}

test("a reading typed under one mode is kept when another mode is picked, named without its value, and restored when the first mode returns", async ({ page }) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);
  await openNewBlock(page, `/clients/${clientId}/sessions/${sessionId}`);

  await test.step("type a Thermolysis reading and a shared note", async () => {
    await pill(page, "Thermolysis").click();
    await intensity(page).fill("55");
    await page.getByTestId("additional-notes").fill("shared note");
    await expect(notice(page)).toHaveCount(0);
  });

  await test.step("pick Galvanic: the reading is parked, the notice names the mode and never the value, the shared note stays", async () => {
    await pill(page, "Galvanic").click();
    await expect(intensity(page)).toHaveCount(0);
    await expect(notice(page)).toHaveText(NOTICE);
    expect(await notice(page).textContent()).not.toContain("55");
    await expect(page.getByTestId("additional-notes")).toHaveValue("shared note");
  });

  await test.step("pick Thermolysis again: the reading is back, the notice is gone, and nothing was saved", async () => {
    await pill(page, "Thermolysis").click();
    await expect(intensity(page)).toHaveValue("55");
    await expect(page.getByTestId("additional-notes")).toHaveValue("shared note");
    await expect(notice(page)).toHaveCount(0);
    expect(await getSessionBlockCount(sessionId)).toBe(0);
  });
});

test("Save with readings parked for another mode asks first; confirming saves the shown mode only", async ({ page }) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);
  await openNewBlock(page, `/clients/${clientId}/sessions/${sessionId}`);

  await pill(page, "Thermolysis").click();
  await intensity(page).fill("55");
  await page.getByTestId("additional-notes").fill("shared note");
  await pill(page, "Galvanic").click();

  await test.step("Save is held: the question names the mode, never the value, and no block is written", async () => {
    await page.getByTestId("save-treatment-area").click();
    const ask = page.getByTestId("discard-readings-confirm");
    await expect(ask).toBeVisible({ timeout: T });
    await expect(ask).toContainText(`${NOTICE} Save without them?`);
    expect(await ask.textContent()).not.toContain("55");
    await page.waitForTimeout(500);
    expect(await getSessionBlockCount(sessionId)).toBe(0);
  });

  await test.step("Keep editing closes the question and still writes nothing", async () => {
    await page.getByTestId("discard-readings-keep").click();
    await expect(page.getByTestId("discard-readings-confirm")).toHaveCount(0);
    expect(await getSessionBlockCount(sessionId)).toBe(0);
  });

  await test.step("Save without them: one Galvanic block, the Thermolysis column is null, the shared note is written", async () => {
    await page.getByTestId("save-treatment-area").click();
    await page.getByTestId("discard-readings-save").click();
    await expect.poll(() => getSessionBlockCount(sessionId), { timeout: T }).toBe(1);
    const [row] = await savedBlock(sessionId);
    expect(row.mode).toBe("galv");
    expect(row.thermolysis_intensity_percent, "the parked mode's reading is NOT saved").toBeNull();
    expect(row.comments).toBe("shared note");
  });
});

test("a view switch followed by a mode switch loses nothing: the bag survives both and the restored value is the one saved", async ({ page }) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);
  await openNewBlock(page, `/clients/${clientId}/sessions/${sessionId}`);
  await setView(page, "current");

  await pill(page, "Thermolysis").click();
  await intensity(page).fill("55");
  await page.getByTestId("additional-notes").fill("shared note");
  await page.getByTestId("charting-view-content").evaluate((el) => el.setAttribute("data-e2e-same-node", "1"));

  await test.step("switch to New view, then pick Galvanic: the reading is parked and the form is the same DOM node", async () => {
    await setView(page, "new");
    await pill(page, "Galvanic").click();
    await expect(notice(page)).toHaveText(NOTICE);
    await expect(page.getByTestId("charting-view-content")).toHaveAttribute("data-e2e-same-node", "1");
    await expect(page.getByTestId("additional-notes")).toHaveValue("shared note");
  });

  await test.step("switch back to Current view with the reading still parked, then pick Thermolysis: 55 is restored", async () => {
    await setView(page, "current");
    await expect(notice(page)).toHaveText(NOTICE);
    await pill(page, "Thermolysis").click();
    await expect(intensity(page)).toHaveValue("55");
    await expect(notice(page)).toHaveCount(0);
    await expect(page.getByTestId("charting-view-content")).toHaveAttribute("data-e2e-same-node", "1");
    expect(await getSessionBlockCount(sessionId)).toBe(0);
  });

  await test.step("Save: one Thermolysis block with 55 and the shared note", async () => {
    await page.getByTestId("save-treatment-area").click();
    await expect.poll(() => getSessionBlockCount(sessionId), { timeout: T }).toBe(1);
    const [row] = await savedBlock(sessionId);
    expect(row.mode).toBe("thermo");
    expect(Number(row.thermolysis_intensity_percent)).toBe(55);
    expect(row.comments).toBe("shared note");
  });
});
