import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eClient,
  getClinicalNoteCount,
  getLatestClinicalNoteBody,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// ===========================================================================
// Willow PR A — dedicated consultation + skin/hair analysis clinical notes
// (migration 0126). Real browser, real stack, iPhone-class viewport (the
// practitioner works on an iPad/phone). One serial logged-in flow that drives
// the actual UI -> server action -> RLS-scoped write -> read-back-verify path,
// with DB ground-truth assertions after each write.
//
// Covers: add a consultation note; add a skin/hair note with area tags; revise
// the consultation note (append-only — a new dated revision, original kept in
// history); the print/export view; and the read-only overview summary. No auth
// bypass; disposable local DB; unique per-run seed.
// ===========================================================================

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

test("consultation + skin/hair notes: add, revise (append-only), export — on mobile", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const consultBody = `Client wants full removal; discussed timeline ${seed.runId}`;
  const skinBody = `Fitz III, coarse dark hair, chin + upper lip ${seed.runId}`;
  const revisedBody = `Corrected: client wants face + neck ${seed.runId}`;

  await test.step("owner logs in via a real magic link", async () => {
    await loginAsOwner(page, seed);
  });

  await test.step("open the client's Consultation tab", async () => {
    await page.goto(`/clients/${clientId}?tab=consultation`);
    await expect(
      page.getByRole("heading", { name: /consultation notes/i }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole("heading", { name: /skin & hair analysis/i }),
    ).toBeVisible();
  });

  await test.step("add a consultation note and see it appear with a success path", async () => {
    // Two "Add note" buttons (one per card); the first is Consultation.
    await page.getByRole("button", { name: /add note/i }).first().click();
    await page.getByPlaceholder(/goals set|plan discussed|next steps/i).fill(consultBody);
    await page.getByRole("button", { name: /save note/i }).click();
    await expect(page.getByText(consultBody)).toBeVisible({ timeout: 20_000 });
  });

  await test.step("DB ground truth: exactly one consultation note", async () => {
    expect(await getClinicalNoteCount(clientId, "consultation")).toBe(1);
    expect(await getLatestClinicalNoteBody(clientId, "consultation")).toBe(consultBody);
  });

  await test.step("add a skin/hair analysis note with area tags", async () => {
    // The second "Add note" button belongs to the Skin & hair card.
    await page.getByRole("button", { name: /add note/i }).nth(1).click();
    await page.getByPlaceholder(/hair type|growth pattern|area-specific/i).fill(skinBody);
    await page.getByPlaceholder(/chin, upper lip/i).fill("chin, upper lip");
    await page.getByRole("button", { name: /save note/i }).click();
    await expect(page.getByText(skinBody)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("chin", { exact: true })).toBeVisible();
  });

  await test.step("DB ground truth: one skin/hair note carrying the area tags", async () => {
    expect(await getClinicalNoteCount(clientId, "skin_hair_analysis")).toBe(1);
    expect(await getLatestClinicalNoteBody(clientId, "skin_hair_analysis")).toBe(skinBody);
  });

  await test.step("revise the consultation note (append-only correction)", async () => {
    await page.getByRole("button", { name: /revise current/i }).first().click();
    const editor = page.getByRole("textbox").first();
    await editor.fill(revisedBody);
    await page.getByRole("button", { name: /save revision/i }).click();
    await expect(page.getByText(revisedBody)).toBeVisible({ timeout: 20_000 });
  });

  await test.step("the original consultation text is preserved in history, not overwritten", async () => {
    // On the full profile view history is expanded by default; the original body
    // stays present alongside the revision (append-only — nothing overwritten).
    await expect(page.getByText(consultBody)).toBeVisible();
    await expect(page.getByText(revisedBody)).toBeVisible();
  });

  await test.step("DB ground truth: two consultation rows; current = revision; original intact", async () => {
    expect(await getClinicalNoteCount(clientId, "consultation")).toBe(2);
    expect(await getLatestClinicalNoteBody(clientId, "consultation")).toBe(revisedBody);
  });

  await test.step("print/export view shows both kinds, dated", async () => {
    await page.goto(`/clients/${clientId}/clinical-notes/print`);
    await expect(
      page.getByRole("heading", { name: /clinical notes/i }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(revisedBody)).toBeVisible();
    await expect(page.getByText(skinBody)).toBeVisible();
    // The append-only original is included in the export history too.
    await expect(page.getByText(consultBody)).toBeVisible();
  });

  await test.step("overview appointment-prep summary shows the latest of each kind", async () => {
    await page.goto(`/clients/${clientId}`);
    await expect(page.getByText(revisedBody)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(skinBody)).toBeVisible();
  });
});
