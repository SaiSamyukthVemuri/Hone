import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { seedE2eStudio, seedE2eMember, setPlatformRolloutMode, sql } from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { planContractPublication } from "../lib/machines/contract-publication";

// MULTIPLEX FOR A STUDIO WITH NO REGISTERED MACHINE. REAL browser, REAL local stack, synthetic studio/client/values.
// The studio has ZERO registered machines, no xCell history and the xCell rollout OFF (the Twin-only default), and still charts a complete
// MultiPlex visit from the first area. Desktop Chromium, an iPhone-size Chromium emulation, and an emulated iPhone 13 in WebKit.
const T = 20_000;
test.use({ video: process.env.HONE_E2E_RECORD === "1" ? "on" : "off" });
test.beforeAll(async () => { await setPlatformRolloutMode("off"); });

async function seedZeroMachineStudio() {
  const seed = await seedE2eStudio();
  const member = await seedE2eMember(seed);
  const clientId = randomUUID();
  await sql(`insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`, [clientId, seed.studioId, `Synthetic Client ${seed.studioId.slice(0, 4)}`, `client-${seed.studioId.slice(0, 8)}@example.test`]);
  for (const c of planContractPublication().publish.filter((p) => p.p_machine_profile_id === "dectro-apilus:xcell-pur")) {
    await sql("select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)", [c.p_machine_profile_id, c.p_machine_profile_version, c.p_mode_key, c.p_channels_max, c.p_requires_installed_option, JSON.stringify(c.p_fields)]);
  }
  const machines = await sql<{ n: number }>(`select count(*)::int n from public.studio_machines where studio_id=$1`, [seed.studioId]);
  expect(machines[0]!.n, "the studio starts with ZERO machines of any kind").toBe(0);
  return { seed, member, clientId };
}

async function startSession(page: Page, clientId: string): Promise<string> {
  await page.goto(`/clients/${clientId}/sessions/new`);
  await page.locator('[data-modality="electrolysis"]').click({ timeout: T });
  await page.waitForURL(/\/clients\/[^/]+\/sessions\/[0-9a-f-]{36}/, { timeout: T });
  return page.url().match(/sessions\/([0-9a-f-]{36})/)![1]!;
}

const blocksOf = (sessionId: string) =>
  sql<{ id: string; mode: string | null; machine_profile_id: string | null; studio_machine_id: string | null; machine_mode_key: string | null }>(
    `select id, mode, machine_profile_id, studio_machine_id, machine_mode_key from public.session_blocks where session_id=$1 and deleted_at is null order by sort_order`,
    [sessionId],
  );
const readingsOf = async (blockId: string) =>
  Object.fromEntries(
    (await sql<{ k: string; v: string | null; t: string | null }>(
      `select coalesce(stage_key || '.', '') || field_key as k, value_numeric::text as v, value_text as t from public.treatment_setup_readings where session_block_id=$1`,
      [blockId],
    )).map((r) => [r.k, r.v ?? r.t]),
  );
async function noOverflow(page: Page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw, `no horizontal overflow (scrollWidth ${sw} vs clientWidth ${cw})`).toBeLessThanOrEqual(cw);
}
const pill = (page: Page, label: string) => page.locator("button", { hasText: new RegExp(`^${label}$`) }).and(page.locator(":not([data-testid^='machine-mode-'])")).first();
const draft = (page: Page) => page.getByTestId("machine-setting-draft").locator("input");

// MULTIPLEX LIVES UNDER THERMOLYSIS: press Thermolysis (when it is not the mode yet), then pick MultiPlex in its Modality choice.
const modality = (page: Page) => page.getByTestId("modality-select");
async function chooseMultiplex(page: Page) {
  if ((await page.locator('[data-testid="modality-select"] option[value="Multiplex"]').count()) === 0) await pill(page, "Thermolysis").click();
  await modality(page).selectOption("Multiplex");
}
const V = { el: "12", slowDur: "1.85", slowInt: "30", flashDur: "0.033", flashInt: "60", pulses: "3" };

// A saved MultiPlex area reopens as MultiPlex with the exact readings, and the next visit recalls them as reference.
async function reopenAndRecall(page: Page, s: { clientId: string; seed: { studioId: string } }, sessionId: string, blockId: string) {
  await expect.poll(async () => Object.keys(await readingsOf(blockId)).length, { timeout: T }).toBeGreaterThan(0);
  const r = await readingsOf(blockId);
  expect(r["slow_thermolysis.slow_thermolysis_duration"]).toBe("1.85");
  expect(r["snap.snap_duration"]).toBe("0.033");
  expect(r["snap.snap_count"]).toBe("3");
  expect("displayed_ul" in r, "blank stays blank").toBe(false);
  await page.reload();
  const card = page.getByTestId(`area-section-${blockId}`);
  await expect(card.getByTestId("machine-recorded-setups")).toBeVisible({ timeout: T });
  await expect(card).toContainText("1.85");
  await expect(card).toContainText("0.033");
  await expect(card).toContainText(/Pulse count\s*3/);
  // The click can land before the page has hydrated (WebKit, right after a reload); retry it until the editor is really open.
  await expect(async () => {
    await page.getByTestId(`edit-area-${blockId}`).click({ timeout: 3000 });
    await expect(modality(page)).toHaveValue("Multiplex", { timeout: 3000 });
  }).toPass({ timeout: T });
  await expect(page.getByTestId("machine-recorded-setups")).toContainText("0.033");
  await page.goto(`/clients/${s.clientId}/sessions/${sessionId}`);
  await sql("update public.sessions set started_at = now() - interval '2 hours' where id = $1", [sessionId]);
  const next = await startSession(page, s.clientId);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  await page.getByTestId("machine-first-open").click({ timeout: T });
  await expect(page.getByTestId("machine-prior-setup")).toContainText("1.85", { timeout: T });
  await expect(page.getByTestId("machine-prior-setup")).toContainText("0.033");
  expect((await blocksOf(next)).length, "nothing is written for the new visit").toBe(0);
}

const DEVICES = [
  { name: "desktop 1280", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, only: "chromium" },
  { name: "iPhone-size 390 (Chromium emulation)", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, only: "chromium" },
  { name: "iPhone 13 (WebKit emulation)", viewport: null, isMobile: false, hasTouch: false, only: "webkit-iphone-visit" },
] as const;

for (const device of DEVICES) {
  test.describe(`MultiPlex with no registered machine, ${device.name}`, () => {
    if (device.viewport) test.use({ viewport: device.viewport, isMobile: device.isMobile, hasTouch: device.hasTouch });
    test.beforeEach(({}, info: TestInfo) => { test.skip(info.project.name !== device.only, `runs in the ${device.only} project`); });

    test("pill from the first visit, type and switch modes, save, reopen, next visit; no New View toggle", async ({ page }) => {
      const s = await seedZeroMachineStudio();
      await loginByMagicLink(page, s.member.email);
      const sessionId = await startSession(page, s.clientId);
      await page.getByTestId("add-settings-block-cta").click({ timeout: T });

      // THE PILL IS BESIDE THE THREE MODES FROM THE FIRST VISIT, labelled with the machine it belongs to, with the Machine panel still closed.
      await expect(page.getByTestId("machine-first-open")).toBeVisible({ timeout: T });
      // There is NO fourth pill: MultiPlex is under Thermolysis's Modality choice, labelled with the machine it belongs to.
      await expect(page.getByTestId("mode-multiplex")).toHaveCount(0);
      for (const m of ["Thermolysis", "Blend", "Galvanic"]) await expect(pill(page, m)).toBeVisible();
      await pill(page, "Thermolysis").click();
      await expect(modality(page).locator('option[value="Multiplex"]')).toContainText("xCell Pur");
      await pill(page, "Blend").click();
      await expect(modality(page).locator('option[value="Multiplex"]'), "Blend has no MultiPlex").toHaveCount(0);
      // THE NEW VIEW TOGGLE IS NOT THERE: the combined rollout stays Twin-only, and MultiPlex does not depend on it.
      await expect(page.getByTestId("charting-view-toggle")).toHaveCount(0);

      // Typed values survive mode switches: Thermolysis 42, MultiPlex, Blend, back.
      await pill(page, "Thermolysis").click();
      const legacyIntensity = page.locator("label", { hasText: "Thermolysis intensity" }).locator("input").first();
      await legacyIntensity.fill("42");
      await chooseMultiplex(page);
      // The first click also opens the Machine panel (its context loads from the server); MultiPlex settles pressed before the next click.
      await expect(modality(page)).toHaveValue("Multiplex", { timeout: T });
      await pill(page, "Blend").click();
      await pill(page, "Thermolysis").click();
      await expect(legacyIntensity).toHaveValue("42");
      await chooseMultiplex(page);

      // The eight inputs appear ONCE, under Treatment readings, none in the Machine panel; the machine is shown as not specified.
      const region = page.getByRole("region", { name: "Treatment readings" });
      await expect(region.getByTestId("machine-setting-draft")).toBeVisible({ timeout: T });
      await expect(page.getByTestId("machine-setting-draft")).toHaveCount(1);
      await expect(draft(page)).toHaveCount(8);
      await expect(page.getByTestId("machine-first-panel").getByTestId("machine-setting-draft")).toHaveCount(0);
      await expect(page.getByTestId("machine-chosen")).toContainText("Machine not specified");
      await expect(page.getByTestId("machine-select")).toHaveValue("");
      await expect(page.getByTestId("machine-select").locator("option")).not.toContainText(["Machine not specified"]);
      const inputs = draft(page);
      await inputs.nth(0).fill(V.el);
      await inputs.nth(2).fill(V.slowDur);
      await inputs.nth(3).fill(V.slowInt);
      await inputs.nth(4).fill(V.flashDur);
      await inputs.nth(5).fill(V.flashInt);
      await inputs.nth(6).fill(V.pulses);
      await pill(page, "Blend").click();
      await chooseMultiplex(page);
      await expect(inputs.nth(2)).toHaveValue(V.slowDur);
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
      expect(blocks[0], "saved as xCell Pur MultiPlex, no legacy mode").toMatchObject({ machine_profile_id: "dectro-apilus:xcell-pur", machine_mode_key: "multiplex", mode: null });
      const unit = await sql<{ id: string; display_name: string; is_unspecified: boolean }>(`select id, display_name, is_unspecified from public.studio_machines where studio_id=$1`, [s.seed.studioId]);
      expect(unit, "exactly one placeholder row, and it is the block's unit").toHaveLength(1);
      expect(unit[0]).toMatchObject({ display_name: "Machine not specified", is_unspecified: true });
      expect(blocks[0]!.studio_machine_id).toBe(unit[0]!.id);
      await expect.poll(async () => Object.keys(await readingsOf(blockId)).length, { timeout: T }).toBeGreaterThan(0);
      const r = await readingsOf(blockId);
      expect(r["slow_thermolysis.slow_thermolysis_duration"]).toBe("1.85");
      expect(r["snap.snap_duration"]).toBe("0.033");
      expect(r["snap.snap_count"], "the pulse count actually entered").toBe("3");
      expect(r["displayed_el"]).toBe("12");
      expect("displayed_ul" in r, "blank UL stays blank").toBe(false);
      expect("snap.snap_interval" in r, "blank interval stays blank").toBe(false);

      // REOPEN: the card shows what was recorded and never names the placeholder as a machine of the studio's.
      await page.reload();
      const card = page.getByTestId(`area-section-${blockId}`);
      await expect(card.getByTestId("machine-recorded-setups")).toBeVisible({ timeout: T });
      await expect(card).toContainText("1.85");
      await expect(card).toContainText(/Pulse count\s*3/);
      await expect(card).not.toContainText(/\b1 pulse\b/);
      await page.getByTestId(`edit-area-${blockId}`).click({ timeout: T });
      await expect(page.getByTestId("machine-first-panel")).toBeVisible({ timeout: T });
      await expect(modality(page)).toHaveValue("Multiplex");
      await expect(page.getByTestId("machine-recorded-setups")).toContainText("0.033");
      await noOverflow(page);

      // NEXT VISIT: the previous values show as REFERENCE, the pulse count carries as 3, and nothing is written for the new visit.
      await page.goto(`/clients/${s.clientId}/sessions/${sessionId}`);
      await sql("update public.sessions set started_at = now() - interval '2 hours' where id = $1", [sessionId]);
      const next = await startSession(page, s.clientId);
      await page.getByTestId("add-settings-block-cta").click({ timeout: T });
      await page.getByTestId("machine-first-open").click({ timeout: T });
      await expect(page.getByTestId("machine-prior-setup")).toContainText("1.85", { timeout: T });
      await expect(page.getByTestId("machine-prior-setup")).toContainText(/3/);
      expect((await blocksOf(next)).length, "nothing is written for the new visit until it is entered").toBe(0);
      expect((await sql<{ n: number }>(`select count(*)::int n from public.studio_machines where studio_id=$1 and not is_unspecified`, [s.seed.studioId]))[0]!.n, "still zero registered machines").toBe(0);
      await noOverflow(page);
    });

    // SAVE PRESSED THE MOMENT MULTIPLEX IS PICKED, before the Machine panel's first load can have finished: the form holds Save until the choice
    // resolves, so a legacy area is never written. Whatever was pressed early, every saved area is MultiPlex with its readings, none is legacy.
    test("pressing Save right after picking MultiPlex never saves a legacy area", async ({ page }) => {
      const s = await seedZeroMachineStudio();
      await loginByMagicLink(page, s.member.email);
      const sessionId = await startSession(page, s.clientId);
      await page.getByTestId("add-settings-block-cta").click({ timeout: T });
      await page.getByRole("button", { name: "Chin", exact: true }).click();
      await page.getByTestId("laterality-Chin-left").click();
      await pill(page, "Thermolysis").click();
      await page.locator("label", { hasText: "Thermolysis intensity" }).locator("input").first().fill("42");
      await chooseMultiplex(page);
      // no wait: Save is pressed at once (the held button ignores it) and again after the choice has settled.
      await page.getByTestId("save-treatment-area").click({ force: true, timeout: T }).catch(() => undefined);
      expect((await blocksOf(sessionId)).filter((b) => b.mode !== null).length, "no legacy area was written by the early Save").toBe(0);
      await expect(modality(page)).toHaveValue("Multiplex", { timeout: T });
      await expect(page.getByTestId("save-treatment-area")).toBeEnabled({ timeout: T });
      await expect(draft(page)).toHaveCount(8, { timeout: T });
      await draft(page).nth(0).fill("12");
      await draft(page).nth(2).fill(V.slowDur);
      await draft(page).nth(3).fill(V.slowInt);
      await draft(page).nth(4).fill(V.flashDur);
      await draft(page).nth(5).fill(V.flashInt);
      await draft(page).nth(6).fill("3");
      await page.getByTestId("save-treatment-area").click({ timeout: T });
      let blocks: Awaited<ReturnType<typeof blocksOf>> = [];
      await expect.poll(async () => (blocks = await blocksOf(sessionId)).length, { timeout: T }).toBe(1);
      expect(blocks[0], "the saved area is MultiPlex on the placeholder, no legacy mode").toMatchObject({ machine_profile_id: "dectro-apilus:xcell-pur", machine_mode_key: "multiplex", mode: null });
      const r = await (async () => { for (let i = 0; i < 20; i++) { const x = await readingsOf(blocks[0]!.id); if (Object.keys(x).length) return x; await page.waitForTimeout(500); } return {}; })();
      expect(r["snap.snap_count"]).toBe("3");
      expect(r["displayed_el"]).toBe("12");
      await reopenAndRecall(page, s, sessionId, blocks[0]!.id);
    });

    // A FAILED LOAD: the first MultiPlex choice cannot load (the request is refused), Save is refused with a plain message, NOTHING is written, and the
    // typed values are still on the screen. Picking MultiPlex again once the network is back loads it, and the same draft then saves as MultiPlex.
    test("a failed MultiPlex load saves nothing, keeps the typed values, and the retry saves as MultiPlex", async ({ page }) => {
      const s = await seedZeroMachineStudio();
      await loginByMagicLink(page, s.member.email);
      const sessionId = await startSession(page, s.clientId);
      await page.getByTestId("add-settings-block-cta").click({ timeout: T });
      await page.getByRole("button", { name: "Chin", exact: true }).click();
      await page.getByTestId("laterality-Chin-left").click();
      await pill(page, "Thermolysis").click();
      const intensity = page.locator("label", { hasText: "Thermolysis intensity" }).locator("input").first();
      await intensity.fill("42");
      let refuse = true;
      await page.route("**/*", async (route) => {
        const req = route.request();
        if (refuse && req.method() === "POST" && req.headers()["next-action"]) { await route.abort("failed").catch(() => undefined); return; }
        await route.continue().catch(() => undefined);
      });
      await chooseMultiplex(page);
      await expect(modality(page)).not.toHaveValue("Multiplex");
      await page.getByTestId("save-treatment-area").click({ timeout: T });
      await expect(page.locator("body")).toContainText("MultiPlex could not be loaded", { timeout: T });
      expect((await blocksOf(sessionId)).length, "nothing was saved, legacy or otherwise").toBe(0);
      await expect(intensity, "the typed value is still there").toHaveValue("42");

      refuse = false;
      // The network is back: drop the interception entirely (a pass-through route is itself a variable in WebKit) before the retry.
      await page.unroute("**/*");
      await chooseMultiplex(page);
      await expect(modality(page)).toHaveValue("Multiplex", { timeout: T });
      await expect(draft(page)).toHaveCount(8, { timeout: T });
      await draft(page).nth(0).fill("12");
      await draft(page).nth(2).fill(V.slowDur);
      await draft(page).nth(3).fill(V.slowInt);
      await draft(page).nth(4).fill(V.flashDur);
      await draft(page).nth(5).fill(V.flashInt);
      await draft(page).nth(6).fill("3");
      await page.getByTestId("save-treatment-area").click({ timeout: T });
      let blocks: Awaited<ReturnType<typeof blocksOf>> = [];
      await expect.poll(async () => (blocks = await blocksOf(sessionId)).length, { timeout: T }).toBe(1);
      expect(blocks[0]).toMatchObject({ machine_profile_id: "dectro-apilus:xcell-pur", machine_mode_key: "multiplex", mode: null });
      await reopenAndRecall(page, s, sessionId, blocks[0]!.id);
    });
  });
}

test.describe("a studio with the rollout OFF", () => {
  test.beforeEach(({}, info: TestInfo) => { test.skip(info.project.name !== "chromium", "chromium project only"); });
  test("gets MultiPlex and NO New View toggle", async ({ page }) => {
    const s = await seedZeroMachineStudio();
    await loginByMagicLink(page, s.member.email);
    await startSession(page, s.clientId);
    await expect(page.getByTestId("charting-view-toggle")).toHaveCount(0);
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    await pill(page, "Thermolysis").click();
    await expect(modality(page).locator('option[value="Multiplex"]')).toHaveCount(1, { timeout: T });
    await expect(page.getByTestId("mode-multiplex")).toHaveCount(0);
    await expect(page.getByTestId("charting-view-toggle")).toHaveCount(0);
  });
});

// THE OTHER THREE MODES, in the same studio (zero machines): Thermolysis, Blend and Galvanic areas save with their own values, reopen unchanged, and
// carry NO machine at all (no placeholder, no profile). MultiPlex being on offer must change nothing about them.
for (const device of [
  { name: "desktop 1280", viewport: { width: 1280, height: 800 }, only: "chromium" },
  { name: "iPhone 13 (WebKit emulation)", viewport: null, only: "webkit-iphone-visit" },
] as const) {
  test.describe(`the three existing modes in a studio with no machine, ${device.name}`, () => {
    if (device.viewport) test.use({ viewport: device.viewport });
    test.beforeEach(({}, info: TestInfo) => { test.skip(info.project.name !== device.only, `runs in the ${device.only} project`); });

    test("Thermolysis, Blend and Galvanic areas save, reopen unchanged, and attach no machine", async ({ page }) => {
      const s = await seedZeroMachineStudio();
      await loginByMagicLink(page, s.member.email);
      const sessionId = await startSession(page, s.clientId);
      const num = (n: string) => page.getByRole("spinbutton", { name: n, exact: true });

      const saveArea = async (area: string, side: string, mode: string, fill: () => Promise<void>, expected: number) => {
        await page.getByTestId("add-settings-block-cta").click({ timeout: T });
        await pill(page, mode).click({ timeout: T });
        await fill();
        await page.getByRole("button", { name: area, exact: true }).click();
        await page.getByTestId(`laterality-${area}-${side}`).click();
        await page.getByTestId("save-treatment-area").click({ timeout: T });
        await expect.poll(async () => (await blocksOf(sessionId)).length, { timeout: T }).toBe(expected);
      };
      await saveArea("Chin", "left", "Thermolysis", async () => {
        await num("Energy level (EL)").fill("42");
        await num("Thermolysis duration (s)").fill("0.5");
        await num("Thermolysis intensity %").fill("30");
      }, 1);
      await saveArea("Cheeks", "left", "Blend", async () => {
        await num("Energy level (EL)").fill("35");
        await num("Units of lye (UL)").fill("25.5");
        await num("Galvanic duration (s)").fill("8");
        await num("Galvanic mA").fill("0.74");
        await num("Thermolysis duration (s)").fill("0.733");
        await num("Thermolysis intensity %").fill("20");
      }, 2);
      await saveArea("Upper lip", "left", "Galvanic", async () => {
        await num("Galvanic duration (s)").fill("9");
        await num("Galvanic mA").fill("0.5");
      }, 3);

      const blocks = await blocksOf(sessionId);
      for (const b of blocks) expect(b, "no machine of any kind is attached").toMatchObject({ studio_machine_id: null, machine_profile_id: null, machine_mode_key: null });
      expect(blocks.map((b) => b.mode)).toEqual(["thermo", "blend", "galv"]);
      expect((await sql<{ n: number }>(`select count(*)::int n from public.studio_machines where studio_id=$1`, [s.seed.studioId]))[0]!.n, "no placeholder or any machine row was created").toBe(0);
      expect((await sql<{ n: number }>(`select count(*)::int n from public.treatment_setup_readings where session_block_id = any($1)`, [blocks.map((b) => b.id)]))[0]!.n, "no native readings for legacy modes").toBe(0);

      await page.reload();
      const reopen = async (id: string) => {
        await page.getByTestId(`edit-area-${id}`).click({ timeout: T });
      };
      await reopen(blocks[0]!.id);
      await expect(num("Thermolysis intensity %")).toHaveValue("30", { timeout: T });
      await expect(num("Thermolysis duration (s)")).toHaveValue("0.5");
      await expect(num("Energy level (EL)")).toHaveValue("42");
      await noOverflow(page);
      await page.goto(`/clients/${s.clientId}/sessions/${sessionId}`);
      await reopen(blocks[1]!.id);
      await expect(num("Galvanic mA")).toHaveValue("0.74", { timeout: T });
      await expect(num("Thermolysis duration (s)")).toHaveValue("0.733");
      await expect(num("Units of lye (UL)")).toHaveValue("25.5");
      await expect(num("Energy level (EL)")).toHaveValue("35");
      await page.goto(`/clients/${s.clientId}/sessions/${sessionId}`);
      await reopen(blocks[2]!.id);
      await expect(num("Galvanic mA")).toHaveValue("0.5", { timeout: T });
      await expect(num("Galvanic duration (s)")).toHaveValue("9");
      await noOverflow(page);
      expect((await sql<{ n: number }>(`select count(*)::int n from public.studio_machines where studio_id=$1`, [s.seed.studioId]))[0]!.n, "reopening created nothing").toBe(0);
    });
  });
}
