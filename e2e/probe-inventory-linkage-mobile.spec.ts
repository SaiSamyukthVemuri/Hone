import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eDraftElectrolysisSession,
  seedE2eProbeInventoryItem,
  getSessionBlockInventoryLinks,
  getSessionBlockAreas,
  getSavedBlockSetup,
  updateProbeInventoryLotNumber,
  updateProbeInventoryProbeKey,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Inventory-backed probe-lot linkage (Chloe item #9, migration 0155), real
// browser, real stack, 390px iPhone width. Proves the practitioner journey:
//   * charting offers ACTIVE inventory lots for the EXACT selected probe;
//   * a sole active lot auto-fills but is never auto-confirmed;
//   * confirming + saving stores BOTH the durable inventory link and the
//     immutable lot-number snapshot;
//   * edit + reload preserves the linkage (test point #16);
//   * switching the probe re-resolves to that probe's lot (probe-specific, #7);
//   * manual entry stays available and is NEVER inventory-linked (#6/#11).
// DB rows are ground truth.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const T = 20_000;
const F3_KEY = "sterex-gold-two-piece-f3-short";
const F2_KEY = "sterex-stainless-steel-two-piece-f2-short";

async function selectF3Probe(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Sterex", exact: true }).click();
  await page.getByRole("button", { name: "Gold", exact: true }).click();
  await page.getByRole("button", { name: "F3 Short", exact: true }).click();
}

test("inventory-backed probe lot: auto-fill active, confirm, save, edit+reload preserves link, probe switch re-resolves", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  // One ACTIVE lot for the F3 probe, and a DIFFERENT probe's active lot that
  // must never appear under F3.
  const { itemId: f3Id } = await seedE2eProbeInventoryItem(seed, {
    lotNumber: "F3-ACTIVE",
    description: "Sterex Gold F3 probe",
    probeKey: F3_KEY,
    expiryDate: null,
  });
  const { itemId: f2Id } = await seedE2eProbeInventoryItem(seed, {
    lotNumber: "F2-OTHER",
    description: "Sterex Stainless F2 probe",
    probeKey: F2_KEY,
    expiryDate: null,
  });
  await loginAsOwner(page, seed);

  // Plain navigation. The Add form only auto-opens on the FIRST load (no blocks
  // yet); after a block is saved, a reload shows the saved block and the edit
  // control instead, so callers assert the right surface for their step.
  const openCharting = async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  };

  await test.step("add an area + select the F3 probe → its sole ACTIVE lot auto-fills, linked, UNconfirmed", async () => {
    await openCharting();
    // Charting polish: explicit open (form no longer auto-renders).
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    await expect(
      page.getByText(/Areas treated with these settings/i),
    ).toBeVisible({ timeout: T });
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await expect(page.getByTestId("area-row-Chin")).toBeVisible();
    await selectF3Probe(page);
    // Auto-filled from the one active lot for THIS probe, linked but not confirmed.
    await expect(page.getByTestId("probe-lot-input")).toHaveValue("F3-ACTIVE", {
      timeout: T,
    });
    await expect(page.getByTestId("probe-lot-linked")).toBeVisible();
    await expect(page.getByTestId("probe-lot-source")).toHaveText(
      /Only active inventory lot for this probe/i,
    );
    // The other probe's lot is NOT auto-filled and NOT the linked value.
    await expect(page.getByTestId("probe-lot-input")).not.toHaveValue("F2-OTHER");
  });

  await test.step("confirm the package + save → durable link AND snapshot AND confirmation persist", async () => {
    await page.getByRole("button", { name: "Confirm lot/batch" }).click();
    await expect(
      page.getByRole("button", { name: "Confirmed ✓" }),
    ).toBeVisible();
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => JSON.stringify(await getSessionBlockInventoryLinks(sessionId)), {
        timeout: T,
      })
      .toBe(JSON.stringify([{ lot: "F3-ACTIVE", itemId: f3Id }]));
    const saved = await getSavedBlockSetup(sessionId);
    expect(saved?.probe_lot_confirmed).toBe(true);
    expect(saved?.probe_key).toBe(F3_KEY);
  });

  await test.step("#16 reload + edit → the saved inventory link is preserved (not re-resolved away)", async () => {
    await openCharting();
    // The saved block (not the auto-open add form) renders after a reload.
    await expect(page.getByText("F3-ACTIVE", { exact: false }).first()).toBeVisible({
      timeout: T,
    });
    await page.getByTestId(/^edit-area-/).first().click();
    await expect(page.getByTestId("probe-lot-input")).toHaveValue("F3-ACTIVE", {
      timeout: T,
    });
    await expect(page.getByTestId("probe-lot-linked")).toBeVisible();
  });

  await test.step("#7 switch the probe to F2 → the F3 link is dropped and the F2 lot re-resolves", async () => {
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByRole("button", { name: "Stainless steel", exact: true }).click();
    await page.getByRole("button", { name: "F2 Short", exact: true }).click();
    await expect(page.getByTestId("probe-lot-input")).toHaveValue("F2-OTHER", {
      timeout: T,
    });
    await expect(page.getByTestId("probe-lot-linked")).toBeVisible();
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => JSON.stringify(await getSessionBlockInventoryLinks(sessionId)), {
        timeout: T,
      })
      .toBe(JSON.stringify([{ lot: "F2-OTHER", itemId: f2Id }]));
  });
});

test("#7/#18 a later inventory lot correction never rewrites a charted block's frozen snapshot", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  const { itemId } = await seedE2eProbeInventoryItem(seed, {
    lotNumber: "ORIG-LOT",
    probeKey: F3_KEY,
    expiryDate: null,
  });
  await loginAsOwner(page, seed);

  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({
    timeout: T,
  });
  await page.getByRole("button", { name: "Chin", exact: true }).click();
  await selectF3Probe(page);
  await expect(page.getByTestId("probe-lot-input")).toHaveValue("ORIG-LOT", {
    timeout: T,
  });

  await test.step("confirm + save the linked block", async () => {
    await page.getByRole("button", { name: "Confirm lot/batch" }).click();
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => JSON.stringify(await getSessionBlockInventoryLinks(sessionId)), {
        timeout: T,
      })
      .toBe(JSON.stringify([{ lot: "ORIG-LOT", itemId }]));
  });

  await test.step("inventory lot is later corrected, then an UNRELATED edit is saved → snapshot stays ORIG-LOT", async () => {
    // Someone corrects/reuses the inventory lot number in Records.
    await updateProbeInventoryLotNumber(itemId, "CORRECTED-LOT");
    // Reopen the charted block and change an unrelated field (minutes).
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId(/^edit-area-/).first().click();
    await expect(page.getByTestId("probe-lot-input")).toHaveValue("ORIG-LOT", {
      timeout: T,
    });
    await page
      .getByRole("spinbutton", { name: /minutes performed/i })
      .fill("12");
    await page.getByTestId("save-treatment-area").click();
    // The frozen snapshot is preserved (NOT re-derived to CORRECTED-LOT); the
    // link still points at the same item.
    await expect
      .poll(async () => JSON.stringify(await getSessionBlockInventoryLinks(sessionId)), {
        timeout: T,
      })
      .toBe(JSON.stringify([{ lot: "ORIG-LOT", itemId }]));
  });
});

test("#3 inventory probe RECLASSIFICATION never blocks an unrelated historical edit (stored probe + link unchanged)", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  const { itemId } = await seedE2eProbeInventoryItem(seed, {
    lotNumber: "RC-LOT",
    probeKey: F3_KEY,
    expiryDate: null,
  });
  await loginAsOwner(page, seed);

  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({
    timeout: T,
  });
  // Cheeks + an explicit laterality gives a reliable, independently-observable
  // signal (session_block_areas) that a later edit actually persisted.
  await page.getByRole("button", { name: "Cheeks", exact: true }).click();
  await page.getByTestId("laterality-Cheeks-left").click();
  await selectF3Probe(page);
  await expect(page.getByTestId("probe-lot-input")).toHaveValue("RC-LOT", {
    timeout: T,
  });

  await test.step("confirm + save the F3-linked block", async () => {
    await page.getByRole("button", { name: "Confirm lot/batch" }).click();
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => (await getSessionBlockAreas(sessionId)).join(","), { timeout: T })
      .toBe("Cheeks|left");
    await expect
      .poll(async () => JSON.stringify(await getSessionBlockInventoryLinks(sessionId)), {
        timeout: T,
      })
      .toBe(JSON.stringify([{ lot: "RC-LOT", itemId }]));
  });

  await test.step("inventory item is later reclassified to a DIFFERENT probe, then an unrelated edit saves without a 'different probe' error", async () => {
    // Records reclassifies the sterile item F3 → F2 after the fact.
    await updateProbeInventoryProbeKey(itemId, F2_KEY);
    // Reopen the historical block; keep the (stored) F3 probe + link untouched,
    // change only the laterality (an unrelated edit).
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId(/^edit-area-/).first().click();
    await expect(page.getByTestId("probe-lot-input")).toHaveValue("RC-LOT", {
      timeout: T,
    });
    await page.getByTestId("laterality-Cheeks-right").click();
    await page.getByTestId("save-treatment-area").click();
    // The unrelated edit PERSISTED (laterality flipped) → the save was NOT
    // blocked by the reclassification...
    await expect
      .poll(async () => (await getSessionBlockAreas(sessionId)).join(","), { timeout: T })
      .toBe("Cheeks|right");
    // ...and no "different probe" error surfaced...
    await expect(page.getByText(/different probe/i)).toHaveCount(0);
    // ...and the frozen link + snapshot are preserved, with the stored probe
    // unchanged (F3) despite the inventory now being classified F2.
    expect(JSON.stringify(await getSessionBlockInventoryLinks(sessionId))).toBe(
      JSON.stringify([{ lot: "RC-LOT", itemId }]),
    );
    const saved = await getSavedBlockSetup(sessionId);
    expect(saved?.probe_key).toBe(F3_KEY);
  });
});

test("manual probe-lot entry stays available and is never inventory-linked (#6/#11)", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await seedE2eProbeInventoryItem(seed, {
    lotNumber: "F3-ACTIVE",
    probeKey: F3_KEY,
    expiryDate: null,
  });
  await loginAsOwner(page, seed);

  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({
    timeout: T,
  });
  await page.getByRole("button", { name: "Chin", exact: true }).click();
  await selectF3Probe(page);
  // The active lot auto-fills first...
  await expect(page.getByTestId("probe-lot-input")).toHaveValue("F3-ACTIVE", {
    timeout: T,
  });

  await test.step("typing a manual lot breaks the link and flags it as manual", async () => {
    await page.getByTestId("probe-lot-input").fill("HAND-WRITTEN-42");
    await expect(page.getByTestId("probe-lot-manual")).toBeVisible();
    await expect(page.getByTestId("probe-lot-linked")).toHaveCount(0);
  });

  await test.step("save → the snapshot is the typed text with NO inventory link", async () => {
    await page.getByRole("button", { name: "Confirm lot/batch" }).click();
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => JSON.stringify(await getSessionBlockInventoryLinks(sessionId)), {
        timeout: T,
      })
      .toBe(JSON.stringify([{ lot: "HAND-WRITTEN-42", itemId: null }]));
  });
});
