import { describe, expect, it } from "vitest";
import { EXPORT_RESOURCE_REGISTRY, pendingColumns, pendingResources } from "@/lib/export/resource-registry";

// The registry's reasons and column notes are printed on the Data settings page and written into the export's own README and manifest
// (settings/data/page.tsx and actions.ts read `disposition.reason`). They are customer-visible text, so they state the rule and never carry
// a review thread id, a review label or a person's name.
const REVIEW_MARKERS = /\bCodex\b|\bInsurance\b|\bPrivacy [A-Z]|\bOPS\b|\bPhotos R\d|\b\d{10}\b|#1369\b.*\b\d{9,}\b/;

describe("the export registry's customer-visible text carries no review ids", () => {
  it("no reason or column note in the whole registry names a review thread, label or id", () => {
    const strings: Array<[string, string]> = [];
    const walk = (path: string, v: unknown) => {
      if (typeof v === "string") strings.push([path, v]);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(`${path}[${i}]`, x));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(`${path}.${k}`, x);
    };
    walk("registry", EXPORT_RESOURCE_REGISTRY);
    expect(strings.length).toBeGreaterThan(500);
    expect(strings.filter(([, s]) => REVIEW_MARKERS.test(s)).map(([p]) => p)).toEqual([]);
  });

  it("the machine-write receipts entry that was reworded still says what the table is, in the text the page and the export README print", () => {
    const entry = pendingResources().find((r) => r.resource === "block_write_receipts");
    expect(entry, "block_write_receipts stays a pending resource").toBeTruthy();
    const reason = entry!.disposition.reason;
    expect(reason.startsWith("Introduced by migration 0301 (HON-8) so a machine-identity write")).toBe(true);
    expect(reason).toContain("a RECEIPT for a transport");
    expect(reason).toContain("Kept for the life of the block (no pruning).");
    expect(entry!.disposition.ticket).toBe("TRUTH-01B");
    expect(entry!.disposition.tier).toBe(2);
  });

  it("the pending column notes are covered by the same rule", () => {
    expect(pendingColumns().filter((c) => c.note && REVIEW_MARKERS.test(c.note))).toEqual([]);
  });
});
