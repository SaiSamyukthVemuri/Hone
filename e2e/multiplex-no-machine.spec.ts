import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { seedE2eStudio, seedE2eMember, setPlatformRolloutMode, sql } from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { planContractPublication } from "../lib/machines/contract-publication";

// HON-119: MULTIPLEX FOR A STUDIO WITH NO REGISTERED MACHINE. REAL browser, REAL local stack, synthetic studio/client/values.
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
const V = { el: "12", slowDur: "1.85", slowInt: "30", flashDur: "0.033", flashInt: "60", pulses: "3" };

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
      await expect(page.getByTestId("mode-multiplex")).toBeVisible({ timeout: T });
      await expect(page.getByTestId("mode-multiplex")).toContainText("xCell Pur");
      for (const m of ["Thermolysis", "Blend", "Galvanic"]) await expect(pill(page, m)).toBeVisible();
      // THE NEW VIEW TOGGLE IS NOT THERE: the combined rollout stays Twin-only, and MultiPlex does not depend on it.
      await expect(page.getByTestId("charting-view-toggle")).toHaveCount(0);

      // Typed values survive mode switches: Thermolysis 42, MultiPlex, Blend, back.
      await pill(page, "Thermolysis").click();
      const legacyIntensity = page.locator("label", { hasText: "Thermolysis intensity" }).locator("input").first();
      await legacyIntensity.fill("42");
      await page.getByTestId("mode-multiplex").click();
      // The first click also opens the Machine panel (its context loads from the server); MultiPlex settles pressed before the next click.
      await expect(page.getByTestId("mode-multiplex")).toHaveAttribute("aria-pressed", "true", { timeout: T });
      await pill(page, "Blend").click();
      await pill(page, "Thermolysis").click();
      await expect(legacyIntensity).toHaveValue("42");
      await page.getByTestId("mode-multiplex").click();

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
      await page.getByTestId("mode-multiplex").click();
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
      await expect(page.getByTestId("mode-multiplex")).toHaveAttribute("aria-pressed", "true");
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
    await expect(page.getByTestId("mode-multiplex")).toBeVisible({ timeout: T });
    await expect(page.getByTestId("charting-view-toggle")).toHaveCount(0);
  });
});
