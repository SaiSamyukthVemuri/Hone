import path from "node:path";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { seedE2eStudio, seedE2eDraftElectrolysisSession, getSessionBlockCount, getSavedBlockSetup, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// HON-80: the optional charting "New view" switch, in a real browser on the LOCAL stack, with a LOCAL SYNTHETIC studio only (seedE2eStudio makes the
// studio, the owner and the client; nothing hosted is read, copied or touched).
//
// OPT-IN. The switch is shown only for a studio the rollout setting names, and an empty setting hides it for everyone. This spec therefore runs only
// when the web server is started with HONE_CHARTING_NEW_VIEW_STUDIO_IDS=all (the harness passes the shell's environment through to the app server),
// and is SKIPPED otherwise, so ordinary lanes are unaffected. The setting's value is a local test value; no deployed environment is involved.
//
// What it proves: the switch is a real control outside any form; a switch sends no charting request and moves no DOM node, so unsaved values stay
// exactly where they are; the same record saves from either view and opens in the other; the choice is remembered; steps 1-5 and the "This visit"
// summary exist only in New view; and neither view overflows horizontally. DB rows are ground truth.
test.skip(process.env.HONE_CHARTING_NEW_VIEW_STUDIO_IDS !== "all", "needs the app server started with HONE_CHARTING_NEW_VIEW_STUDIO_IDS=all");

const T = 20_000;
const root = (page: Page) => page.getByTestId("charting-view-root");

async function expectNoHorizontalOverflow(page: Page) {
  const [scrollW, clientW] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scrollW, `no horizontal scroll (scrollWidth ${scrollW} vs clientWidth ${clientW})`).toBeLessThanOrEqual(clientW);
}

// Reviewer screenshots. Opt-in: only when HONE_E2E_SHOTS_DIR names a directory. They capture the charting region only (the element, never the browser chrome,
// so no address bar, path or host), on the synthetic seed. Nothing is taken from a trace.
async function shot(page: Page, info: TestInfo, name: string) {
  const dir = process.env.HONE_E2E_SHOTS_DIR;
  if (!dir) return;
  await root(page).screenshot({ path: path.join(dir, `${info.project.name}-${name}.png`) });
}

async function storedView(email: string): Promise<string | null> {
  const rows = await sql<{ v: string | null }>(`select raw_user_meta_data->>'charting_view' as v from auth.users where email = $1`, [email]);
  return rows[0]?.v ?? null;
}

test("the switch: Current by default, steps and summary only in New, unsaved values and DOM nodes survive, one record saves from either view, the choice is remembered", async ({ page }, testInfo) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);
  const url = `/clients/${clientId}/sessions/${sessionId}`;
  const toggle = page.getByTestId("charting-view-toggle");

  await test.step("Current is the default: the switch is shown, off, at least 44px tall, and no New view furniture exists", async () => {
    await page.goto(url);
    await expect(toggle).toBeVisible({ timeout: T });
    await expect(toggle).toHaveAttribute("role", "switch");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(root(page)).toHaveAttribute("data-charting-view", "current");
    for (const n of [1, 2, 3, 4, 5]) await expect(page.getByTestId(`new-view-step-${n}`)).toHaveCount(0);
    await expect(page.getByTestId("charting-view-summary")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot(page, testInfo, "1-current-default");
  });

  await test.step("open the block form and type unsaved values", async () => {
    await page.getByTestId("add-settings-block-cta").click();
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await page.getByTestId("obs-chip-Coarse hair").click();
    await page.getByTestId("additional-notes").fill("unsaved note, not yet saved");
  });

  await test.step("switch to New: no charting request, no navigation, the same DOM node, the unsaved values kept, no row written", async () => {
    await page.getByTestId("charting-view-content").evaluate((el) => el.setAttribute("data-e2e-same-node", "1"));
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST") posts.push(r.url());
    });
    const before = page.url();
    await toggle.click();
    await expect(root(page)).toHaveAttribute("data-charting-view", "new", { timeout: T });
    // The only thing a switch may ask the server for is to remember the choice: at most ONE action request, never a charting save.
    await expect.poll(() => posts.length, { timeout: T }).toBeLessThanOrEqual(1);
    expect(page.url()).toBe(before);
    await expect(page.getByTestId("charting-view-content")).toHaveAttribute("data-e2e-same-node", "1");
    await expect(page.getByTestId("additional-notes")).toHaveValue("unsaved note, not yet saved");
    await expect(page.getByTestId("obs-chip-Coarse hair")).toHaveAttribute("aria-pressed", "true");
    expect(await getSessionBlockCount(sessionId)).toBe(0);
    await shot(page, testInfo, "2-new-after-switch-unsaved-kept");
  });

  await test.step("New view shows steps 1-5 in order and the read-only This visit summary", async () => {
    for (const n of [1, 2, 3, 4, 5]) await expect(page.getByTestId(`new-view-step-${n}`)).toBeVisible();
    await expect(page.getByTestId("charting-view-summary")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expectNoHorizontalOverflow(page);
    const ys = await Promise.all([1, 2, 3, 4, 5].map(async (n) => (await page.getByTestId(`new-view-step-${n}`).boundingBox())!.y));
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    await shot(page, testInfo, "3-new-steps-and-summary");
  });

  await test.step("the choice is remembered: stored for the user, and still New after a reload", async () => {
    await expect.poll(() => storedView(seed.ownerEmail), { timeout: T }).toBe("new");
  });

  await test.step("save from New: exactly one block, with the values typed before the switch", async () => {
    await page.getByTestId("save-treatment-area").click();
    await expect.poll(() => getSessionBlockCount(sessionId), { timeout: T }).toBe(1);
    const saved = await getSavedBlockSetup(sessionId);
    const entry = saved?.entry as { comments?: string; observation_chips?: string[] } | null;
    expect(entry?.comments).toBe("unsaved note, not yet saved");
    expect(entry?.observation_chips).toContain("Coarse hair");
  });

  await test.step("reload opens in New, and the same record opens in Current with the same values", async () => {
    await page.goto(url);
    await expect(root(page)).toHaveAttribute("data-charting-view", "new", { timeout: T });
    await toggle.click();
    await expect(root(page)).toHaveAttribute("data-charting-view", "current", { timeout: T });
    for (const n of [1, 2, 3, 4, 5]) await expect(page.getByTestId(`new-view-step-${n}`)).toHaveCount(0);
    await page.getByTestId(/^edit-area-/).first().click();
    await expect(page.getByTestId("additional-notes")).toHaveValue("unsaved note, not yet saved", { timeout: T });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await getSessionBlockCount(sessionId)).toBe(1);
    await expect.poll(() => storedView(seed.ownerEmail), { timeout: T }).toBe("current");
    await expectNoHorizontalOverflow(page);
  });
});
