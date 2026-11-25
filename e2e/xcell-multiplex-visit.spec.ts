import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { seedE2eStudio, seedE2eMember, setPlatformRolloutMode, sql } from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { planContractPublication } from "../lib/machines/contract-publication";

// ONE COMPLETE MULTIPLEX VISIT on the existing xCell chart, REAL browser, REAL local stack, synthetic studio/client/values.
// Desktop Chromium, and an emulated iPhone (see the project note in the run report: engine and emulation are stated there, not assumed).
const T = 20_000;

// HONE_E2E_RECORD=1 records a video of each run (the proof recordings); off otherwise.
test.use({ video: process.env.HONE_E2E_RECORD === "1" ? "on" : "off" });
test.beforeAll(async () => { await setPlatformRolloutMode("all"); });
test.afterAll(async () => { await setPlatformRolloutMode("off"); });

async function seedStudio() {
  const seed = await seedE2eStudio();
  const member = await seedE2eMember(seed);
  const clientId = randomUUID();
  await sql(`insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`, [clientId, seed.studioId, `Synthetic Client ${seed.studioId.slice(0, 4)}`, `client-${seed.studioId.slice(0, 8)}@example.test`]);
  for (const c of planContractPublication().publish.filter((p) => p.p_machine_profile_id === "dectro-apilus:xcell-pur")) {
    await sql("select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)", [c.p_machine_profile_id, c.p_machine_profile_version, c.p_mode_key, c.p_channels_max, c.p_requires_installed_option, JSON.stringify(c.p_fields)]);
  }
  const unitId = randomUUID();
  await sql(`insert into public.studio_machines (id, studio_id, machine_profile_id, machine_profile_version, display_name) values ($1,$2,'dectro-apilus:xcell-pur',1,$3)`, [unitId, seed.studioId, "xCell (synthetic studio)"]);
  // The studio's history with the existing xCell workflow: one earlier area charted the legacy way.
  const oldSession = randomUUID();
  await sql(`insert into public.sessions (id, studio_id, client_id, practitioner_id, modality, started_at) values ($1,$2,$3,(select id from public.practitioners where studio_id=$2 limit 1),'electrolysis', now() - interval '30 days')`, [oldSession, seed.studioId, clientId]);
  await sql(`insert into public.session_blocks (id, studio_id, session_id, sort_order, mode, energy_level, primary_area) values ($1,$2,$3,1,'thermo',7,'Upper lip')`, [randomUUID(), seed.studioId, oldSession]);
  return { seed, member, clientId, unitId };
}

async function startSession(page: Page, clientId: string): Promise<string> {
  await page.goto(`/clients/${clientId}/sessions/new`);
  await page.locator('[data-modality="electrolysis"]').click({ timeout: T });
  await page.waitForURL(/\/clients\/[^/]+\/sessions\/[0-9a-f-]{36}/, { timeout: T });
  return page.url().match(/sessions\/([0-9a-f-]{36})/)![1]!;
}

const blocksOf = (sessionId: string) =>
  sql<{ id: string; mode: string | null; machine_profile_id: string | null; studio_machine_id: string | null; machine_mode_key: string | null; energy_level: string | null; minutes_performed: number | null }>(
    `select id, mode, machine_profile_id, studio_machine_id, machine_mode_key, energy_level::text as energy_level, minutes_performed
       from public.session_blocks where session_id=$1 and deleted_at is null order by sort_order`,
    [sessionId],
  );
const readingsOf = async (blockId: string) =>
  Object.fromEntries(
    (await sql<{ k: string; v: string | null; t: string | null }>(
      `select coalesce(stage_key || '.', '') || field_key as k, value_numeric::text as v, value_text as t from public.treatment_setup_readings where session_block_id=$1`,
      [blockId],
    )).map((r) => [r.k, r.v ?? r.t]),
  );
const entryOf = async (blockId: string) =>
  (await sql<Record<string, unknown>>(
    `select energy_level, thermolysis_intensity_percent, thermolysis_duration_seconds, galvanic_ma, galvanic_duration_seconds, units_of_lye, pulse_count
       from public.electrolysis_entries where block_id=$1 and deleted_at is null order by created_at asc limit 1`,
    [blockId],
  ))[0] ?? null;

async function noOverflow(page: Page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw, `no horizontal overflow (scrollWidth ${sw} vs clientWidth ${cw})`).toBeLessThanOrEqual(cw);
}
const pill = (page: Page, label: string) => page.locator("button", { hasText: new RegExp(`^${label}$`) }).and(page.locator(":not([data-testid^='machine-mode-'])")).first();
const draft = (page: Page) => page.getByTestId("machine-setting-draft").locator("input");

// ONE complete visit. Values are SYNTHETIC. Decimals at the contract's own precision (slow duration 2 dp, flash duration 3 dp), a pulse count, and two
// OPTIONAL fields left blank (UL and the flash interval) that must stay blank in the record, never 0.
const V = { el: "12", slowDur: "1.85", slowInt: "30", flashDur: "0.033", flashInt: "60", pulses: "3" };

// SAVE WHILE SWITCHING (the owner's item 3): the MultiPlex pick's preference write is held in flight, then Blend is clicked, then Save is pressed.
// The saved area must carry no legacy mode and no legacy readings, read back from the database. Desktop only: the guard is not viewport-specific.
test.describe("press Save while the MultiPlex pick is still settling", () => {
  test.beforeEach(({}, info: TestInfo) => { test.skip(info.project.name !== "chromium", "chromium project only"); });
  test("a held pick, then Blend, then Save: the saved area has no legacy mode and no legacy readings", async ({ page }) => {
    const s = await seedStudio();
    await loginByMagicLink(page, s.member.email);
    const sessionId = await startSession(page, s.clientId);
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    await page.getByTestId("machine-first-open").click({ timeout: T });
    await page.getByTestId("machine-select").selectOption("legacy:xcell");
    await pill(page, "Thermolysis").click();
    await page.locator("label", { hasText: "Thermolysis intensity" }).locator("input").first().fill("42");

    // Hold exactly ONE server action: the first one the MultiPlex click sends (the pick's preference write). Everything else passes through.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let armed = false;
    let held = 0;
    await page.route("**/*", async (route) => {
      const req = route.request();
      if (armed && held === 0 && req.method() === "POST" && req.headers()["next-action"]) {
        held += 1;
        await gate;
      }
      await route.continue().catch(() => undefined);
    });
    armed = true;
    await page.getByTestId("mode-multiplex").click();
    await expect.poll(() => held, { timeout: T }).toBe(1);

    // The pick is still pending. Blend, an area, Save.
    await pill(page, "Blend").click();
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await page.getByTestId("laterality-Chin-left").click();
    await page.getByTestId("save-treatment-area").click({ timeout: T });
    // Next runs a page's server actions one at a time, so Save is queued behind the held pick: nothing is written while the pick is pending, and
    // the moment it settles the queued Save runs. Assert the first half, then release.
    await page.waitForTimeout(1500);
    expect((await blocksOf(sessionId)).length, "Save does not run ahead of the pending pick").toBe(0);
    release();

    let blocks: Awaited<ReturnType<typeof blocksOf>> = [];
    await expect.poll(async () => (blocks = await blocksOf(sessionId)).length, { timeout: T * 2 }).toBe(1);
    const saved = blocks[0]!;
    const entry = await entryOf(saved.id);
    expect(saved.mode, "no legacy mode on the saved area (Blend must not leak in)").toBeNull();
    expect(saved.energy_level).toBeNull();
    const { pulse_count: _default, ...legacy } = entry ?? {};
    for (const [k, v] of Object.entries(legacy)) expect(v, `legacy entry column ${k} is empty (the 42 and Blend never reach the record)`).toBeNull();
    expect(entry?.pulse_count, "the legacy pulse_count is only the database default").toBe(1);
    expect(Object.keys(await readingsOf(saved.id)), "no native readings were entered, so none are recorded").toHaveLength(0);
  });
});

const DEVICES = [
  { name: "desktop 1280", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, only: "chromium" },
  { name: "iPhone-size 390 (Chromium emulation)", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, only: "chromium" },
  { name: "iPhone 13 (WebKit emulation)", viewport: null, isMobile: false, hasTouch: false, only: "webkit-iphone-visit" },
] as const;

for (const device of DEVICES) {
  test.describe(`one MultiPlex visit, ${device.name}`, () => {
    if (device.viewport) test.use({ viewport: device.viewport, isMobile: device.isMobile, hasTouch: device.hasTouch });
    test.beforeEach(({}, info: TestInfo) => { test.skip(info.project.name !== device.only, `runs in the ${device.only} project`); });

    test("type, switch away and back, save, reopen, history, next visit", async ({ page }) => {
      const s = await seedStudio();
      await loginByMagicLink(page, s.member.email);
      const sessionId = await startSession(page, s.clientId);
      await page.getByTestId("add-settings-block-cta").click({ timeout: T });
      await page.getByTestId("machine-first-open").click({ timeout: T });
      await page.getByTestId("machine-select").selectOption("legacy:xcell");

      // The reported defect: Thermolysis 42, MultiPlex, Blend, back to Thermolysis.
      await pill(page, "Thermolysis").click();
      const legacyIntensity = page.locator("label", { hasText: "Thermolysis intensity" }).locator("input").first();
      await legacyIntensity.fill("42");
      await page.getByTestId("mode-multiplex").click();
      await pill(page, "Blend").click();
      await pill(page, "Thermolysis").click();
      await expect(legacyIntensity).toHaveValue("42");
      await page.getByTestId("mode-multiplex").click();

      // MultiPlex readings. Field order on the screen: EL, UL, slow duration, slow intensity, flash duration, flash intensity, pulse count, interval.
      await expect(page.getByTestId("machine-setting-draft")).toBeVisible({ timeout: T });
      const inputs = draft(page);
      await expect(inputs).toHaveCount(8);
      await inputs.nth(0).fill(V.el);
      await inputs.nth(2).fill(V.slowDur);
      await inputs.nth(3).fill(V.slowInt);
      await inputs.nth(4).fill(V.flashDur);
      await inputs.nth(5).fill(V.flashInt);
      await inputs.nth(6).fill(V.pulses);
      // UL (1) and the interval (7) stay blank.
      // Switch AWAY (Blend leaves MultiPlex) and BACK: what was typed is still there, and blank is still blank.
      await pill(page, "Blend").click();
      await page.getByTestId("mode-multiplex").click();
      await expect(inputs.nth(2)).toHaveValue(V.slowDur);
      await expect(inputs.nth(4)).toHaveValue(V.flashDur);
      await expect(inputs.nth(6)).toHaveValue(V.pulses);
      await expect(inputs.nth(1)).toHaveValue("");
      await expect(inputs.nth(7)).toHaveValue("");

      await page.getByRole("button", { name: "Chin", exact: true }).click();
      await page.getByTestId("laterality-Chin-left").click();
      await noOverflow(page);
      await page.getByTestId("save-treatment-area").click({ timeout: T });

      let blocks: Awaited<ReturnType<typeof blocksOf>> = [];
      await expect.poll(async () => (blocks = await blocksOf(sessionId)).length, { timeout: T }).toBe(1);
      const blockId = blocks[0]!.id;
      expect(blocks[0], "saved under the xCell Pur unit and MultiPlex, no legacy mode").toMatchObject({ machine_profile_id: "dectro-apilus:xcell-pur", studio_machine_id: s.unitId, machine_mode_key: "multiplex", mode: null, energy_level: null });
      await expect.poll(async () => Object.keys(await readingsOf(blockId)).length, { timeout: T }).toBeGreaterThan(0);
      const r = await readingsOf(blockId);
      expect(r["slow_thermolysis.slow_thermolysis_duration"], "exact decimal, 2 dp").toBe("1.85");
      expect(r["snap.snap_duration"], "exact decimal, 3 dp").toBe("0.033");
      expect(r["snap.snap_count"], "the pulse count actually entered").toBe("3");
      expect(r["slow_thermolysis.slow_thermolysis_intensity"]).toBe("30");
      expect(r["snap.snap_intensity"]).toBe("60");
      expect(r["displayed_el"]).toBe("12");
      expect("displayed_ul" in r, "a blank UL stores no reading (never 0, never a default)").toBe(false);
      expect("snap.snap_interval" in r, "a blank optional interval stores no reading (never 0)").toBe(false);
      const entry = await entryOf(blockId);
      // pulse_count is the one legacy column that is NEVER null: the command stores coalesce(p_pulse_count, 1) for every entry (0166), so a native
      // area's legacy entry reads 1 while its recorded pulse count is the 3 above. Nothing typed under Thermolysis (the 42) is anywhere in it.
      const { pulse_count: legacyPulseDefault, ...legacyReadings } = entry ?? {};
      for (const [k, v] of Object.entries(legacyReadings)) expect(v, `legacy column ${k} carries nothing typed under Thermolysis (the 42)`).toBeNull();
      expect(legacyPulseDefault, "the legacy pulse_count is the database default, not the MultiPlex count").toBe(1);

      // THE EXISTING xCell WORKFLOW IN THE SAME VISIT: an area charted with the existing choice (its model saved on the block, readings in the legacy
      // columns, pulse count 4). It must keep its pulse count on the card, whatever the native area beside it shows.
      const legacyBlockId = randomUUID();
      await sql(
        `insert into public.session_blocks (id, studio_id, session_id, sort_order, primary_area, side, mode, machine_profile_id)
         select $1, studio_id, session_id, 99, 'Cheek', 'left', 'thermo', 'dectro-apilus:xcell' from public.session_blocks where id = $2`,
        [legacyBlockId, blockId],
      );
      await sql(
        `insert into public.electrolysis_entries (session_id, block_id, area, areas, mode, thermolysis_intensity_percent, thermolysis_duration_seconds, pulse_count)
         values ($1, $2, 'Cheek', array['Cheek'], 'thermo', 40, 2, 4)`,
        [sessionId, legacyBlockId],
      );

      // REOPEN after a reload: the machine and mode come back, and the recorded values are shown exactly.
      await page.reload();
      // THE CARD SHOWS WHAT WAS RECORDED. Non-vacuous: wait for the native readings to render, then require the recorded values and forbid the legacy "1 pulse".
      const card = page.getByTestId(`area-section-${blockId}`);
      await expect(card.getByTestId("machine-recorded-setups")).toBeVisible({ timeout: T });
      await expect(card).toContainText("1.85");
      await expect(card).toContainText("0.033");
      await expect(card).toContainText(/Pulse count\s*3/);
      await expect(card).not.toContainText("No readings recorded");
      await expect(card).not.toContainText(/\b1 pulse\b/);
      const legacyCard = page.getByTestId(`area-section-${legacyBlockId}`);
      await expect(legacyCard).toContainText("4 pulses", { timeout: T });
      await expect(legacyCard.getByTestId("machine-recorded-setups")).toHaveCount(0);
      await page.getByTestId(`edit-area-${blockId}`).click({ timeout: T });
      await expect(page.getByTestId("machine-recorded-setups")).toBeVisible({ timeout: T });
      const recorded = page.getByTestId("machine-recorded-setups");
      await expect(recorded).toContainText("1.85");
      await expect(recorded).toContainText("0.033");
      await expect(recorded).toContainText("3");
      await noOverflow(page);
      // ... and the client's pages. FINDING (stated, asserted): the client's Overview names the area ("Treatment area: Left Chin") but prints no pulse or
      // readings for any area, and the Treatment tab lists no session areas at all, so neither can show 1 or 3; both must carry no "pulse" text.
      await page.goto(`/clients/${s.clientId}?tab=overview`);
      await page.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));
      await expect(page.locator("body")).toContainText("Left Chin", { timeout: T });
      await expect(page.locator("body")).not.toContainText(/\bpulses?\b/i);
      await page.goto(`/clients/${s.clientId}?tab=treatment`);
      await page.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));
      await expect(page.getByRole("heading").first()).toBeVisible({ timeout: T });
      await expect(page.locator("body")).not.toContainText(/\bpulses?\b/i);
      await page.goto(`/clients/${s.clientId}/sessions/${sessionId}`);

      // NEXT VISIT: a new session offers the previous machine and shows the previous values as REFERENCE only; nothing is written for the new visit.
      await sql("update public.sessions set started_at = now() - interval '2 hours' where id = $1", [sessionId]);
      const next = await startSession(page, s.clientId);
      await page.getByTestId("add-settings-block-cta").click({ timeout: T });
      await page.getByTestId("machine-first-open").click({ timeout: T });
      // The visit also holds the existing-xCell area, which is the latest area, so the machine choice that comes back is the existing xCell; the
      // previous MultiPlex setup is still shown beside it as reference.
      await expect(page.getByTestId("machine-prior-setup")).toContainText("1.85", { timeout: T });
      await expect(page.getByTestId("machine-prior-setup")).toContainText("0.033");
      await expect(page.locator("body")).not.toContainText(/\b1 pulse\b/);
      expect((await blocksOf(next)).length, "nothing is written for the new visit until it is entered").toBe(0);
      await noOverflow(page);
    });
  });
}
