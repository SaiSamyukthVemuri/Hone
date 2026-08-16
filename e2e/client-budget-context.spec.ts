import { test, expect } from "@playwright/test";
import { seedE2eStudio, seedE2eClient, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// ===========================================================================
// CLIENT BUDGET CONTEXT (migration 0183) — Chloe pilot feedback.
//
// Budget moved OFF treatment plans and ONTO the client, as a peer section on
// the existing Consultation & Skin/Hair tab. Real browser, real stack,
// iPhone-class viewport (the practitioner works on an iPad/phone), driving the
// genuine UI -> server action -> RLS-scoped write path with DB ground-truth
// assertions after each save.
//
// The unit lane proves the action's branches against a fake; this proves the
// rendered card, the chip interaction, and that what the practitioner sees
// after a reload is what the database actually holds.
// ===========================================================================

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

type BudgetRow = { budget_level: string | null; budget_notes: string };

async function budgetRow(clientId: string): Promise<BudgetRow | null> {
  const rows = await sql<BudgetRow>(
    `select budget_level, budget_notes
       from public.client_budget_context where client_id = $1`,
    [clientId],
  );
  return rows[0] ?? null;
}

test("budget context: chips, notes, clearing and reload — on mobile", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const notes = `Saving for chin; prefers fewer, longer visits ${seed.runId}`;

  await test.step("owner logs in via a real magic link", async () => {
    await loginAsOwner(page, seed);
  });

  await test.step("A. an untouched client shows an empty Budget card on the Consultation tab", async () => {
    // The tab query value is unchanged, so existing deep links keep working.
    await page.goto(`/clients/${clientId}?tab=consultation`);

    const budget = page.getByRole("heading", { name: /^budget$/i });
    await expect(budget).toBeVisible({ timeout: 20_000 });

    // A peer of the two clinical sections, on the SAME tab.
    await expect(
      page.getByRole("heading", { name: /consultation notes/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /skin & hair analysis/i }),
    ).toBeVisible();

    await expect(
      page.getByText(/record financial preferences or limits/i),
    ).toBeVisible();

    // Exactly the three approved labels, and no "Unlimited".
    for (const label of [
      "No stated limit",
      "Somewhat limited",
      "Severely limited",
    ]) {
      await expect(page.getByRole("button", { name: label })).toBeVisible();
    }
    await expect(
      page.getByRole("button", { name: /^unlimited$/i }),
    ).toHaveCount(0);

    // Nothing selected yet, and no row in the database.
    for (const label of [
      "No stated limit",
      "Somewhat limited",
      "Severely limited",
    ]) {
      await expect(
        page.getByRole("button", { name: label }),
      ).toHaveAttribute("aria-pressed", "false");
    }
    expect(await budgetRow(clientId)).toBeNull();
  });

  await test.step("M. chips meet the 44px touch target and the page does not overflow 390px", async () => {
    for (const label of [
      "No stated limit",
      "Somewhat limited",
      "Severely limited",
    ]) {
      const box = await page
        .getByRole("button", { name: label })
        .boundingBox();
      expect(box, `${label} must be rendered`).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  await test.step("D. a chip plus notes save together and land in the database", async () => {
    await page.getByRole("button", { name: "Somewhat limited" }).click();
    await expect(
      page.getByRole("button", { name: "Somewhat limited" }),
    ).toHaveAttribute("aria-pressed", "true");

    // Selecting a chip must NOT write boilerplate into the textarea.
    const box = page.getByLabel("Budget notes");
    await expect(box).toHaveValue("");

    await box.fill(notes);
    await page.getByRole("button", { name: /save budget/i }).click();
    await expect(page.getByText("Saved.")).toBeVisible({ timeout: 20_000 });

    expect(await budgetRow(clientId)).toEqual({
      budget_level: "somewhat_limited",
      budget_notes: notes,
    });
  });

  await test.step("saved state reloads exactly as stored", async () => {
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Somewhat limited" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Budget notes")).toHaveValue(notes);
  });

  await test.step("E. switching chips leaves exactly ONE selected", async () => {
    await page.getByRole("button", { name: "Severely limited" }).click();
    await page.getByRole("button", { name: /save budget/i }).click();
    await expect(page.getByText("Saved.")).toBeVisible({ timeout: 20_000 });

    await page.reload();
    await expect(
      page.getByRole("button", { name: "Severely limited" }),
    ).toHaveAttribute("aria-pressed", "true");
    for (const other of ["No stated limit", "Somewhat limited"]) {
      await expect(
        page.getByRole("button", { name: other }),
      ).toHaveAttribute("aria-pressed", "false");
    }
    expect((await budgetRow(clientId))?.budget_level).toBe("severely_limited");
  });

  await test.step("F. clearing the chip leaves the notes intact", async () => {
    await page.getByRole("button", { name: /clear budget level/i }).click();
    await page.getByRole("button", { name: /save budget/i }).click();
    await expect(page.getByText("Saved.")).toBeVisible({ timeout: 20_000 });

    expect(await budgetRow(clientId)).toEqual({
      budget_level: null,
      budget_notes: notes,
    });

    await page.reload();
    await expect(page.getByLabel("Budget notes")).toHaveValue(notes);
    for (const label of [
      "No stated limit",
      "Somewhat limited",
      "Severely limited",
    ]) {
      await expect(
        page.getByRole("button", { name: label }),
      ).toHaveAttribute("aria-pressed", "false");
    }
  });

  await test.step("G. clearing the notes leaves the chip intact", async () => {
    await page.getByRole("button", { name: "No stated limit" }).click();
    await page.getByLabel("Budget notes").fill("");
    await page.getByRole("button", { name: /save budget/i }).click();
    await expect(page.getByText("Saved.")).toBeVisible({ timeout: 20_000 });

    expect(await budgetRow(clientId)).toEqual({
      budget_level: "no_stated_limit",
      budget_notes: "",
    });
  });

  await test.step("the chips are reachable and operable by keyboard", async () => {
    await page.reload();
    const chip = page.getByRole("button", { name: "Severely limited" });
    await chip.focus();
    await expect(chip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(chip).toHaveAttribute("aria-pressed", "true");
  });
});

test("treatment plan: budget is no longer editable there, and legacy notes survive read-only", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const legacy = `Legacy: about $50 a week ${seed.runId}`;

  // A plan written under the OLD contract, with a budget note on it.
  const [{ id: planId }] = await sql<{ id: string }>(
    `insert into public.treatment_plans
       (studio_id, client_id, name, budget_notes, practitioner_notes, status)
     values ($1, $2, $3, $4, $5, 'active') returning id`,
    [
      seed.studioId,
      clientId,
      `Legacy plan ${seed.runId}`,
      legacy,
      `Plan reasoning ${seed.runId}`,
    ],
  );

  await loginAsOwner(page, seed);

  await test.step("J. the legacy note renders, clearly labelled as legacy", async () => {
    // The treatment-plans tab value is `treatment`, not `plans`.
    await page.goto(`/clients/${clientId}?tab=treatment`);
    await expect(page.getByText(/legacy plan budget note/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(legacy)).toBeVisible();
    await expect(
      page.getByText(/current budget lives under consultation/i),
    ).toBeVisible();
  });

  await test.step("I. the plan editor offers no Budget notes control", async () => {
    await page.getByRole("button", { name: "Edit plan" }).first().click();
    // Practitioner notes are still editable — the plan keeps what is its own.
    const practitionerBox = page.getByPlaceholder(/dense terminal hair/i);
    await expect(practitionerBox).toBeVisible();
    // Budget editing is gone from this surface: no label, and no textarea
    // carrying the old placeholder.
    await expect(page.getByText(/client budget notes/i)).toHaveCount(0);
    await expect(page.getByPlaceholder(/unlimited budget/i)).toHaveCount(0);
  });

  await test.step("K. an unrelated plan edit does NOT erase the legacy value", async () => {
    // The data-loss tripwire: budget_notes is absent from the plan writer, so
    // saving an UNRELATED field must leave the legacy column exactly as it
    // was. If the writer still listed the key, the missing form field would
    // resolve to null here and wipe the note.
    await page
      .getByPlaceholder(/dense terminal hair/i)
      .fill(`Edited reasoning ${seed.runId}`);
    await page.getByRole("button", { name: "Save plan" }).click();
    // The editor closes on success, which is the signal the write landed.
    await expect(
      page.getByRole("button", { name: "Edit plan" }).first(),
    ).toBeVisible({ timeout: 20_000 });

    const [row] = await sql<{
      budget_notes: string | null;
      practitioner_notes: string | null;
    }>(
      `select budget_notes, practitioner_notes
         from public.treatment_plans where id = $1`,
      [planId],
    );
    // The unrelated field DID change — proving the save actually happened and
    // this assertion is not vacuous.
    expect(row.practitioner_notes).toBe(`Edited reasoning ${seed.runId}`);
    // And the legacy budget note survived it untouched.
    expect(row.budget_notes).toBe(legacy);
  });

  await test.step("the legacy value was NOT promoted to current client context", async () => {
    const rows = await sql(
      `select 1 from public.client_budget_context where client_id = $1`,
      [clientId],
    );
    expect(rows).toHaveLength(0);
  });
});
