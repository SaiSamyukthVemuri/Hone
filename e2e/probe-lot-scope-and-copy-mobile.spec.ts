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

// A lot/batch belongs to ONE probe. Real browser, real stack, 390px iPhone.
//
// TWO DEFECTS THIS PROVES FIXED:
//
//  1. Manual override was scoped GLOBALLY, not per probe. `lotEditedManually`
//     latched true on the first keystroke and never cleared, so after typing a
//     lot for a Sterex F4 and then selecting a DIFFERENT probe, the F4 lot sat
//     under the new probe. The record then claimed a lot never used on it.
//
//  2. "Copy settings from another area" copied the probe but NOT its lot, so
//     the auto-fill resolver immediately filled the copied probe's lot from
//     unrelated charting history — silently swapping a traceability value the
//     practitioner believed she had copied.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const T = 20_000;
const F4_KEY = "sterex-gold-two-piece-f4-short";
const F2_KEY = "sterex-stainless-steel-two-piece-f2-short";

// Select a probe from whatever state the picker is in. A fresh form shows the
// full brand → material → size list; once a probe is chosen it collapses to a
// summary with "Change"; and right after "Copy settings" the value is set
// externally while the picker is still expanded. All three are real states.
async function pickProbe(
  page: import("@playwright/test").Page,
  material: "Gold" | "Stainless steel",
  size: "F4 Short" | "F2 Short",
) {
  const change = page.getByTestId("probe-change");
  if ((await change.count()) > 0) await change.click();
  const brand = page.getByRole("button", { name: "Sterex", exact: true });
  if ((await brand.count()) > 0) await brand.click();
  await page.getByRole("button", { name: material, exact: true }).click();
  await page.getByRole("button", { name: size, exact: true }).click();
}

async function openAddForm(
  page: import("@playwright/test").Page,
  clientId: string,
  sessionId: string,
) {
  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({
    timeout: T,
  });
}

// ---------------------------------------------------------------------------
// 1. Manual override is scoped to the selected probe.
// ---------------------------------------------------------------------------
test("a manual lot is bound to its probe: it survives re-renders, and a probe switch replaces it", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  // Recorded history for the OTHER probe only, so the switch has something
  // real to resolve to and the assertion cannot pass by accident.
  const prior = await seedE2eDraftElectrolysisSession(seed);
  await seedE2eChartedProbeLot(seed, prior.sessionId, {
    lotNumber: "HIST-F2",
    probeKey: F2_KEY,
  });
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);

  const lot = page.getByTestId("probe-lot-input");

  await test.step("type a lot for the F4 probe", async () => {
    await openAddForm(page, clientId, sessionId);
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await pickProbe(page, "Gold", "F4 Short");
    await lot.fill("TYPED-F4");
    await expect(lot).toHaveValue("TYPED-F4");
  });

  await test.step("it survives unrelated re-renders while F4 stays selected", async () => {
    // Each of these re-renders the form; none of them is a probe change.
    await page.getByRole("spinbutton", { name: /minutes performed/i }).fill("14");
    await page.getByRole("button", { name: "Upper lip", exact: true }).click();
    await expect(page.getByTestId("area-row-Upper lip")).toBeVisible();
    await expect(lot).toHaveValue("TYPED-F4");
  });

  await test.step("switching F4 → F2 removes the F4 lot and resolves F2's own", async () => {
    await pickProbe(page, "Stainless steel", "F2 Short");
    await expect(lot).toHaveValue("HIST-F2", { timeout: T });
    await expect(lot).not.toHaveValue("TYPED-F4");
    await expect(page.getByTestId("probe-lot-source")).toHaveText(
      /last charted lot for this probe/i,
    );
  });

  await test.step("switching back to F4 resolves F4 again (not the stale typed value)", async () => {
    await pickProbe(page, "Gold", "F4 Short");
    // F4 has no inventory and no charted history in this studio → blank, and
    // emphatically NOT the F2 lot that was on screen a moment ago.
    await expect(lot).toHaveValue("", { timeout: T });
    await expect(lot).not.toHaveValue("HIST-F2");
  });

  await test.step("saving stores the lot for the probe actually selected", async () => {
    await pickProbe(page, "Stainless steel", "F2 Short");
    await expect(lot).toHaveValue("HIST-F2", { timeout: T });
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => JSON.stringify(await getSessionBlockInventoryLinks(sessionId)), {
        timeout: T,
      })
      .toBe(JSON.stringify([{ lot: "HIST-F2", itemId: null }]));
    const saved = await getSavedBlockSetup(sessionId);
    expect(saved?.probe_key).toBe(F2_KEY);
    expect(saved?.probe_lot_confirmed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2a. "Add another pass" leaves the block's lot + link untouched.
// ---------------------------------------------------------------------------
test("adding another pass preserves the block's exact lot AND its inventory linkage", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { itemId } = await seedE2eProbeInventoryItem(seed, {
    lotNumber: "INV-F4",
    probeKey: F4_KEY,
    expiryDate: null,
  });
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);

  await openAddForm(page, clientId, sessionId);
  await page.getByRole("button", { name: "Chin", exact: true }).click();
  await pickProbe(page, "Gold", "F4 Short");
  await expect(page.getByTestId("probe-lot-input")).toHaveValue("INV-F4", {
    timeout: T,
  });
  await page.getByRole("button", { name: "Confirm lot/batch" }).click();
  await page.getByTestId("save-treatment-area").click();
  await expect
    .poll(async () => JSON.stringify(await getSessionBlockInventoryLinks(sessionId)), {
      timeout: T,
    })
    .toBe(JSON.stringify([{ lot: "INV-F4", itemId }]));

  await test.step("add a second pass under the same block → lot, link and confirmation are unchanged", async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByRole("button", { name: /Add another pass/i }).click({ timeout: T });
    const form = page.getByTestId("add-pass-form");
    await expect(form).toBeVisible({ timeout: T });
    await form.getByRole("button", { name: "Chin", exact: true }).click();
    await form.getByTestId("add-pass-submit").click();
    // DB is ground truth: exactly one block, same lot, same link.
    await expect
      .poll(async () => JSON.stringify(await getSessionBlockInventoryLinks(sessionId)), {
        timeout: T,
      })
      .toBe(JSON.stringify([{ lot: "INV-F4", itemId }]));
    const saved = await getSavedBlockSetup(sessionId);
    expect(saved?.probe_lot_confirmed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2b. In-form "Copy settings from another area in this session".
// ---------------------------------------------------------------------------
test("copy settings carries the EXACT lot + link, and never lets history overwrite it", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  // Charted history for F4 that would WIN the resolver if the copy left the lot
  // blank — this is what used to silently replace the copied value.
  const prior = await seedE2eDraftElectrolysisSession(seed);
  await seedE2eChartedProbeLot(seed, prior.sessionId, {
    lotNumber: "HISTORY-SHOULD-NOT-WIN",
    probeKey: F4_KEY,
  });
  const { itemId } = await seedE2eProbeInventoryItem(seed, {
    lotNumber: "INV-F4",
    probeKey: F4_KEY,
    expiryDate: null,
  });
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);

  await test.step("save a first area on the F4 probe, linked to inventory", async () => {
    await openAddForm(page, clientId, sessionId);
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await pickProbe(page, "Gold", "F4 Short");
    await expect(page.getByTestId("probe-lot-input")).toHaveValue("INV-F4", {
      timeout: T,
    });
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => (await getSessionBlockInventoryLinks(sessionId)).length, {
        timeout: T,
      })
      .toBe(1);
  });

  await test.step("copy into a new area → the copied lot arrives exactly, link intact, unconfirmed", async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    await page.getByRole("button", { name: "Upper lip", exact: true }).click();
    await page.getByRole("button", { name: /Copy settings from another area/i }).click();
    await expect(page.getByTestId("probe-lot-input")).toHaveValue("INV-F4", {
      timeout: T,
    });
    // NOT the history lot — that is the exact swap this fixes.
    await expect(page.getByTestId("probe-lot-input")).not.toHaveValue(
      "HISTORY-SHOULD-NOT-WIN",
    );
    await expect(page.getByTestId("probe-lot-linked")).toBeVisible();
    // A copy is a transcription, never a confirmation.
    await expect(page.getByRole("button", { name: "Confirm lot/batch" })).toBeVisible();
    await expect(page.getByTestId("probe-lot-source")).toHaveText(
      /Copied with these settings/i,
    );
  });

  await test.step("choosing a DIFFERENT probe after the copy runs the normal resolver", async () => {
    await pickProbe(page, "Stainless steel", "F2 Short");
    // F2 has neither inventory nor history here → blank, and the copied F4 lot
    // is gone rather than following the practitioner onto another probe.
    await expect(page.getByTestId("probe-lot-input")).toHaveValue("", { timeout: T });
    await expect(page.getByTestId("probe-lot-linked")).toHaveCount(0);
  });

  await test.step("re-copy, then save → the copied lot and link persist to the DB", async () => {
    await page.getByRole("button", { name: /Copy settings from another area/i }).click();
    await expect(page.getByTestId("probe-lot-input")).toHaveValue("INV-F4", {
      timeout: T,
    });
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => JSON.stringify(await getSessionBlockInventoryLinks(sessionId)), {
        timeout: T,
      })
      .toBe(JSON.stringify([{ lot: "INV-F4", itemId }, { lot: "INV-F4", itemId }]));
  });
});

test("copy settings preserves the lot text but DROPS the link when the source lot is no longer active", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  // Active today, so the first area can be linked...
  const { itemId } = await seedE2eProbeInventoryItem(seed, {
    lotNumber: "SOON-EXPIRED",
    probeKey: F4_KEY,
    expiryDate: null,
  });
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);

  await openAddForm(page, clientId, sessionId);
  await page.getByRole("button", { name: "Chin", exact: true }).click();
  await pickProbe(page, "Gold", "F4 Short");
  await expect(page.getByTestId("probe-lot-input")).toHaveValue("SOON-EXPIRED", {
    timeout: T,
  });
  await page.getByRole("button", { name: "Confirm lot/batch" }).click();
  await page.getByTestId("save-treatment-area").click();
  await expect
    .poll(async () => JSON.stringify(await getSessionBlockInventoryLinks(sessionId)), {
      timeout: T,
    })
    .toBe(JSON.stringify([{ lot: "SOON-EXPIRED", itemId }]));

  await test.step("the lot expires, then a copy carries the TEXT but not the link", async () => {
    const { expireProbeInventoryItem } = await import("./helpers/seed");
    await expireProbeInventoryItem(itemId);
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    await page.getByRole("button", { name: "Upper lip", exact: true }).click();
    await page.getByRole("button", { name: /Copy settings from another area/i }).click();
    // She still sees exactly what she copied...
    await expect(page.getByTestId("probe-lot-input")).toHaveValue("SOON-EXPIRED", {
      timeout: T,
    });
    // ...but the record no longer claims traceability to an expired package,
    // and it is not confirmed.
    await expect(page.getByTestId("probe-lot-linked")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Confirm lot/batch" })).toBeVisible();
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => JSON.stringify(await getSessionBlockInventoryLinks(sessionId)), {
        timeout: T,
      })
      .toBe(
        JSON.stringify([
          { lot: "SOON-EXPIRED", itemId },
          { lot: "SOON-EXPIRED", itemId: null },
        ]),
      );
  });
});

test("copy settings in a studio with ZERO inventory carries the manual lot text, unlinked", async ({
  page,
}) => {
  const seed = await seedE2eStudio(); // no probe inventory at all
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);

  await openAddForm(page, clientId, sessionId);
  await page.getByRole("button", { name: "Chin", exact: true }).click();
  await pickProbe(page, "Gold", "F4 Short");
  await page.getByTestId("probe-lot-input").fill("HANDWRITTEN-99");
  await page.getByTestId("save-treatment-area").click();
  await expect
    .poll(async () => JSON.stringify(await getSessionBlockInventoryLinks(sessionId)), {
      timeout: T,
    })
    .toBe(JSON.stringify([{ lot: "HANDWRITTEN-99", itemId: null }]));

  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  await page.getByRole("button", { name: "Upper lip", exact: true }).click();
  await page.getByRole("button", { name: /Copy settings from another area/i }).click();
  await expect(page.getByTestId("probe-lot-input")).toHaveValue("HANDWRITTEN-99", {
    timeout: T,
  });
  await expect(page.getByTestId("probe-lot-linked")).toHaveCount(0);
});
