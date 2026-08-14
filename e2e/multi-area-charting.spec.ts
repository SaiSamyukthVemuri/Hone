import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eDraftElectrolysisSession,
  seedE2eBlockWithStructuredAreas,
  seedE2eInactivateSession,
  getSessionBlockAreas,
  getBlockPrimaryArea,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Multi-area + per-area laterality charting (migration 0128), real browser,
// real stack, iPad width. One settings block treats multiple areas, each with
// its own laterality; the DB rows + the reload are ground truth.

test.use({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });

const T = 20_000;

test("one settings block treats multiple areas with independent laterality", async ({ page }) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);

  const openForm = async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    // Charting polish: the form no longer auto-opens, a zero-block session
    // shows the compact CTA, and opening is an explicit tap.
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({ timeout: T });
  };

  await test.step("add Cheeks + Sideburns to one settings block", async () => {
    await openForm();
    await page.getByRole("button", { name: "Cheeks", exact: true }).click();
    await page.getByRole("button", { name: "Sideburns", exact: true }).click();
    await expect(page.getByTestId("area-row-Cheeks")).toBeVisible();
    await expect(page.getByTestId("area-row-Sideburns")).toBeVisible();
  });

  await test.step("set Left cheeks + Right sideburns", async () => {
    await page.getByTestId("laterality-Cheeks-left").click();
    await page.getByTestId("laterality-Sideburns-right").click();
    await expect(page.getByTestId("laterality-Cheeks-left")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("laterality-Sideburns-right")).toHaveAttribute("aria-pressed", "true");
  });

  await test.step("save → DB holds both areas with the right laterality", async () => {
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => (await getSessionBlockAreas(sessionId)).join(","), { timeout: T })
      .toBe("Cheeks|left,Sideburns|right");
  });

  await test.step("reload → the saved block shows both areas + laterality", async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await expect(page.getByText("Left Cheeks", { exact: false })).toBeVisible({ timeout: T });
    await expect(page.getByText("Right Sideburns", { exact: false })).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Session 1C: the block just charted is the exact defect shape. Its legacy
  // `primary_area` is "Cheeks" (the FIRST area); the sideburns exist only as a
  // structured child row. Global Search used to match parent columns only, so
  // searching "Sideburns" found nothing, while a result, once found by other
  // means, displayed the sideburns perfectly. Recall gap, not a display gap.
  // -------------------------------------------------------------------------
  await test.step("Global Search finds the treatment by its SECONDARY area", async () => {
    // Ground truth first: the parent column really does say Cheeks, so a hit on
    // "Sideburns" cannot have come from the direct path.
    expect(await getBlockPrimaryArea(sessionId)).toBe("Cheeks");

    const search = page.getByRole("searchbox", { name: "Search Hone" });
    await search.click();
    await search.fill("Sideburns");
    const memoryResults = page.getByRole("link", { name: /Left Cheeks · Right Sideburns/ });
    await expect(memoryResults).toHaveCount(1, { timeout: T });
    // The subtitle carries the COMPLETE treated-area set, not just the match...
    await expect(memoryResults.first()).toContainText("Left Cheeks · Right Sideburns");
    // ...the result is attributed to the right client (the session's own client,
    // seeded by seedE2eDraftElectrolysisSession, NOT seed.clientName, which
    // belongs to a different client in the same studio)...
    await expect(memoryResults.first()).toContainText(`Area Client ${seed.runId}`);
    await expect(memoryResults.first()).toHaveAttribute(
      "href",
      new RegExp(`^/clients/${clientId}/sessions/${sessionId}$`),
    );
    // ...and it is grouped under Treatment Memory, not Clients.
    await expect(page.getByText("Treatment Memory").first()).toBeVisible();
  });

  await test.step("searching the PRIMARY area returns the same treatment once, not twice", async () => {
    const search = page.getByRole("searchbox", { name: "Search Hone" });
    await search.fill("Cheeks");
    await expect(
      page.getByRole("link", { name: /Left Cheeks · Right Sideburns/ }),
    ).toHaveCount(1, { timeout: T });
  });

  await test.step("selecting the result navigates to the correct session", async () => {
    const search = page.getByRole("searchbox", { name: "Search Hone" });
    await search.fill("Sideburns");
    await page
      .getByRole("link", { name: /Left Cheeks · Right Sideburns/ })
      .first()
      .click({ timeout: T });
    await expect(page).toHaveURL(
      new RegExp(`/clients/${clientId}/sessions/${sessionId}`),
    );
  });

  await test.step("newer DELETED and VOID sessions with the same term never appear", async () => {
    // Both are seeded NEWER than the live block, so an implementation that
    // filtered after the four-slot cap would hide the valid result entirely.
    const dead = await seedE2eDraftElectrolysisSession(seed);
    await seedE2eBlockWithStructuredAreas(seed, dead.sessionId, {
      primaryArea: "Sideburns",
      areas: [{ area: "Sideburns", laterality: "left" }],
    });
    await seedE2eInactivateSession(dead.sessionId, { deleted: true });

    const voided = await seedE2eDraftElectrolysisSession(seed);
    await seedE2eBlockWithStructuredAreas(seed, voided.sessionId, {
      primaryArea: "Sideburns",
      areas: [{ area: "Sideburns", laterality: "left" }],
    });
    await seedE2eInactivateSession(voided.sessionId, { recordStatus: "void" });

    const search = page.getByRole("searchbox", { name: "Search Hone" });
    await search.fill("Sideburns");
    // The valid multi-area treatment is still there...
    const valid = page.getByRole("link", { name: /Left Cheeks · Right Sideburns/ });
    await expect(valid).toHaveCount(1, { timeout: T });
    // ...and the inactive ones contributed nothing: their blocks carry the
    // legacy primary_area "Sideburns" alone, so they would render a bare
    // "Sideburns" label, never the combined one.
    await expect(
      page.getByRole("link", { name: /Session · Left Sideburns$/ }),
    ).toHaveCount(0);
    // Following the surviving result still lands on a real session page.
    await valid.first().click({ timeout: T });
    await expect(page).toHaveURL(
      new RegExp(`/clients/${clientId}/sessions/${sessionId}`),
    );
    await expect(page.getByText("Left Cheeks", { exact: false })).toBeVisible({ timeout: T });
  });

  await test.step("a foreign studio's area value returns nothing", async () => {
    // Studio B genuinely HAS this treatment, and can find it, so an empty
    // result for studio A is tenant isolation, not an empty database.
    const other = await seedE2eStudio();
    const otherSession = await seedE2eDraftElectrolysisSession(other);
    await seedE2eBlockWithStructuredAreas(other, otherSession.sessionId, {
      primaryArea: "Nape",
      areas: [
        { area: "Nape", laterality: "midline" },
        { area: "Coccyx", laterality: "midline" },
      ],
    });
    const search = page.getByRole("searchbox", { name: "Search Hone" });
    await search.fill("Coccyx");
    await expect(page.getByText("No results found.")).toBeVisible({ timeout: T });
    await page.keyboard.press("Escape");
  });

  await test.step("edit → remove one area → save → only that area is gone", async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId(/^edit-area-/).first().click();
    await expect(page.getByTestId("area-row-Sideburns")).toBeVisible({ timeout: T });
    await page.getByRole("button", { name: /Remove Sideburns/i }).click();
    await expect(page.getByTestId("area-row-Sideburns")).toHaveCount(0);
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => (await getSessionBlockAreas(sessionId)).join(","), { timeout: T })
      .toBe("Cheeks|left");
  });
});
