import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { seedE2eStudio } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// PR #259: imported treatment memory surfaced in Before Today, proven end to
// end on the real local stack. An owner imports a client + history via Quick
// Import (PR #257), then opens that client — the imported history appears in
// the Before Today briefing, clearly labelled and NOT charted live in Hone.

test.describe("imported memory in Before Today", () => {
  test("imported history appears in Before Today, labelled not-charted-live", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);

    // 1) Import one client with a treatment-memory row via Quick Import.
    const runId = randomUUID().slice(0, 8);
    const clientName = `Maya BT ${runId}`;
    const tsv = [
      "client_name\temail\ttreatment_area\tlast_visit_date\tprobe_lot\ttolerance\treaction\tcaution_note",
      `${clientName}\tmaya-bt-${runId}@example.com\tUpper lip\t2024-11-02\tL-204\t4/5\tMild redness\tLower energy next time`,
    ].join("\n");

    await page.goto("/settings/import");
    await page.locator("#import-text").fill(tsv);
    await page.getByRole("button", { name: /preview import/i }).click();
    await expect(page.getByText(clientName).first()).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: /confirm import/i }).click();
    await expect(page.getByText("Import complete")).toBeVisible({
      timeout: 20_000,
    });

    // 2) Open the created client (summary links each created client).
    await page.getByRole("link", { name: clientName }).first().click();
    await page.waitForURL(/\/clients\/[0-9a-f-]+/, { timeout: 20_000 });

    // 3) The Before Today briefing surfaces the imported history, labelled.
    await expect(
      page.getByText("Imported treatment memory"),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText(/not charted live in Hone/i),
    ).toBeVisible();
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
