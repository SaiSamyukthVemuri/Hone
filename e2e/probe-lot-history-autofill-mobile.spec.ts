import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eDraftElectrolysisSession,
  seedE2eChartedProbeLot,
  seedE2eProbeInventoryItem,
  getSessionBlockInventoryLinks,
  getSavedBlockSetup,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Chloe: "the probe lot/batch doesn't come back on its own — I retype it every
// appointment." Real browser, real stack, 390px iPhone width.
//
// ROOT CAUSE this proves fixed: the charting form only ever consulted INVENTORY.
// A studio with no probe inventory (which is the live shape) resolved `choose`
// on every probe selection, and the form CLEARED the field — so the recorded
// history the practitioner had already charted many times was never offered.
//
// The inventory-backed journey (auto-fill, confirm, link, freeze) is proven in
// probe-inventory-linkage-mobile.spec.ts and is unchanged. This spec proves the
// history path and the precedence between them.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const T = 20_000;
const F3_KEY = "sterex-gold-two-piece-f3-short";
const F2_KEY = "sterex-stainless-steel-two-piece-f2-short";
const F2_LABEL = "Sterex · Stainless steel · Two-piece · F2 Short";

async function selectF3Probe(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Sterex", exact: true }).click();
  await page.getByRole("button", { name: "Gold", exact: true }).click();
  await page.getByRole("button", { name: "F3 Short", exact: true }).click();
}

async function switchToF2Probe(page: import("@playwright/test").Page) {
  // Scoped testid: once an area is chosen the area picker also renders a
  // "Change" control, so the bare role+name is ambiguous.
  await page.getByTestId("probe-change").click();
  await page.getByRole("button", { name: "Stainless steel", exact: true }).click();
  await page.getByRole("button", { name: "F2 Short", exact: true }).click();
}

async function openAddForm(page: import("@playwright/test").Page, clientId: string, sessionId: string) {
  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({
    timeout: T,
  });
}

test("zero inventory: the last CHARTED lot for the probe auto-fills, is never inventory-linked, and re-resolves per probe", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  // A PREVIOUS appointment (different client, same studio) where the lot was
  // typed by hand — no inventory anywhere in this studio.
  const prior = await seedE2eDraftElectrolysisSession(seed);
  await seedE2eChartedProbeLot(seed, prior.sessionId, {
    lotNumber: "HIST-F3",
    probeKey: F3_KEY,
    confirmed: true,
  });
  await seedE2eChartedProbeLot(seed, prior.sessionId, {
    lotNumber: "HIST-F2",
    probeKey: F2_KEY,
    confirmed: true,
    primaryArea: "Upper lip",
  });
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);

  await test.step("select the F3 probe → the lot she last charted for F3 is already there", async () => {
    await openAddForm(page, clientId, sessionId);
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await selectF3Probe(page);
    await expect(page.getByTestId("probe-lot-input")).toHaveValue("HIST-F3", {
      timeout: T,
    });
    // Truthful provenance: it came from charting, and carries NO inventory link.
    await expect(page.getByTestId("probe-lot-source")).toHaveText(
      /last charted lot for this probe.*not linked to inventory/i,
    );
    await expect(page.getByTestId("probe-lot-linked")).toHaveCount(0);
    // The OTHER probe's lot never leaks in.
    await expect(page.getByTestId("probe-lot-input")).not.toHaveValue("HIST-F2");
  });

  await test.step("changing the probe re-resolves that probe's own lot", async () => {
    await switchToF2Probe(page);
    await expect(page.getByTestId("probe-lot-input")).toHaveValue("HIST-F2", {
      timeout: T,
    });
    await expect(page.getByTestId("probe-lot-linked")).toHaveCount(0);
  });

  await test.step("save → the lot NUMBER persists, the inventory link stays NULL, and it is not auto-confirmed", async () => {
    // Auto-fill never confirms: nothing was checked against a physical package.
    await expect(page.getByRole("button", { name: "Confirm lot/batch" })).toBeVisible();
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => JSON.stringify(await getSessionBlockInventoryLinks(sessionId)), {
        timeout: T,
      })
      .toBe(JSON.stringify([{ lot: "HIST-F2", itemId: null }]));
    const saved = await getSavedBlockSetup(sessionId);
    expect(saved?.probe_lot_confirmed).toBe(false);
    expect(saved?.probe_key).toBe(F2_KEY);
  });

  await test.step("reload + edit → the saved value is preserved, not re-resolved away", async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId(/^edit-area-/).first().click();
    await expect(page.getByTestId("probe-lot-input")).toHaveValue("HIST-F2", {
      timeout: T,
    });
  });
});

test("legacy free-text history (no probe_key) still auto-fills via the normalized display label", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const prior = await seedE2eDraftElectrolysisSession(seed);
  // A row predating the structured probe catalog: probe_key NULL, label only.
  await seedE2eChartedProbeLot(seed, prior.sessionId, {
    lotNumber: "LEGACY-LOT",
    probeKey: null,
    probeLabel: F2_LABEL,
  });
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);

  await openAddForm(page, clientId, sessionId);
  await page.getByRole("button", { name: "Chin", exact: true }).click();
  await page.getByRole("button", { name: "Sterex", exact: true }).click();
  await page.getByRole("button", { name: "Stainless steel", exact: true }).click();
  await page.getByRole("button", { name: "F2 Short", exact: true }).click();
  await expect(page.getByTestId("probe-lot-input")).toHaveValue("LEGACY-LOT", {
    timeout: T,
  });
  await expect(page.getByTestId("probe-lot-linked")).toHaveCount(0);
});

// Review finding (P2): the server enforces the expired-lot rule only on the
// inventory-LINKED path. If auto-fill put an expired lot in as free text, the
// record would carry an expired lot number with the link dropped and no expiry
// shown anywhere on screen.
test("an EXPIRED inventory lot is never auto-filled from history — the picker is shown instead", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const prior = await seedE2eDraftElectrolysisSession(seed);
  await seedE2eChartedProbeLot(seed, prior.sessionId, {
    lotNumber: "EXP-F3",
    probeKey: F3_KEY,
    confirmed: true,
  });
  // The studio DOES stock this probe, but the only lot has expired — and it is
  // the same lot she last charted.
  await seedE2eProbeInventoryItem(seed, {
    lotNumber: "EXP-F3",
    probeKey: F3_KEY,
    expiryDate: "2000-01-01",
  });
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);

  await openAddForm(page, clientId, sessionId);
  await page.getByRole("button", { name: "Chin", exact: true }).click();
  await selectF3Probe(page);
  await expect(page.getByTestId("probe-lot-input")).toHaveValue("", { timeout: T });
  await expect(page.getByTestId("probe-lot-source")).toHaveText(
    /Choose the lot\/batch from inventory/i,
  );
  await expect(page.getByTestId("probe-lot-linked")).toHaveCount(0);
});

test("a lot charted in ANOTHER studio never auto-fills", async ({ page }) => {
  const other = await seedE2eStudio();
  const otherSession = await seedE2eDraftElectrolysisSession(other);
  await seedE2eChartedProbeLot(other, otherSession.sessionId, {
    lotNumber: "OTHER-STUDIO-LOT",
    probeKey: F3_KEY,
    confirmed: true,
  });

  const seed = await seedE2eStudio(); // no history, no inventory of its own
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);

  await openAddForm(page, clientId, sessionId);
  await page.getByRole("button", { name: "Chin", exact: true }).click();
  await selectF3Probe(page);
  // Nothing known for this studio → the field stays blank for manual entry, and
  // the other studio's lot is nowhere on the page.
  await expect(page.getByTestId("probe-lot-input")).toHaveValue("", { timeout: T });
  await expect(page.getByTestId("probe-lot-source")).toHaveCount(0);
  await expect(page.getByText("OTHER-STUDIO-LOT")).toHaveCount(0);
});

test("active INVENTORY outranks charted history, and a manual override is never replaced", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const prior = await seedE2eDraftElectrolysisSession(seed);
  await seedE2eChartedProbeLot(seed, prior.sessionId, {
    lotNumber: "HIST-F3",
    probeKey: F3_KEY,
    confirmed: true,
  });
  // The same probe also has a real, active inventory lot.
  const { itemId } = await seedE2eProbeInventoryItem(seed, {
    lotNumber: "INV-F3",
    probeKey: F3_KEY,
    expiryDate: null,
  });
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);

  await test.step("inventory wins: the traceable, linked lot is filled — not the history one", async () => {
    await openAddForm(page, clientId, sessionId);
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await selectF3Probe(page);
    await expect(page.getByTestId("probe-lot-input")).toHaveValue("INV-F3", {
      timeout: T,
    });
    await expect(page.getByTestId("probe-lot-linked")).toBeVisible();
    await expect(page.getByTestId("probe-lot-source")).toHaveText(
      /Only active inventory lot for this probe/i,
    );
  });

  await test.step("typing her own lot wins over inventory FOR THAT PROBE, and drops the link", async () => {
    await page.getByTestId("probe-lot-input").fill("TYPED-BY-HAND");
    await expect(page.getByTestId("probe-lot-linked")).toHaveCount(0);
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => JSON.stringify(await getSessionBlockInventoryLinks(sessionId)), {
        timeout: T,
      })
      .toBe(JSON.stringify([{ lot: "TYPED-BY-HAND", itemId: null }]));
    // The inventory row was never consumed by this block.
    expect(itemId).toBeTruthy();
  });

  // CORRECTED. This step previously asserted that a typed lot SURVIVES a probe
  // change. That was the defect: a lot belongs to one probe, so carrying it to a
  // different probe made the record claim a lot never used on it. Provenance is
  // now per-probe (see probe-lot-scope-and-copy-mobile.spec.ts for the full
  // matrix); a probe change always re-resolves for the newly selected probe.
  await test.step("a typed lot does NOT follow her onto a different probe", async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId(/^edit-area-/).first().click();
    await expect(page.getByTestId("probe-lot-input")).toHaveValue("TYPED-BY-HAND", {
      timeout: T,
    });
    await switchToF2Probe(page);
    await expect(page.getByTestId("probe-lot-input")).not.toHaveValue("TYPED-BY-HAND");
    // F2 has neither inventory nor charted history in this studio → blank.
    await expect(page.getByTestId("probe-lot-input")).toHaveValue("", { timeout: T });
  });
});
