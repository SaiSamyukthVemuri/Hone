import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { seedE2eStudio, seedE2eDraftElectrolysisSession, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { MACHINE_CATALOGUE } from "../lib/machines/catalogue";
import { modeFields } from "../lib/machines/profile-contract";
import { planContractPublication } from "../lib/machines/contract-publication";
import { unsupportedModes } from "../lib/machines/unsupported-modes";

// HON-8 REAL-MODEL JOURNEY. The other machine specs use SYNTHETIC profile ids only (0 references to dectro-apilus:senior-3g or
// junior-3g), so none of them proves the REAL contracts. This one registers the REAL Senior and Junior 3G v3 models, publishes their
// REAL contracts (the same rows `publish-machine-contracts.mjs --apply-local` writes; replay is idempotent), and drives, per ACTIVE
// mode and at 1280 and 390: select the model -> choose the mode -> record settings -> save -> database readback -> reload -> history
// -> next-visit recall. It asserts the unsupported modes are SHOWN as unsupported and cannot be charted. It never sets the
// synthetic-profile gate, and fails if it is set, so a pass cannot be the fixture path wearing a real name.
// Synthetic studio, client and values; local stack only. Set HON8_DEMO_DIR to also write screenshots there; HON8_ALL_MODES=1 runs every active mode (CI runs flash and blend per model).
const T = 20_000;
const DEMO_DIR = process.env.HON8_DEMO_DIR;
const REAL = MACHINE_CATALOGUE.filter((p) => p.version === 3 && p.availability === "active" && p.profileId.startsWith("dectro-apilus:"));

async function shot(page: Page, name: string) {
  if (!DEMO_DIR) return;
  mkdirSync(DEMO_DIR, { recursive: true });
  await page.screenshot({ path: path.join(DEMO_DIR, `${name}.png`), fullPage: true });
}
async function noOverflow(page: Page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw, `no horizontal overflow (scrollWidth ${sw} vs clientWidth ${cw})`).toBeLessThanOrEqual(cw);
}
async function openMachinePanel(page: Page) {
  await expect(page.getByTestId("machine-first-trigger")).toBeVisible({ timeout: T });
  await page.getByTestId("machine-first-open").click();
  await expect(page.getByTestId("machine-first-panel")).toBeVisible({ timeout: T });
}
async function openCreateForm(page: Page, clientId: string, sessionId: string) {
  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({ timeout: T });
}
const blockIdOf = async (sessionId: string) =>
  (await sql<{ id: string }>(`select id from public.session_blocks where session_id=$1 and deleted_at is null order by sort_order limit 1`, [sessionId]))[0]?.id ?? "";
const storedFor = (blockId: string) => sql<{ stage_key: string | null; field_key: string; value_numeric: string | null; value_text: string | null; machine_profile_version: number; native_unit: string }>(
  `select stage_key, field_key, value_numeric::text as value_numeric, value_text, machine_profile_version, native_unit from public.treatment_setup_readings where session_block_id=$1`, [blockId]);

test.beforeAll(() => {
  expect(process.env.HONE_SYNTHETIC_MACHINE_PROFILE, "the synthetic gate must be OFF: this spec proves the REAL contracts").not.toBe("1");
  expect(REAL.map((p) => p.profileId).sort(), "the real first-slice profiles are active in the catalogue").toEqual(["dectro-apilus:junior-3g", "dectro-apilus:senior-3g"]);
});

for (const device of [
  { name: "desktop 1280", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
  { name: "mobile 390", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
]) {
  test.describe(`real 3G ${device.name}`, () => {
    test.use({ viewport: device.viewport, isMobile: device.isMobile, hasTouch: device.hasTouch });
    for (const profile of REAL) {
      // CI runs Flash and Blend per model (a plain numeric mode and the text/choice one); HON8_ALL_MODES=1 runs every active mode.
      for (const mode of profile.modes.filter((m) => m.availability === "active" && (process.env.HON8_ALL_MODES === "1" || ["flash", "blend"].includes(m.key)))) {
        test(`${profile.model} / ${mode.key}: select, record, save, reload, history, next visit`, async ({ page }) => {
          const seed = await seedE2eStudio();
          const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
          // The REAL published contract, through the command (deployment authority); idempotent.
          const plan = planContractPublication();
          const mine = plan.publish.filter((c) => c.p_machine_profile_id === profile.profileId);
          expect(mine.map((c) => c.p_mode_key)).toContain(mode.key);
          for (const c of mine) {
            await sql("select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)", [c.p_machine_profile_id, c.p_machine_profile_version, c.p_mode_key, c.p_channels_max, c.p_requires_installed_option, JSON.stringify(c.p_fields)]);
          }
          const machineId = randomUUID();
          await sql(`insert into public.studio_machines (id, studio_id, machine_profile_id, machine_profile_version, display_name) values ($1,$2,$3,$4,$5)`,
            [machineId, seed.studioId, profile.profileId, profile.version, `${profile.model} (synthetic studio)`]);
          const observations = modeFields(mode).map(({ field, stageKey }, index) => ({
            stageKey, field,
            value: field.valueKind === "choice" ? field.choices![0] : field.valueKind === "text" ? "003i"
              : (index + 1 + 27 / 10 ** field.decimals).toFixed(field.decimals),
          }));
          const tag = `${profile.profileId.split(":")[1]}-${mode.key}-${device.isMobile ? "390" : "1280"}`;

          await loginAsOwner(page, seed);
          await openCreateForm(page, clientId, sessionId);
          await openMachinePanel(page);
          await page.getByTestId("machine-select").selectOption(machineId);
          await expect(page.getByTestId("machine-chosen")).toContainText(profile.model);
          // Unsupported modes are SHOWN as unsupported and cannot be charted.
          for (const u of unsupportedModes(profile)) {
            await expect(page.getByTestId(`machine-unsupported-${u.key}`)).toContainText("unsupported, not capturable");
            await expect(page.getByTestId(`machine-mode-${u.key}`)).toHaveCount(0);
          }
          await page.getByTestId(`machine-mode-${mode.key}`).click({ timeout: T });
          await shot(page, `${tag}-1-select-mode`);
          for (const { field, value } of observations) {
            await expect(page.getByTestId(`field-label-${field.key}`)).toHaveText(field.nativeLabel);
            const control = page.getByTestId(`reading-${field.key}`);
            if (field.valueKind === "choice") await control.selectOption(value); else await control.fill(value);
          }
          await noOverflow(page);
          await shot(page, `${tag}-2-recorded-settings`);
          await page.getByTestId("save-treatment-area").click({ timeout: T });
          let blockId = "";
          await expect.poll(async () => (blockId = await blockIdOf(sessionId)), { timeout: T }).not.toBe("");
          await expect.poll(async () => (await storedFor(blockId)).length, { timeout: T }).toBe(observations.length);
          const saved = await storedFor(blockId);
          for (const { stageKey, field, value } of observations) {
            expect(saved.find((r) => r.stage_key === stageKey && r.field_key === field.key)).toMatchObject({
              ...(field.valueKind && field.valueKind !== "number" ? { value_numeric: null, value_text: value } : { value_numeric: value, value_text: null }),
              machine_profile_version: 3, native_unit: field.unit,
            });
          }
          expect(saved.every((r) => r.machine_profile_version === 3)).toBe(true);

          await page.reload();
          await page.getByTestId(`edit-area-${blockId}`).click({ timeout: T });
          await openMachinePanel(page);
          const capture = page.getByTestId("machine-recorded-setups").getByTestId("recorded-capture-g1-1");
          await expect(capture).toBeVisible({ timeout: T });
          for (const { field, value } of observations) await expect(capture).toContainText(field.valueKind === "text" ? value.trim() : value);
          await noOverflow(page);
          await shot(page, `${tag}-3-reload-history`);

          await sql("update public.sessions set started_at=now()-interval '2 hours' where client_id=$1", [clientId]);
          await page.goto(`/clients/${clientId}/sessions/new`);
          await page.locator('[data-modality="electrolysis"]').click({ timeout: T });
          await page.waitForURL(/\/clients\/[^/]+\/sessions\/[0-9a-f-]{36}/, { timeout: T });
          await page.getByTestId("add-settings-block-cta").click({ timeout: T });
          await openMachinePanel(page);
          await page.getByTestId("machine-select").selectOption(machineId);
          await page.getByTestId(`machine-mode-${mode.key}`).click({ timeout: T });
          const prior = page.getByTestId("machine-prior-setup");
          await expect(prior).toContainText(profile.model);
          for (const { field, value } of observations) {
            await expect(page.getByTestId(`reading-${field.key}`)).toHaveValue("");
            await expect(prior).toContainText(field.nativeLabel);
            await expect(prior).toContainText(field.valueKind === "text" ? value.trim() : value);
          }
          await noOverflow(page);
          await shot(page, `${tag}-4-next-visit-recall`);
        });
      }
    }
  });
}
