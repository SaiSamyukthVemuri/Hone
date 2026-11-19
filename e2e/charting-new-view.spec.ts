import path from "node:path";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eMember,
  seedNoStudioAuthUser,
  seedE2eDraftElectrolysisSession,
  seedE2eLegacyBlock,
  seedE2eChartedThermolysisBlock,
  getSessionBlockCount,
  getSavedBlockSetup,
  sql,
} from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";
import { sessionPaymentRegion } from "../e2e-payment/helpers/checkout-flow";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// HON-80: the optional charting "New view" switch, in a real browser on the LOCAL stack, with a LOCAL SYNTHETIC studio only (seedE2eStudio makes the
// studio, the owner and the client; nothing hosted is read, copied or touched).
//
// OPT-IN. The switch is shown only for a studio the rollout setting names, and an empty setting hides it for everyone. This spec therefore runs only
// when the web server is started with HONE_CHARTING_NEW_VIEW_STUDIO_IDS=all (the harness passes the shell's environment through to the app server),
// and is SKIPPED otherwise, so ordinary lanes are unaffected. The setting's value is a local test value; no deployed environment is involved.
//
// HOW THE SETTING REACHES THE SERVER. e2e/helpers/local-env.ts (tracked, not edited here) does not name this variable. Playwright applies webServer.env OVER
// the inherited environment, so a variable exported in the shell that launches Playwright reaches the app server unchanged. The first test below proves it
// did, and fails loudly if it did not, rather than skipping or passing without the switch.
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

// Touch floor and overflow, asserted in every key state on every device project.
async function expectTouchFloorAndNoOverflow(page: Page, state: string) {
  const toggleBox = await page.getByTestId("charting-view-toggle").boundingBox();
  expect(toggleBox, `${state}: the switch is on screen`).not.toBeNull();
  expect(toggleBox!.height, `${state}: the switch is at least 44px tall`).toBeGreaterThanOrEqual(44);
  const save = page.getByTestId("save-treatment-area");
  if (await save.count()) {
    const b = await save.first().boundingBox();
    expect(b!.height, `${state}: Save is at least 44px tall`).toBeGreaterThanOrEqual(44);
  }
  await expectNoHorizontalOverflow(page);
}

async function setView(page: Page, view: "current" | "new") {
  const toggle = page.getByTestId("charting-view-toggle");
  if ((await toggle.getAttribute("aria-checked")) === String(view === "new")) return;
  await toggle.click();
  await expect(root(page)).toHaveAttribute("data-charting-view", view, { timeout: T });
}

async function addBlock(page: Page, area: string, note: string) {
  await page.getByTestId("add-settings-block-cta").click();
  await page.getByRole("button", { name: area, exact: true }).click();
  await page.getByTestId("additional-notes").fill(note);
  await page.getByTestId("save-treatment-area").click();
}

async function blockRows(sessionId: string) {
  return sql<{ primary_area: string; comments: string | null }>(
    `select b.primary_area, e.comments from public.session_blocks b
       left join lateral (select comments from public.electrolysis_entries where block_id = b.id and deleted_at is null order by created_at limit 1) e on true
      where b.session_id = $1 and b.deleted_at is null order by b.sort_order, b.created_at`,
    [sessionId],
  );
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
    await expect(toggle, "the switch must exist: start the app server with HONE_CHARTING_NEW_VIEW_STUDIO_IDS=all in its environment").toBeVisible({ timeout: T });
    await expect(toggle).toHaveAttribute("role", "switch");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(root(page)).toHaveAttribute("data-charting-view", "current");
    for (const n of [1, 2, 3, 4, 5]) await expect(page.getByTestId(`new-view-step-${n}`)).toHaveCount(0);
    await expect(page.getByTestId("charting-view-summary")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectTouchFloorAndNoOverflow(page, "current, default");
    await shot(page, testInfo, "1-current-default");
  });

  await test.step("open the block form and type unsaved values", async () => {
    await page.getByTestId("add-settings-block-cta").click();
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await page.getByTestId("obs-chip-Coarse hair").click();
    await page.getByTestId("additional-notes").fill("unsaved note, not yet saved");
    await expectTouchFloorAndNoOverflow(page, "current, block form open");
  });

  await test.step("switch to New: no charting request, no navigation, the same DOM node, the unsaved values kept, no row written", async () => {
    await page.getByTestId("charting-view-content").evaluate((el) => el.setAttribute("data-e2e-same-node", "1"));
    const posts: { action: string | undefined; body: string | null }[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST") posts.push({ action: r.headers()["next-action"], body: r.postData() });
    });
    const before = page.url();
    await toggle.click();
    await expect(root(page)).toHaveAttribute("data-charting-view", "new", { timeout: T });
    // The only thing a switch may ask the server for is to remember the choice: at most ONE action request, never a charting save.
    await expect.poll(() => posts.length, { timeout: T }).toBe(1);
    // That one request is the preference action (a server action carrying only the closed value "new"), and no block row exists.
    expect(posts[0].action, "the POST is a server action").toBeTruthy();
    expect(JSON.parse(posts[0].body ?? "null")).toEqual(["new"]);
    await page.waitForTimeout(500);
    expect(posts.length, "nothing else was posted after the switch").toBe(1);
    expect(page.url()).toBe(before);
    await expect(page.getByTestId("charting-view-content")).toHaveAttribute("data-e2e-same-node", "1");
    await expect(page.getByTestId("additional-notes")).toHaveValue("unsaved note, not yet saved");
    await expect(page.getByTestId("obs-chip-Coarse hair")).toHaveAttribute("aria-pressed", "true");
    expect(await getSessionBlockCount(sessionId)).toBe(0);
    await expectTouchFloorAndNoOverflow(page, "new, block form open");
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

test("multi-block and edit and re-save: two areas saved in New read in Current; an edit in either view reads in the other after a reload", async ({ page }) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);
  const url = `/clients/${clientId}/sessions/${sessionId}`;
  await page.goto(url);
  await expect(page.getByTestId("charting-view-toggle"), "the switch must exist: start the app server with HONE_CHARTING_NEW_VIEW_STUDIO_IDS=all").toBeVisible({ timeout: T });

  await test.step("save two blocks with different areas and notes from New", async () => {
    await setView(page, "new");
    await addBlock(page, "Chin", "chin note A");
    await expect.poll(() => getSessionBlockCount(sessionId), { timeout: T }).toBe(1);
    await addBlock(page, "Upper lip", "lip note B");
    await expect.poll(() => getSessionBlockCount(sessionId), { timeout: T }).toBe(2);
    await expectTouchFloorAndNoOverflow(page, "new, two blocks saved");
  });

  await test.step("Current shows both, with the same areas and notes", async () => {
    await page.goto(url);
    await setView(page, "current");
    await expect(page.getByTestId(/^edit-area-/)).toHaveCount(2, { timeout: T });
    const rows = await blockRows(sessionId);
    expect(rows.map((r) => [r.primary_area, r.comments])).toEqual([["Chin", "chin note A"], ["Upper lip", "lip note B"]]);
    await expectTouchFloorAndNoOverflow(page, "current, two blocks");
  });

  await test.step("edit the first block in Current, save, reload: New shows the edit", async () => {
    await page.getByTestId(/^edit-area-/).first().click();
    await page.getByTestId("additional-notes").fill("chin note A, edited in Current");
    await expectTouchFloorAndNoOverflow(page, "current, edit form open");
    await page.getByTestId("save-treatment-area").click();
    await expect.poll(async () => (await blockRows(sessionId))[0].comments, { timeout: T }).toBe("chin note A, edited in Current");
    await page.goto(url);
    await setView(page, "new");
    await page.getByTestId(/^edit-area-/).first().click();
    await expect(page.getByTestId("additional-notes")).toHaveValue("chin note A, edited in Current", { timeout: T });
    await expectTouchFloorAndNoOverflow(page, "new, edit form open");
  });

  await test.step("edit the second block in New, save, reload: Current shows the edit; still exactly two blocks", async () => {
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByTestId(/^edit-area-/).nth(1).click();
    await page.getByTestId("additional-notes").fill("lip note B, edited in New");
    await page.getByTestId("save-treatment-area").click();
    await expect.poll(async () => (await blockRows(sessionId))[1].comments, { timeout: T }).toBe("lip note B, edited in New");
    await page.goto(url);
    await setView(page, "current");
    await page.getByTestId(/^edit-area-/).nth(1).click();
    await expect(page.getByTestId("additional-notes")).toHaveValue("lip note B, edited in New", { timeout: T });
    expect(await getSessionBlockCount(sessionId)).toBe(2);
  });
});

test("history: sessions saved before the machine-first model, and an older machine block, open and read the same in both views", async ({ page }) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  // An old-style block with only an area (no machine, no profile version), and an older thermolysis machine block.
  await seedE2eLegacyBlock(seed, sessionId, { primaryArea: "Chin", sortOrder: 0 });
  await seedE2eChartedThermolysisBlock(seed, sessionId, {
    primaryArea: "Upper lip", energyLevel: 3, machineFrequency: "13.56 MHz", thermolysisIntensityPercent: 40, thermolysisDurationSeconds: 2, pulseCount: 1, minutesPerformed: 7,
  });
  await loginAsOwner(page, seed);
  const url = `/clients/${clientId}/sessions/${sessionId}`;
  await page.goto(url);
  await expect(page.getByTestId("charting-view-toggle"), "the switch must exist: start the app server with HONE_CHARTING_NEW_VIEW_STUDIO_IDS=all").toBeVisible({ timeout: T });
  // CONTENT, not counts: the text of every saved block section (area, machine, settings) is read in each view and must be identical.
  const read = async () => {
    // The nearest enclosing section of each Edit button is that block's own section, so view furniture around the list is not compared.
    const sections = page.getByTestId(/^edit-area-/).locator("xpath=ancestor::section[1]");
    return {
      edits: await page.getByTestId(/^edit-area-/).count(),
      sections: (await sections.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()),
      body: (await page.locator("main").innerText()).includes("Application error"),
    };
  };
  await setView(page, "current");
  const current = await read();
  await setView(page, "new");
  const next = await read();
  expect(current.edits).toBe(2);
  expect(next.edits, "New view lists the same saved blocks as Current").toBe(current.edits);
  expect(current.sections.length, "block sections were found").toBeGreaterThan(0);
  expect(current.sections.join(" "), "the old-style area is shown").toContain("Chin");
  expect(current.sections.join(" "), "the older machine block's area and frequency are shown").toMatch(/Upper lip[\s\S]*13\.56|13\.56[\s\S]*Upper lip/);
  expect(next.sections, "each block's text (areas, machine, settings) is identical in New and Current").toEqual(current.sections);
  expect(current.body || next.body, "neither view shows an error screen").toBe(false);
  expect(await getSessionBlockCount(sessionId)).toBe(2);
  await expectTouchFloorAndNoOverflow(page, "new, historical blocks");
});

test("next-visit note: saved in one view, shown and recalled in the other", async ({ page }) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);
  const url = `/clients/${clientId}/sessions/${sessionId}`;
  await page.goto(url);
  await expect(page.getByTestId("charting-view-toggle"), "the switch must exist: start the app server with HONE_CHARTING_NEW_VIEW_STUDIO_IDS=all").toBeVisible({ timeout: T });
  const note = async () => (await sql<{ n: string | null }>(`select next_session_note as n from public.sessions where id = $1`, [sessionId]))[0]?.n;

  await setView(page, "new");
  const box = page.getByPlaceholder(/Upper lip: start lower/);
  await box.fill("from New: start lower, check sensitivity");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect.poll(note, { timeout: T }).toBe("from New: start lower, check sensitivity");
  await page.goto(url);
  await setView(page, "current");
  await expect(page.getByPlaceholder(/Upper lip: start lower/)).toHaveValue("from New: start lower, check sensitivity", { timeout: T });

  await page.getByPlaceholder(/Upper lip: start lower/).fill("from Current: keep the same settings");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect.poll(note, { timeout: T }).toBe("from Current: keep the same settings");
  await page.goto(url);
  await setView(page, "new");
  await expect(page.getByPlaceholder(/Upper lip: start lower/)).toHaveValue("from Current: keep the same settings", { timeout: T });
  await expectTouchFloorAndNoOverflow(page, "new, next-visit note");
});

test("roles: a practitioner sees no payment or price in either view; a receptionist cannot open the chart at all", async ({ page, browser }, testInfo) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  const url = `/clients/${clientId}/sessions/${sessionId}`;

  const member = await seedE2eMember(seed);
  await loginByMagicLink(page, member.email);
  await page.goto(url);
  await expect(page.getByTestId("charting-view-toggle"), "the switch must exist for a practitioner: start the app server with HONE_CHARTING_NEW_VIEW_STUDIO_IDS=all").toBeVisible({ timeout: T });
  for (const view of ["current", "new"] as const) {
    await setView(page, view);
    await expect(sessionPaymentRegion(page), `${view}: no payment region for a practitioner (the owner positive control is in the payment-lane spec)`).toHaveCount(0);
    await expect(page.getByRole("button", { name: /prepare session payment|run charge/i }), `${view}: no charge controls`).toHaveCount(0);
    expect(await page.getByTestId("charting-view-root").innerText(), `${view}: no price shown`).not.toMatch(/\$\s?\d/);
    await expectTouchFloorAndNoOverflow(page, `${view}, practitioner`);
  }

  // A receptionist has no practitioner row: the same page sends them to /no-access, in both stored preferences.
  const r = await seedNoStudioAuthUser();
  const uid = (await sql<{ id: string }>(`select id from auth.users where lower(email) = lower($1)`, [r.email]))[0]!.id;
  await sql(`insert into public.studio_receptionists (studio_id, user_id, display_name, active) values ($1, $2, 'Synthetic Front Desk', true)`, [seed.studioId, uid]);
  // A second context does not inherit the project's browser options: WebKit needs the same CSP bypass the webkit projects set (see the config).
  const ctx = await browser.newContext({ bypassCSP: testInfo.project.name.startsWith("webkit") });
  try {
    const p2 = await ctx.newPage();
    await p2.goto("/login");
    await p2.getByLabel("I am using my invited email address").check();
    await p2.locator("#login-email").fill(r.email);
    const seen = await listMessageIds(r.email);
    await p2.getByRole("button", { name: /send magic link/i }).click();
    await p2.goto(await waitForMagicLink(r.email, E2E_APP_ORIGIN, { excludeIds: seen }));
    await p2.waitForURL(/\/no-access/, { timeout: 30_000 });
    await p2.goto(url);
    await p2.waitForURL(/\/no-access/, { timeout: 30_000 });
    await expect(p2.getByTestId("charting-view-toggle")).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});
