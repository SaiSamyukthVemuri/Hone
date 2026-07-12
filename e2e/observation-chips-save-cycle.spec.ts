import { test, expect, type Page, type Locator } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eDraftSessionWithLegacyChipEntry,
  getEntryObservationChips,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Emergency chip-loading fix — the REAL save cycle in a REAL browser at MOBILE
// width (Chloe's screenshot context), exercising the REAL forms + REAL server
// actions with a DATABASE read-back between every save. Two surfaces:
//
//   * Test A — block-setup-form EDIT (Chloe's reported surface, Gate 7): a legacy
//     entry (chips only in `comments`) preloads its observations as SELECTED
//     controls; add a 4th → save → reload → still selected; remove one → save →
//     reload → correct final set. DB is the ground truth after each save.
//   * Test B — SimplifiedEntryForm CREATE ("Add pass", Gate 2): select 3 chips →
//     save → exactly those three persist (no dupes) → reload → pills render;
//     a second pass with a select-then-deselect proves deselection + no dupes.
//
// Navigation is deterministic: one seeded draft session + one seeded block, direct
// route, STABLE data-testids for the Edit / Add-pass triggers, the chip toggles,
// and the save buttons (no ordinal/text selectors, no arbitrary sleeps — the DB
// poll + the form's own open/close transition are the synchronization signals).

const A = "Coarse hair";
const B = "Slight edema";
const C = "Lots of anagen";
const D = "Erythema";
const MOBILE = { width: 390, height: 844 };
const T = 20_000;

// A chip toggle carries a stable testid regardless of its selected/"+ " label.
function chip(scope: Page | Locator, label: string): Locator {
  return scope.getByTestId(`obs-chip-${label}`);
}

function sortedKey(values: string[]): string {
  return [...values].sort().join("|");
}

async function pollStoredChips(
  sessionId: string,
  which: "first" | "last",
  expected: string[],
): Promise<void> {
  await expect
    .poll(async () => sortedKey(await getEntryObservationChips(sessionId, which)), {
      timeout: T,
    })
    .toBe(sortedKey(expected));
  // No duplicates in the raw stored array.
  const stored = await getEntryObservationChips(sessionId, which);
  expect(new Set(stored).size).toBe(stored.length);
}

test("block-setup-form EDIT: legacy chips preload SELECTED; add + remove persist across reloads (mobile)", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE);
  const seed = await seedE2eStudio();
  const { clientId, sessionId, blockId } =
    await seedE2eDraftSessionWithLegacyChipEntry(
      seed,
      // Chips A/B/C live in the LEGACY comments; "tender near jaw" is free text.
      `${A}, ${B}, tender near jaw, ${C}`,
    );
  await loginAsOwner(page, seed);

  const openEditor = async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId(`edit-area-${blockId}`).click();
    // The chip toggles only render once the editor has mounted.
    await expect(chip(page, A)).toBeVisible({ timeout: T });
  };
  const save = async () => {
    await page.getByTestId("save-treatment-area").click();
    // On success the editor closes → the Edit trigger reappears.
    await expect(page.getByTestId(`edit-area-${blockId}`)).toBeVisible({ timeout: T });
  };

  await test.step("open editor → the 3 legacy chips preload as SELECTED; free text preserved", async () => {
    await openEditor();
    for (const c of [A, B, C]) {
      await expect(chip(page, c)).toHaveAttribute("aria-pressed", "true", { timeout: T });
    }
    // The non-chip token stays in the free-text note (not double-shown as a chip).
    await expect(page.getByPlaceholder("Add a note (optional)")).toHaveValue(/tender near jaw/);
  });

  await test.step("save (migrates comments→observation_chips) → DB holds exactly A,B,C", async () => {
    await save();
    await pollStoredChips(sessionId, "first", [A, B, C]);
  });

  await test.step("reload → reopen → all three still selected (now from the structured column)", async () => {
    await openEditor();
    for (const c of [A, B, C]) {
      await expect(chip(page, c)).toHaveAttribute("aria-pressed", "true", { timeout: T });
    }
  });

  await test.step("add a 4th chip → save → DB holds all four", async () => {
    await chip(page, D).click();
    await expect(chip(page, D)).toHaveAttribute("aria-pressed", "true");
    await save();
    await pollStoredChips(sessionId, "first", [A, B, C, D]);
  });

  await test.step("reload → reopen → all four selected", async () => {
    await openEditor();
    for (const c of [A, B, C, D]) {
      await expect(chip(page, c)).toHaveAttribute("aria-pressed", "true", { timeout: T });
    }
  });

  await test.step("deselect one → save → only that one is removed; others remain, no dupes", async () => {
    await chip(page, D).click(); // D is selected → this deselects it
    await expect(chip(page, D)).toHaveAttribute("aria-pressed", "false");
    await save();
    await pollStoredChips(sessionId, "first", [A, B, C]);
  });

  await test.step("reload again → final state is exactly A,B,C selected; D not", async () => {
    await openEditor();
    for (const c of [A, B, C]) {
      await expect(chip(page, c)).toHaveAttribute("aria-pressed", "true", { timeout: T });
    }
    await expect(chip(page, D)).toHaveAttribute("aria-pressed", "false");
  });
});

test("SimplifiedEntryForm CREATE: select 3 → persist (no dupes); reload shows pills; deselect honored (mobile)", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE);
  const seed = await seedE2eStudio();
  // The seeded block already exists; SimplifiedEntryForm is the "Add pass"
  // surface inside it. The seed's first entry has no chips (plain note).
  const { clientId, sessionId, blockId } =
    await seedE2eDraftSessionWithLegacyChipEntry(seed, "existing note");
  await loginAsOwner(page, seed);

  const openAddPass = async () => {
    await page.getByTestId(`add-pass-${blockId}`).click();
    return page.getByTestId("add-pass-form");
  };

  await test.step("add a pass with 3 chips → exactly those three persist (no dupes)", async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    const form = await openAddPass();
    await form.getByRole("button", { name: "Chin", exact: true }).first().click(); // required area
    for (const c of [A, B, C]) {
      await chip(form, c).click();
      await expect(chip(form, c)).toHaveAttribute("aria-pressed", "true");
    }
    await form.getByTestId("add-pass-submit").click();
    await pollStoredChips(sessionId, "last", [A, B, C]);
  });

  await test.step("reload → the created pass renders its three observation pills", async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    for (const c of [A, B, C]) {
      await expect(page.getByText(c, { exact: true }).first()).toBeVisible({ timeout: T });
    }
  });

  await test.step("second pass: select A, deselect A, select B → only B persists (deselection + no dupes)", async () => {
    const form = await openAddPass();
    await form.getByRole("button", { name: "Chin", exact: true }).first().click();
    await chip(form, A).click(); // select A
    await chip(form, A).click(); // deselect A
    await expect(chip(form, A)).toHaveAttribute("aria-pressed", "false");
    await chip(form, B).click(); // select B
    await form.getByTestId("add-pass-submit").click();
    await pollStoredChips(sessionId, "last", [B]);
  });
});
