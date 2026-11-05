import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { seedE2eStudio, seedE2eMember, sql } from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { planContractPublication } from "../lib/machines/contract-publication";

// HON-8 (#1369, Photos R2 at c0d7b3ddc): changing the MODE on a saved area writes the machine identity at once and bumps the block's version.
// The form kept the old version, so the NEXT block save (a shared field, or a mode-only change) was refused as "changed elsewhere" and the typed
// value was lost. The identity write now hands the form the new version. The real conflict is NOT weakened: two negative controls below.
// Synthetic studio, client and values; local stack only.
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


const entryHairs = async (blockId: string) =>
  (await sql<{ hairs_treated: number | null }>(`select hairs_treated from public.electrolysis_entries where block_id=$1 order by created_at limit 1`, [blockId]))[0]?.hairs_treated ?? null;
const keyOf = async (blockId: string) =>
  (await sql<{ k: string | null }>(`select machine_mode_key as k from public.session_blocks where id=$1`, [blockId]))[0]!.k;
const CONFLICT = /changed elsewhere/i;

for (const which of ["senior", "junior"] as const) {
  const [first, second] = which === "senior" ? ["flash", "microflash"] : ["flash", "blend"];
  test.describe(`mode change then block save, ${which} 3G, 1280`, () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    async function savedArea(page: Page, s: Awaited<ReturnType<typeof seedStudio>>) {
      const unitId = which === "senior" ? s.senior : s.junior;
      await loginByMagicLink(page, s.member.email);
      const sessionId = await startSession(page, s.clientId);
      await page.getByTestId("add-settings-block-cta").click({ timeout: T });
      await openPanel(page);
      await page.getByTestId("machine-select").selectOption(unitId);
      await expect(page.getByTestId("machine-chosen")).toBeVisible({ timeout: T });
      await page.getByTestId(`machine-mode-${first}`).click({ timeout: T });
      await page.getByTestId("save-treatment-area").click({ timeout: T });
      let blocks: Awaited<ReturnType<typeof blocksOf>> = [];
      await expect.poll(async () => (blocks = await blocksOf(sessionId)).length, { timeout: T }).toBe(1);
      const blockId = blocks[0]!.id;
      await page.reload();
      await page.getByTestId(`edit-area-${blockId}`).click({ timeout: T });
      await expect(page.getByTestId("machine-select")).toHaveValue(unitId, { timeout: T });
      return { blockId, sessionId };
    }

    test("a mode click, then a shared-field edit and Save, saves the value and shows no conflict", async ({ page }) => {
      const s = await seedStudio();
      const { blockId } = await savedArea(page, s);
      await page.getByTestId(`machine-mode-${second}`).click({ timeout: T });
      await expect.poll(() => keyOf(blockId), { timeout: T }).toBe(second);
      await page.getByLabel("Hairs treated", { exact: true }).fill("321");
      await page.getByTestId("save-treatment-area").click({ timeout: T });
      await expect.poll(() => entryHairs(blockId), { timeout: T }).toBe(321);
      await expect(page.getByText(CONFLICT)).toHaveCount(0);
      // And a second mode change followed by a mode-only Save also goes through.
      await page.reload();
      await page.getByTestId(`edit-area-${blockId}`).click({ timeout: T });
      await page.getByTestId(`machine-mode-${first}`).click({ timeout: T });
      await expect.poll(() => keyOf(blockId), { timeout: T }).toBe(first);
      await page.getByTestId("save-treatment-area").click({ timeout: T });
      await expect(page.getByText(CONFLICT)).toHaveCount(0);
      expect(await entryHairs(blockId)).toBe(321);
    });

    test("NEGATIVE CONTROL: a genuine edit from a second tab still conflicts, with or without a mode click in between", async ({ page, context }) => {
      const s = await seedStudio();
      const { blockId, sessionId } = await savedArea(page, s);
      // A real second tab: same login, same area, saves a different value first.
      const other = await context.newPage();
      await other.goto(`/clients/${s.clientId}/sessions/${sessionId}`);
      await other.getByTestId(`edit-area-${blockId}`).click({ timeout: T });
      await other.getByLabel("Hairs treated", { exact: true }).fill("111");
      await other.getByTestId("save-treatment-area").click({ timeout: T });
      await expect.poll(() => entryHairs(blockId), { timeout: T }).toBe(111);
      // Tab one never reloaded: its save is refused, and nothing it typed is written.
      await page.getByLabel("Hairs treated", { exact: true }).fill("222");
      await page.getByTestId("save-treatment-area").click({ timeout: T });
      await expect(page.getByText(CONFLICT).first()).toBeVisible({ timeout: T });
      expect(await entryHairs(blockId)).toBe(111);
      // The mode click on the STALE tab must not launder the conflict: the block had already changed, so no new version is adopted.
      await page.getByTestId(`machine-mode-${second}`).click({ timeout: T });
      await expect.poll(() => keyOf(blockId), { timeout: T }).toBe(second);
      await page.getByLabel("Hairs treated", { exact: true }).fill("333");
      await page.getByTestId("save-treatment-area").click({ timeout: T });
      await expect(page.getByText(CONFLICT).first()).toBeVisible({ timeout: T });
      expect(await entryHairs(blockId)).toBe(111);
    });
  });
}
