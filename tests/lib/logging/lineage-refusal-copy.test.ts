import { afterEach, describe, expect, it, vi } from "vitest";
import { LINEAGE_MARKER, userFacingDbFailure } from "@/lib/logging/user-facing-db-failure";

// 0289 chart lineage guard (Insurance condition): the 23514 it raises must reach the person as a plain "not saved" sentence, not as the generic
// "check the values" one, and never carry the database text.
afterEach(() => vi.restoreAllMocks());

describe("the chart lineage refusal (23514 chart_lineage_mismatch)", () => {
  it("says nothing was saved and why, without the database text", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = userFacingDbFailure("add the stage", { code: "23514", message: LINEAGE_MARKER }, "treatment_plan_stage_add_failed");
    expect(out).toBe("Could not add the stage. Nothing was saved, because the change would put the record in a different studio than the one it belongs to.");
    expect(out).not.toContain(LINEAGE_MARKER);
  });
  it("CONTROL: any other 23514 (a failed CHECK) keeps the 'check the values' sentence", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = userFacingDbFailure("add the stage", { code: "23514", message: 'new row violates check constraint "x"' }, "e");
    expect(out).toMatch(/Check the values and try again/);
  });
  it("CONTROL: the marker under another code does not get the sentence", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(userFacingDbFailure("add the stage", { code: "23505", message: LINEAGE_MARKER }, "e")).toMatch(/conflicts with existing records/);
  });
  it("the stage create and update actions answer through it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/(app)/clients/[id]/treatment-plans-actions.ts", "utf8");
    expect(src).toContain('userFacingDbFailure("add the stage", error');
    expect(src).toContain('userFacingDbFailure("update the stage", error');
  });
});
