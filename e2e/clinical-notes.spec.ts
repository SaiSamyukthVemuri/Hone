import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eClient,
  getClinicalNoteCount,
  getLatestClinicalNoteBody,
  seedLegacyClientSkinNotes,
  seedConfirmedAppointment,
  getOwnerPractitionerId,
  getE2eServiceId,
  sql,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// ===========================================================================
// Willow PR A, dedicated consultation + skin/hair analysis clinical notes
// (migration 0126). Real browser, real stack, iPhone-class viewport (the
// practitioner works on an iPad/phone). One serial logged-in flow that drives
// the actual UI -> server action -> RLS-scoped write -> read-back-verify path,
// with DB ground-truth assertions after each write.
//
// Covers: add a consultation note; add a skin/hair note with area tags; revise
// the consultation note (append-only, a new dated revision, original kept in
// history); the print/export view; and the read-only overview summary. No auth
// bypass; disposable local DB; unique per-run seed.
// ===========================================================================

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

test("consultation + skin/hair notes: add, revise (append-only), export, on mobile", async ({
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
    // stays present alongside the revision (append-only, nothing overwritten).
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

  // -------------------------------------------------------------------------
  // REACHABILITY FROM THE APPOINTMENT. The notes above already worked; Chloe
  // could not find them from the visit she was about to run. Reuses the notes
  // this test just wrote through the real UI, so the assertions are about
  // genuine records rather than fixtures.
  // -------------------------------------------------------------------------
  await test.step("the appointment surfaces both notes and links to the tab", async () => {
    const practitionerId = await getOwnerPractitionerId(seed.studioId);
    const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const appointmentId = await seedConfirmedAppointment(
      seed.studioId,
      practitionerId,
      clientId,
      start.toISOString(),
      end.toISOString(),
    );
    // The harness studio offers consultation services, so attaching the
    // service is what makes this a CONSULTATION appointment.
    await sql(`update public.appointments set service_id = $2 where id = $1`, [
      appointmentId,
      await getE2eServiceId(seed.studioId),
    ]);

    await page.goto(`/calendar/${appointmentId}`);
    const card = page.getByTestId("appointment-consultation-notes");
    await expect(card).toBeVisible({ timeout: 20_000 });
    // Pre-visit context: the CURRENT text of each kind, not the superseded one.
    await expect(card).toContainText(revisedBody);
    await expect(card).toContainText(skinBody);
    await expect(card).not.toContainText(consultBody);

    // BOTH affordances coexist on a consultation appointment. A consultation
    // may include a short electrolysis test treatment, so the notes CTA has to
    // ADD to this surface rather than replace charting. Asserted through the
    // shipping accessible name and the real href, so it cannot pass on a
    // lookalike: the link must point at THIS appointment's charting route.
    // (The earlier version of this assertion re-checked the notes card by
    // mistake and therefore proved nothing about charting at all.)
    const chartLink = page.getByRole("link", { name: "+ Chart session" });
    await expect(chartLink).toBeVisible();
    await expect(chartLink).toHaveAttribute(
      "href",
      new RegExp(
        `/clients/${clientId}/sessions/new\\?appointment_id=${appointmentId}`,
      ),
    );

    // The primary CTA lands on the EXISTING tab, whose deep link is unchanged.
    const cta = page.getByTestId("appointment-record-consultation-notes");
    await expect(cta).toBeVisible();
    await expect(cta).toHaveText("Record consultation notes");
    const box = await cta.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await cta.click();
    await expect(page).toHaveURL(new RegExp(`/clients/${clientId}\\?tab=consultation`));
    // ...and that tab now says what it holds. This journey runs at MOBILE
    // width, where the profile tabs are a <select> rather than the desktop
    // <button> row, so assert the option, not a button. Scoped to the profile
    // nav by its accessible name (the same handle mobile-ux.spec.ts uses) so
    // this cannot silently start matching some other select on the page.
    await expect(
      page
        .getByRole("navigation", { name: "Client profile sections" })
        .locator("select"),
    ).toContainText("Consultation & Skin/Hair");
  });
});

// ===========================================================================
// Chloe Session 1A, legacy `clients.skin_notes` is RETIRED as an editor, and
// the append-only skin/hair record is the canonical path.
// ===========================================================================
//
// Drives the real UI: historical legacy text must still be visible (labelled as
// legacy, read-only), the ordinary client edit form must offer no editable
// legacy field, and the canonical "Add skin & hair analysis" action must lead to
// the append-only record, which then outranks the legacy text.
test("legacy skin notes are read-only and the canonical record outranks them", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const legacyText = `LEGACY skin text ${seed.runId}`;
  const canonicalBody = `Canonical skin/hair analysis ${seed.runId}`;

  await seedLegacyClientSkinNotes(clientId, legacyText);
  await loginAsOwner(page, seed);

  // 1-2. The legacy value is visible on the profile, under a LEGACY heading.
  await page.goto(`/clients/${clientId}`);
  await expect(page.getByText("Legacy skin notes")).toBeVisible();
  await expect(page.getByText(legacyText)).toBeVisible();
  // It is prose, not a form control, nothing on this page can edit it.
  await expect(page.locator(`textarea:has-text("${legacyText}")`)).toHaveCount(0);

  // 2b. The helper copy must describe where the canonical form ACTUALLY is.
  //     It used to say the append-only section was "below", it is not on this
  //     tab at all; it lives behind Consultation. A practitioner reading that
  //     scrolls, finds nothing, and edits the legacy text instead, which is the
  //     precise behaviour this retirement exists to stop. Pinned in the browser
  //     because that is the only layer that sees what is really on the page.
  const helper = page.getByText(/Historical profile text, kept for reference/i);
  await expect(helper).toBeVisible();
  await expect(helper).toContainText(/Consultation tab/i);
  await expect(helper).not.toContainText(/\bbelow\b/i);
  // ...and the destination it names is genuinely absent from this tab, which is
  // what made "below" false. (Anti-vacuity for the assertion above: if the form
  // were in fact here, pinning "Consultation tab" would be the untrue copy.)
  await expect(
    page.getByPlaceholder(/hair type|growth pattern|area-specific/i),
  ).toHaveCount(0);

  // 3. Ordinary client editing offers NO editable legacy field.
  await page.goto(`/clients/${clientId}/edit`);
  await expect(page.getByText("Skin notes", { exact: true })).toHaveCount(0);
  await expect(page.locator('textarea[name="skin_notes"]')).toHaveCount(0);
  // The form still works for the fields it does own.
  await expect(page.getByText("Allergies")).toBeVisible();

  // 4. The canonical action is reachable from the profile and leads to the
  //    append-only clinical-notes surface.
  await page.goto(`/clients/${clientId}`);
  const canonical = page.getByRole("link", { name: /add skin & hair analysis/i });
  await expect(canonical).toBeVisible();
  await canonical.click();
  await expect(page).toHaveURL(/tab=consultation/);

  // 5. Add a real skin/hair analysis note through the canonical flow.
  const before = await getClinicalNoteCount(clientId, "skin_hair_analysis");
  // Same real-UI interaction the suite above uses: the SECOND "Add note" button
  // belongs to the Skin & hair card.
  await page.getByRole("button", { name: /add note/i }).nth(1).click();
  await page
    .getByPlaceholder(/hair type|growth pattern|area-specific/i)
    .fill(canonicalBody);
  await page.getByRole("button", { name: /save note/i }).click();
  await expect(page.getByText(canonicalBody)).toBeVisible({ timeout: 20_000 });

  // 6. Reload: the append-only note persisted; the legacy text is untouched.
  await page.reload();
  await expect(page.getByText(canonicalBody)).toBeVisible();
  expect(await getClinicalNoteCount(clientId, "skin_hair_analysis")).toBe(
    before + 1,
  );
  expect(await getLatestClinicalNoteBody(clientId, "skin_hair_analysis")).toBe(
    canonicalBody,
  );

  // The legacy text survived the whole flow, nothing overwrote or copied it.
  await page.goto(`/clients/${clientId}`);
  await expect(page.getByText(legacyText)).toBeVisible();
});
