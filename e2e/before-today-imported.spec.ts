import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { seedE2eStudio, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// PR #259: imported treatment memory surfaced in Before Today, proven end to
// end on the real local stack. An owner opens a client who has imported
// history, that history appears in the Before Today briefing, clearly
// labelled and NOT charted live in Hone.
//
// IMPORT-01: the fixture used to be a real Quick Import driven through the UI
// as an ordinary owner. Self-service execution is now operator-assisted, so
// that path no longer exists for this seed's owner. The imported rows are
// seeded directly instead, which is what this spec always actually needed.
// It is a DISPLAY test: what it proves is that imported memory reaches Before
// Today correctly labelled, not that the importer works. Seeding through the
// same tables the importer writes keeps the assertions identical, and drops a
// cross-feature coupling that made a display regression look like an import
// regression.

test.describe("imported memory in Before Today", () => {
  test("imported history appears in Before Today, labelled not-charted-live", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const runId = randomUUID().slice(0, 8);
    const clientName = `Maya BT ${runId}`;

    // The exact row shape confirmImportAction writes: one batch, one client,
    // one imported_treatment_memories row linked to both.
    const batchId = randomUUID();
    const clientId = randomUUID();
    await sql(
      `insert into public.import_batches
         (id, studio_id, source_type, source_label, row_count, completed_at)
       values ($1, $2, 'paper_card', 'CSV/TSV import', 1, now())`,
      [batchId, seed.studioId],
    );
    await sql(
      `insert into public.clients (id, studio_id, name, email)
       values ($1, $2, $3, $4)`,
      [clientId, seed.studioId, clientName, `maya-bt-${runId}@example.com`],
    );
    await sql(
      `insert into public.imported_treatment_memories
         (studio_id, client_id, import_batch_id, source_type,
          treatment_area_text, occurred_on, probe_lot, tolerance_text,
          reaction_text, caution_note, source_row_number)
       values ($1, $2, $3, 'paper_card', 'Upper lip', '2024-11-02', 'L-204',
               '4/5', 'Mild redness', 'Lower energy next time', 1)`,
      [seed.studioId, clientId, batchId],
    );

    await loginAsOwner(page, seed);

    // The seeded client is a real, listed client...
    await page.goto("/clients");
    await expect(page.getByText(clientName).first()).toBeVisible({
      timeout: 20_000,
    });
    // ...and its profile is where Before Today renders.
    await page.goto(`/clients/${clientId}`);

    // The Before Today briefing surfaces the imported history, labelled.
    await expect(page.getByText("Imported treatment memory")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/not charted live in Hone/i)).toBeVisible();
    await expect(page.getByText("Imported from paper card")).toBeVisible();
    await expect(page.getByText("Upper lip").first()).toBeVisible();
    await expect(page.getByText("Lot L-204")).toBeVisible();

    // No horizontal overflow at desktop width.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
