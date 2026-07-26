import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eDraftElectrolysisSession,
  getSessionBlockCount,
  getSavedBlockSetup,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Chloe charting-usability polish — real browser, real stack, 390px iPhone
// width. Proves the three narrow behaviours end to end:
//   A. a zero-block session starts on the compact CTA (form not auto-open);
//      opening then cancelling writes NO block; saving writes exactly ONE.
//   B. Treatment observations (multi-select) and Client/skin response
//      (single-select) persist INDEPENDENTLY.
//   C. Additional notes accepts multiline content that round-trips exactly,
//      with no horizontal overflow at 390px.
// DB rows are ground truth.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const T = 20_000;

async function expectNoHorizontalOverflow(page: Page) {
  const [scrollW, clientW] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(
    scrollW,
    `page must not scroll horizontally (scrollWidth ${scrollW} vs clientWidth ${clientW})`,
  ).toBeLessThanOrEqual(clientW);
}

test("collapse CTA, no-write open/cancel, one-block save, independent chip groups, multiline notes @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);
  const url = `/clients/${clientId}/sessions/${sessionId}`;

  await test.step("A1: zero-block session shows the compact CTA, NOT the full form", async () => {
    await page.goto(url);
    await expect(page.getByTestId("add-settings-block-cta")).toBeVisible({
      timeout: T,
    });
    await expect(
      page.getByText(/Areas treated with these settings/i),
    ).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  await test.step("A2: open then Cancel → returns to the CTA and writes NO block", async () => {
    await page.getByTestId("add-settings-block-cta").click();
    await expect(
      page.getByText(/Areas treated with these settings/i),
    ).toBeVisible({ timeout: T });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByTestId("add-settings-block-cta")).toBeVisible();
    expect(await getSessionBlockCount(sessionId)).toBe(0);
  });

  await test.step("A3/B/C: open, fill both chip groups + multiline notes, save → exactly ONE block", async () => {
    await page.getByTestId("add-settings-block-cta").click();
    await expect(
      page.getByText(/Areas treated with these settings/i),
    ).toBeVisible({ timeout: T });
    await page.getByRole("button", { name: "Chin", exact: true }).click();

    // Treatment observations = MULTI-select: pick two distinct chips.
    await page.getByTestId("obs-chip-Dehydrated follicles").click();
    await page.getByTestId("obs-chip-Coarse hair").click();

    // Client/skin response = SINGLE-select: pick one reaction.
    await page.getByRole("button", { name: "+ Mild redness", exact: true }).click();

    // Additional notes: multiline free text.
    await page
      .getByTestId("additional-notes")
      .fill("line one\nline two\nline three");

    await expectNoHorizontalOverflow(page);

    await page.getByTestId("save-treatment-area").click();
    await expect.poll(() => getSessionBlockCount(sessionId), { timeout: T }).toBe(1);
  });

  await test.step("reload + DB: the two chip groups persisted INDEPENDENTLY; notes round-trip exactly", async () => {
    const saved = await getSavedBlockSetup(sessionId);
    // Observations (multi-select) persisted to the entry's observation_chips.
    const chips = (saved?.entry as { observation_chips?: string[] } | null)
      ?.observation_chips;
    expect(Array.isArray(chips) ? chips.length : 0).toBe(2);
    expect(chips).toContain("Dehydrated follicles");
    expect(chips).toContain("Coarse hair");
    // Client/skin response (single-select) persisted to the block's reaction_type
    // — a SEPARATE field, unaffected by the observation selections.
    expect(saved?.reaction_type).toBe("mild_redness");
    // Additional notes round-trips exactly (tolerate CRLF normalization).
    const comments = (saved?.entry as { comments?: string } | null)?.comments ?? "";
    expect(comments.replace(/\r\n/g, "\n")).toBe("line one\nline two\nline three");
  });

  await test.step("edit the saved block: values reload; Cancel does not mutate it", async () => {
    await page.goto(url);
    await page.getByTestId(/^edit-area-/).first().click();
    await expect(page.getByTestId("additional-notes")).toHaveValue(
      /line one\s+line two\s+line three/,
      { timeout: T },
    );
    // The saved reaction chip shows pressed (single-select state reloaded). The
    // label always renders with a leading "+", pressed or not.
    await expect(
      page.getByRole("button", { name: "+ Mild redness", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    // Cancel → no mutation.
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    const after = await getSavedBlockSetup(sessionId);
    expect(after?.reaction_type).toBe("mild_redness");
    expect(
      ((after?.entry as { observation_chips?: string[] } | null)
        ?.observation_chips ?? []).length,
    ).toBe(2);
  });
});
