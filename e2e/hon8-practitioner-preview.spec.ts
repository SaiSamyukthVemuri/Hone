import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { seedE2eStudio, seedE2eMember, sql } from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { MACHINE_CATALOGUE } from "../lib/machines/catalogue";
import { modeFields } from "../lib/machines/profile-contract";
import { planContractPublication } from "../lib/machines/contract-publication";
import { unsupportedModes } from "../lib/machines/unsupported-modes";

// HON-8 PRACTITIONER PREVIEW PROOF. Unlike machine-real-3g.spec.ts (which logs in as the studio OWNER throughout), this logs in as a
// PRACTITIONER who is not the owner. The owner's only part is registering the units in advance (registration is owner-only:
// canManageMachines). The practitioner then does: mode select -> record settings -> save -> reload -> history -> next-visit recall,
// for every active mode of both real 3G models, at 1280 and 390. The contracts must already be published through the D4 runner path;
// this spec only checks that they are there. Synthetic studio, practitioner and client; local stack only; no value is prefilled
// and no range is enforced, so the values here are arbitrary synthetic numbers.
// Set HON8_PREVIEW_DIR to write screenshots there.
const T = 20_000;
const DIR = process.env.HON8_PREVIEW_DIR;
const REAL = MACHINE_CATALOGUE.filter((p) => p.version === 3 && p.availability === "active" && p.profileId.startsWith("dectro-apilus:"));

async function shot(page: Page, name: string) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: path.join(DIR, `${name}.png`), fullPage: true });
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
const blockIdOf = async (sessionId: string) =>
  (await sql<{ id: string }>(`select id from public.session_blocks where session_id=$1 and deleted_at is null order by sort_order limit 1`, [sessionId]))[0]?.id ?? "";
const storedFor = (blockId: string) => sql<{ stage_key: string | null; field_key: string; value_numeric: string | null; value_text: string | null; machine_profile_version: number; native_unit: string }>(
  `select stage_key, field_key, value_numeric::text as value_numeric, value_text, machine_profile_version, native_unit from public.treatment_setup_readings where session_block_id=$1`, [blockId]);

async function startSession(page: Page, clientId: string): Promise<string> {
  await page.goto(`/clients/${clientId}/sessions/new`);
  await page.locator('[data-modality="electrolysis"]').click({ timeout: T });
  await page.waitForURL(/\/clients\/[^/]+\/sessions\/[0-9a-f-]{36}/, { timeout: T });
  return page.url().match(/sessions\/([0-9a-f-]{36})/)![1]!;
}

test.beforeAll(() => {
  expect(process.env.HONE_SYNTHETIC_MACHINE_PROFILE, "the synthetic gate must be OFF").not.toBe("1");
  expect(REAL.map((p) => p.profileId).sort()).toEqual(["dectro-apilus:junior-3g", "dectro-apilus:senior-3g"]);
});

for (const device of [
  { name: "desktop 1280", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
  { name: "mobile 390", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
]) {
  test.describe(`practitioner, real 3G, ${device.name}`, () => {
    test.use({ viewport: device.viewport, isMobile: device.isMobile, hasTouch: device.hasTouch });
    for (const profile of REAL) {
      for (const mode of profile.modes.filter((m) => m.availability === "active")) {
        test(`practitioner (not owner): ${profile.model} / ${mode.key}: select, record, save, reload, history, next visit`, async ({ page }) => {
          const seed = await seedE2eStudio();
          const member = await seedE2eMember(seed);
          const clientId = randomUUID();
          await sql(`insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`, [clientId, seed.studioId, `Synthetic Client ${seed.runId}`, `synthetic-client-${seed.runId}@harness.local`]);
          const plan = planContractPublication();
          const mine = plan.publish.filter((c) => c.p_machine_profile_id === profile.profileId);
          const published = await sql<{ mode_key: string }>(`select mode_key from public.machine_profile_mode_contract where machine_profile_id=$1 and machine_profile_version=3`, [profile.profileId]);
          expect(published.map((r) => r.mode_key).sort(), "publish through the D4 path first").toEqual(mine.map((c) => c.p_mode_key).sort());
          // The OWNER's part, done in advance: register the unit (owner-only action; its UI path is proven by machine-real-3g.spec.ts).
          const machineName = `${profile.model} (synthetic studio)`;
          const machineId = randomUUID();
          await sql(`insert into public.studio_machines (id, studio_id, machine_profile_id, machine_profile_version, display_name) values ($1,$2,$3,$4,$5)`,
            [machineId, seed.studioId, profile.profileId, profile.version, machineName]);
          const role = (await sql<{ role: string }>(`select role from public.practitioners where id=$1`, [member.practitionerId]))[0]!.role;
          expect(role, "the logged-in user must NOT be the owner").not.toBe("owner");

          const observations = modeFields(mode).map(({ field, stageKey }, index) => ({
            stageKey, field,
            value: field.valueKind === "choice" ? field.choices![0] : field.valueKind === "text" ? "003i"
              : (index + 1 + 27 / 10 ** field.decimals).toFixed(field.decimals),
          }));
          const tag = `${profile.profileId.split(":")[1]}-${mode.key}-${device.isMobile ? "390" : "1280"}`;

          await loginByMagicLink(page, member.email);
          // A practitioner cannot register machines: the form is absent (or the page is not offered).
          await page.goto("/settings/machines");
          await expect(page.getByTestId("machine-register-submit")).toHaveCount(0);

          const sessionId = await startSession(page, clientId);
          await page.getByTestId("add-settings-block-cta").click({ timeout: T });
          await openMachinePanel(page);
          await page.getByTestId("machine-select").selectOption(machineId);
          await expect(page.getByTestId("machine-chosen")).toContainText(profile.model);
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

          await page.reload();
          await page.getByTestId(`edit-area-${blockId}`).click({ timeout: T });
          await openMachinePanel(page);
          const capture = page.getByTestId("machine-recorded-setups").getByTestId("recorded-capture-g1-1");
          await expect(capture).toBeVisible({ timeout: T });
          for (const { field, value } of observations) await expect(capture).toContainText(field.valueKind === "text" ? value.trim() : value);
          await noOverflow(page);
          await shot(page, `${tag}-3-reload-history`);

          await sql("update public.sessions set started_at=now()-interval '2 hours' where client_id=$1", [clientId]);
          await startSession(page, clientId);
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
