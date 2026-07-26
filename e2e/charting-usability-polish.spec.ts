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
//   B. Charting UNIFICATION: the form has ONE merged "Treatment observations &
//      skin response" multi-select box (observation presets PLUS the former
//      reaction labels). Every selection — including a reaction chip — persists
//      to observation_chips as a MULTI-select; a fresh record never writes the
//      legacy single-select reaction_type. On reload each pick shows as a
//      pressed chip.
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

test("collapse CTA, no-write open/cancel, one-block save, merged observation+reaction chips, multiline notes @390px", async ({
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

  await test.step("A3/B/C: open, fill the ONE merged chip box (observation + reaction) + multiline notes, save → exactly ONE block", async () => {
    await page.getByTestId("add-settings-block-cta").click();
    await expect(
      page.getByText(/Areas treated with these settings/i),
    ).toBeVisible({ timeout: T });
    await page.getByRole("button", { name: "Chin", exact: true }).click();

    // Charting unification: ONE merged box. Assert the merged heading is present
    // and the OLD separate "Client / skin response" heading is gone from the FORM.
    await expect(
      page.getByText("Treatment observations & skin response"),
    ).toBeVisible();
    await expect(page.getByText("Client / skin response")).toHaveCount(0);

    // The merged box is MULTI-select. Pick two observation chips AND a reaction
    // chip — all three are toggles in the SAME list, all writing observation_chips.
    await page.getByTestId("obs-chip-Dehydrated follicles").click();
    await page.getByTestId("obs-chip-Coarse hair").click();
    // The former reaction is now a multi-select chip in the merged list (stable
    // testid regardless of its selected/"+" label).
    await page.getByTestId("obs-chip-Mild redness").click();

    // Additional notes: multiline free text.
    await page
      .getByTestId("additional-notes")
      .fill("line one\nline two\nline three");

    await expectNoHorizontalOverflow(page);

    await page.getByTestId("save-treatment-area").click();
    await expect.poll(() => getSessionBlockCount(sessionId), { timeout: T }).toBe(1);
  });

  await test.step("reload + DB: all three picks (incl. the reaction) persist to observation_chips; reaction_type stays NULL; notes round-trip exactly", async () => {
    const saved = await getSavedBlockSetup(sessionId);
    // Every selection — the two observations AND the reaction — is captured in the
    // ONE canonical multi-select store (observation_chips).
    const chips = (saved?.entry as { observation_chips?: string[] } | null)
      ?.observation_chips;
    expect(Array.isArray(chips) ? chips.length : 0).toBe(3);
    expect(chips).toContain("Dehydrated follicles");
    expect(chips).toContain("Coarse hair");
    expect(chips).toContain("Mild redness");
    // A fresh record NEVER writes the legacy single-select reaction_type — the
    // reaction lives entirely in observation_chips now.
    expect(saved?.reaction_type).toBeNull();
    // Additional notes round-trips exactly (tolerate CRLF normalization).
    const comments = (saved?.entry as { comments?: string } | null)?.comments ?? "";
    expect(comments.replace(/\r\n/g, "\n")).toBe("line one\nline two\nline three");
  });

  await test.step("edit the saved block: all three chips reload PRESSED (multi-select); Cancel does not mutate it", async () => {
    await page.goto(url);
    await page.getByTestId(/^edit-area-/).first().click();
    await expect(page.getByTestId("additional-notes")).toHaveValue(
      /line one\s+line two\s+line three/,
      { timeout: T },
    );
    // Multi-select reload: every pick — the two observations AND the reaction —
    // comes back as a PRESSED chip in the merged list (a selected chip renders its
    // bare label without the leading "+", so assert via the stable testid).
    for (const label of ["Dehydrated follicles", "Coarse hair", "Mild redness"]) {
      await expect(
        page.getByTestId(`obs-chip-${label}`),
      ).toHaveAttribute("aria-pressed", "true", { timeout: T });
    }
    // Cancel → no mutation: reaction still captured as a chip, reaction_type NULL.
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    const after = await getSavedBlockSetup(sessionId);
    expect(after?.reaction_type).toBeNull();
    const afterChips =
      (after?.entry as { observation_chips?: string[] } | null)
        ?.observation_chips ?? [];
    expect(afterChips.length).toBe(3);
    expect(afterChips).toContain("Mild redness");
  });
});
