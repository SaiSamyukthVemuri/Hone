import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { seedE2eStudio, seedE2eMember, sql } from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { planContractPublication } from "../lib/machines/contract-publication";

// HON-8 ONE MACHINE SELECTOR (Sam's preview feedback, 4 Nov 2026), for the three machines the practitioner works on: the existing
// workflow (the studio's xCell), Senior 3G and Junior 3G. Per machine, at 1280 and 390, as a PRACTITIONER who is not the owner:
//   * one selector; only the chosen machine's settings show, shared treatment fields once;
//   * save -> refresh -> reopen restores machine, mode, values and areas, read back from the database, including a machine and mode
//     chosen with NO value entered (the refresh defect);
//   * a new session suggests the previous machine with an explicit Change control, previous values are reference only, and nothing
//     is written for the new visit until the practitioner enters it;
//   * a clear save state, and leaving with unsaved work asks first.
// Synthetic studio, client and values; local stack only. The synthetic-profile gate stays off: the REAL contracts are published
// through the command, as the other real-model spec does on its fast path.
const T = 20_000;

async function noOverflow(page: Page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw, `no horizontal overflow (scrollWidth ${sw} vs clientWidth ${cw})`).toBeLessThanOrEqual(cw);
}
const blocksOf = (sessionId: string) =>
  sql<{ id: string; mode: string | null; machine_profile_id: string | null; studio_machine_id: string | null; machine_mode_key: string | null; energy_level: string | null }>(
    `select id, mode, machine_profile_id, studio_machine_id, machine_mode_key, energy_level::text as energy_level
       from public.session_blocks where session_id=$1 and deleted_at is null order by sort_order`,
    [sessionId],
  );
const readingCount = async (blockId: string) =>
  (await sql<{ n: number }>(`select count(*)::int as n from public.treatment_setup_readings where session_block_id=$1`, [blockId]))[0]!.n;

async function startSession(page: Page, clientId: string): Promise<string> {
  await page.goto(`/clients/${clientId}/sessions/new`);
  await page.locator('[data-modality="electrolysis"]').click({ timeout: T });
  await page.waitForURL(/\/clients\/[^/]+\/sessions\/[0-9a-f-]{36}/, { timeout: T });
  return page.url().match(/sessions\/([0-9a-f-]{36})/)![1]!;
}
async function openPanel(page: Page) {
  await expect(page.getByTestId("machine-first-trigger")).toBeVisible({ timeout: T });
  await page.getByTestId("machine-first-open").click();
  await expect(page.getByTestId("machine-first-panel")).toBeVisible({ timeout: T });
}

async function seedStudio() {
  const seed = await seedE2eStudio();
  const member = await seedE2eMember(seed);
  const clientId = randomUUID();
  await sql(`insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`, [clientId, seed.studioId, `Synthetic Client ${seed.studioId.slice(0, 4)}`, `client-${seed.studioId.slice(0, 8)}@harness.local`]);
  for (const c of planContractPublication().publish) {
    await sql("select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)", [c.p_machine_profile_id, c.p_machine_profile_version, c.p_mode_key, c.p_channels_max, c.p_requires_installed_option, JSON.stringify(c.p_fields)]);
  }
  const unit = async (profileId: string, name: string) => {
    const id = randomUUID();
    await sql(`insert into public.studio_machines (id, studio_id, machine_profile_id, machine_profile_version, display_name) values ($1,$2,$3,3,$4)`, [id, seed.studioId, profileId, name]);
    return id;
  };
  const senior = await unit("dectro-apilus:senior-3g", "Senior (synthetic studio)");
  const junior = await unit("dectro-apilus:junior-3g", "Junior (synthetic studio)");
  // The studio's history with the existing workflow: one earlier area charted the legacy way (a legacy mode, no machine identity).
  const oldSession = randomUUID();
  await sql(`insert into public.sessions (id, studio_id, client_id, practitioner_id, modality, started_at) values ($1,$2,$3,(select id from public.practitioners where studio_id=$2 limit 1),'electrolysis', now() - interval '30 days')`, [oldSession, seed.studioId, clientId]);
  await sql(`insert into public.session_blocks (id, studio_id, session_id, sort_order, mode, energy_level, primary_area) values ($1,$2,$3,1,'thermo',7,'Upper lip')`, [randomUUID(), seed.studioId, oldSession]);
  return { seed, member, clientId, senior, junior };
}

for (const device of [
  { name: "desktop 1280", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
  { name: "mobile 390", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
]) {
  test.describe(`one machine selector, ${device.name}`, () => {
    test.use({ viewport: device.viewport, isMobile: device.isMobile, hasTouch: device.hasTouch });

    for (const which of ["senior", "junior"] as const) {
      const profile = which === "senior" ? "dectro-apilus:senior-3g" : "dectro-apilus:junior-3g";
      test(`${which} 3G: only its settings, a choice with NO value survives refresh, then values, then next session`, async ({ page }) => {
        const s = await seedStudio();
        const unitId = which === "senior" ? s.senior : s.junior;
        await loginByMagicLink(page, s.member.email);
        const sessionId = await startSession(page, s.clientId);
        await page.getByTestId("add-settings-block-cta").click({ timeout: T });

        // Before any choice the existing fields show exactly as before.
        await expect(page.getByText("Machine frequency")).toBeVisible({ timeout: T });
        await openPanel(page);
        const select = page.getByTestId("machine-select");
        // ONE selector, with the units and the existing workflow in it.
        await expect(page.locator("select[data-testid='machine-select']")).toHaveCount(1);
        const options = await select.locator("option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
        expect(options).toContain(unitId);
        expect(options).toContain("legacy:xcell");

        await select.selectOption(unitId);
        await expect(page.getByTestId("machine-chosen")).toBeVisible({ timeout: T });
        // Only the selected machine's settings: the overlapping legacy fields are gone, the shared ones remain once.
        await expect(page.getByText("Machine frequency")).toHaveCount(0);
        await expect(page.getByText("Energy level (EL)")).toHaveCount(0);
        await expect(page.getByText("Units of lye (UL)")).toHaveCount(0);
        await expect(page.getByText("Probe", { exact: true })).toHaveCount(1);
        await expect(page.getByText("Hairs treated")).toHaveCount(1);
        await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "unsaved");
        await noOverflow(page);

        // THE REFRESH DEFECT: a machine and mode chosen, no value entered, Save.
        await page.getByTestId("save-treatment-area").click({ timeout: T });
        let blocks: Awaited<ReturnType<typeof blocksOf>> = [];
        await expect.poll(async () => (blocks = await blocksOf(sessionId)).length, { timeout: T }).toBe(1);
        const blockId = blocks[0]!.id;
        expect(blocks[0]).toMatchObject({ machine_profile_id: profile, studio_machine_id: unitId, mode: null, energy_level: null });
        expect(blocks[0]!.machine_mode_key, "a mode is saved with the machine").toBeTruthy();
        expect(await readingCount(blockId), "nothing was entered, so no reading exists").toBe(0);

        // Refresh and reopen: the machine and mode come back with NO click on "Choose machine".
        await page.reload();
        await page.getByTestId(`edit-area-${blockId}`).click({ timeout: T });
        await expect(page.getByTestId("machine-select")).toHaveValue(unitId, { timeout: T });
        await expect(page.getByTestId("machine-chosen")).toBeVisible();
        await expect(page.getByText("Machine frequency")).toHaveCount(0);
        await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
        await noOverflow(page);

        // Switching to the existing workflow on an area that holds no legacy data is allowed and saved as the area's record.
        await page.getByTestId("machine-select").selectOption("legacy:xcell");
        await expect(page.getByText("Machine frequency")).toBeVisible({ timeout: T });
        await expect.poll(async () => (await blocksOf(sessionId))[0]!.machine_profile_id, { timeout: T }).toBe("dectro-apilus:xcell");
        await page.getByTestId("machine-select").selectOption(unitId);
        await expect.poll(async () => (await blocksOf(sessionId))[0]!.studio_machine_id, { timeout: T }).toBe(unitId);

        // A NEW session: the previous machine is suggested with an explicit Change control; nothing is written for the visit.
        await sql("update public.sessions set started_at=now()-interval '2 hours' where id=$1", [sessionId]);
        const next = await startSession(page, s.clientId);
        await page.getByTestId("add-settings-block-cta").click({ timeout: T });
        await openPanel(page);
        const chosenOrSuggested = page.getByTestId("machine-chosen").or(page.getByTestId("machine-suggestion"));
        await expect(chosenOrSuggested).toBeVisible({ timeout: T });
        await expect(chosenOrSuggested).toContainText(which === "senior" ? "Senior" : "Junior");
        if (await page.getByTestId("machine-suggestion").count()) {
          await page.getByTestId("machine-suggestion-use").click();
        }
        await expect(page.getByTestId("machine-change")).toBeVisible({ timeout: T });
        expect((await blocksOf(next)).length, "nothing is written for the new visit until it is entered").toBe(0);
        await noOverflow(page);
      });
    }

    test("the existing workflow: chosen in the same selector, its own fields, saved, restored, and old records read back unchanged", async ({ page }) => {
      const s = await seedStudio();
      await loginByMagicLink(page, s.member.email);
      const sessionId = await startSession(page, s.clientId);
      await page.getByTestId("add-settings-block-cta").click({ timeout: T });
      await openPanel(page);
      await page.getByTestId("machine-select").selectOption("legacy:xcell");
      // Its own fields, exactly the existing ones.
      await expect(page.getByText("Machine frequency")).toBeVisible({ timeout: T });
      await page.getByRole("button", { name: "Thermolysis", exact: true }).click();
      await page.getByLabel("Energy level (EL)").fill("5");
      await page.getByTestId("save-treatment-area").click({ timeout: T });
      let blocks: Awaited<ReturnType<typeof blocksOf>> = [];
      await expect.poll(async () => (blocks = await blocksOf(sessionId)).length, { timeout: T }).toBe(1);
      expect(blocks[0]).toMatchObject({ mode: "thermo", energy_level: "5", machine_profile_id: "dectro-apilus:xcell", studio_machine_id: null, machine_mode_key: null });
      expect(await readingCount(blocks[0]!.id)).toBe(0);

      await page.reload();
      await page.getByTestId(`edit-area-${blocks[0]!.id}`).click({ timeout: T });
      await expect(page.getByTestId("machine-select")).toHaveValue("legacy:xcell", { timeout: T });
      await expect(page.getByLabel("Energy level (EL)")).toHaveValue("5");
      // An area that already holds existing-workflow settings is not switched to another machine (settings are never mixed).
      await page.getByTestId("machine-select").selectOption(s.senior);
      await expect(page.getByText("Machine frequency")).toBeVisible();
      await expect(page.getByLabel("Energy level (EL)")).toHaveValue("5");
      expect((await blocksOf(sessionId))[0]).toMatchObject({ studio_machine_id: null, mode: "thermo", energy_level: "5" });

      // An older record with NO saved identity still opens as the existing form, untouched.
      const old = await sql<{ id: string; session_id: string }>(`select id, session_id from public.session_blocks where studio_id=$1 and machine_profile_id is null limit 1`, [s.seed.studioId]);
      await page.goto(`/clients/${s.clientId}/sessions/${old[0]!.session_id}`);
      await page.getByTestId(`edit-area-${old[0]!.id}`).click({ timeout: T });
      await expect(page.getByLabel("Energy level (EL)")).toHaveValue("7", { timeout: T });
      await expect(page.getByText("Machine frequency")).toBeVisible();
      await noOverflow(page);
    });

    test("leaving with unsaved work asks first, in the app's own dialog", async ({ page }) => {
      const s = await seedStudio();
      await loginByMagicLink(page, s.member.email);
      await startSession(page, s.clientId);
      await page.getByTestId("add-settings-block-cta").click({ timeout: T });
      await page.getByLabel("Energy level (EL)").fill("4");
      await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "unsaved");
      // An in-app link, present at every width (the nav collapses on a phone): a real click on a same-origin anchor.
      await page.evaluate(() => {
        const a = document.createElement("a");
        a.href = "/dashboard";
        a.id = "leave-probe";
        a.textContent = "Leave probe";
        document.body.appendChild(a);
      });
      await page.locator("#leave-probe").click();
      await expect(page.getByText("Leave without saving?")).toBeVisible({ timeout: T });
      await page.getByRole("button", { name: "Stay" }).click();
      await expect(page.getByText("Leave without saving?")).toHaveCount(0);
    });
  });
}
