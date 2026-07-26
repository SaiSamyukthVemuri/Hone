import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eDraftElectrolysisSession,
  getSavedBlockSetup,
  getSessionBlockCount,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Conditional numbing notes (0156) — real browser, real stack, 390px iPhone.
// Proves: the notes field is hidden by default, revealed only for "Numbing
// used", the unsaved draft survives status toggles, the note round-trips exactly
// when saved as used, switching away clears it to NULL, blank saves NULL, and
// there is no horizontal overflow. DB rows are ground truth.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const T = 20_000;

async function noOverflow(page: Page) {
  const [sw, cw] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(sw, `no horizontal overflow (scrollWidth ${sw} vs clientWidth ${cw})`).toBeLessThanOrEqual(cw);
}

async function openForm(page: Page, clientId: string, sessionId: string) {
  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({ timeout: T });
}

test("numbing notes: hidden by default, conditional reveal, draft-preserving toggle, exact round-trip, truthful clear @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);

  await test.step("1: field hidden initially (Not recorded default)", async () => {
    await openForm(page, clientId, sessionId);
    await expect(page.getByTestId("numbing-notes")).toHaveCount(0);
    await noOverflow(page);
  });

  await test.step("2/3: choose Numbing used → field appears; type multiline", async () => {
    await page.getByRole("button", { name: "Numbing used", exact: true }).click();
    await expect(page.getByTestId("numbing-notes")).toBeVisible();
    await expect(page.getByText("Numbing notes (optional)")).toBeVisible();
    await page.getByTestId("numbing-notes").fill("EMLA cream\napplied to chin");
    await noOverflow(page);
  });

  await test.step("4/5: toggle to No numbing hides it; toggle back restores the unsaved draft", async () => {
    await page.getByRole("button", { name: "No numbing used", exact: true }).click();
    await expect(page.getByTestId("numbing-notes")).toHaveCount(0);
    await page.getByRole("button", { name: "Numbing used", exact: true }).click();
    await expect(page.getByTestId("numbing-notes")).toHaveValue("EMLA cream\napplied to chin");
  });

  await test.step("6: save as Numbing used → reload preserves status + exact notes", async () => {
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await page.getByTestId("save-treatment-area").click();
    await expect.poll(() => getSessionBlockCount(sessionId), { timeout: T }).toBe(1);
    const saved = await getSavedBlockSetup(sessionId);
    expect(saved?.numbing_status).toBe("used");
    expect(String(saved?.numbing_notes).replace(/\r\n/g, "\n")).toBe("EMLA cream\napplied to chin");
    // reload → field visible + populated
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await expect(page.getByText(/Numbing notes:/i)).toBeVisible({ timeout: T });
    await expect(page.getByText(/EMLA cream/)).toBeVisible();
  });

  await test.step("7: an unrelated edit preserves the stored notes", async () => {
    await page.getByTestId(/^edit-area-/).first().click();
    await expect(page.getByTestId("numbing-notes")).toHaveValue(/EMLA cream/, { timeout: T });
    // Change an UNRELATED field (the Additional notes free-text), keep numbing
    // used + its notes untouched.
    await page.getByTestId("additional-notes").fill("unrelated observation edit");
    await page.getByTestId("save-treatment-area").click();
    await expect.poll(async () => (await getSavedBlockSetup(sessionId))?.numbing_notes, { timeout: T })
      .toBe("EMLA cream\napplied to chin");
  });

  await test.step("8: switch to No numbing and save → notes cleared to NULL truthfully", async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId(/^edit-area-/).first().click();
    await expect(page.getByTestId("numbing-notes")).toBeVisible({ timeout: T });
    await page.getByRole("button", { name: "No numbing used", exact: true }).click();
    await expect(page.getByTestId("numbing-notes")).toHaveCount(0);
    await page.getByTestId("save-treatment-area").click();
    await expect.poll(async () => (await getSavedBlockSetup(sessionId))?.numbing_notes, { timeout: T }).toBeNull();
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await expect(page.getByText(/Numbing notes:/i)).toHaveCount(0);
  });
});

test("blank/whitespace numbing note saves as NULL (no placeholder) @390px", async ({ page }) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);
  await openForm(page, clientId, sessionId);
  await page.getByRole("button", { name: "Numbing used", exact: true }).click();
  await page.getByTestId("numbing-notes").fill("    ");
  await page.getByRole("button", { name: "Chin", exact: true }).click();
  await page.getByTestId("save-treatment-area").click();
  await expect.poll(() => getSessionBlockCount(sessionId), { timeout: T }).toBe(1);
  const saved = await getSavedBlockSetup(sessionId);
  expect(saved?.numbing_status).toBe("used");
  expect(saved?.numbing_notes).toBeNull();
});
