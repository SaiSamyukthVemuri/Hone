import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { copySourceMatchesMachine } from "@/lib/machines/pending-setup";

// Codex, #1369 4478497428 (P1) and 4478497436 (P2).
const native = { studio_machine_id: "m1" };
const legacy = { studio_machine_id: null };

describe("copy settings never crosses machine kinds", () => {
  it("native selected: a native source copies, a legacy source is refused", () => {
    expect(copySourceMatchesMachine("native", native)).toBe(true);
    expect(copySourceMatchesMachine("native", legacy)).toBe(false);
  });
  it("legacy selected: a legacy source copies, a native source is refused", () => {
    expect(copySourceMatchesMachine("legacy", legacy)).toBe(true);
    expect(copySourceMatchesMachine("legacy", native)).toBe(false);
  });
  it("no machine chosen yet takes either", () => {
    expect(copySourceMatchesMachine("none", native)).toBe(true);
    expect(copySourceMatchesMachine("none", legacy)).toBe(true);
  });
});

const form = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx", "utf8");
const copyBody = form.slice(form.indexOf("function copySettings()"), form.indexOf("EVERY GATE THAT HOLDS THE SAVE"));
describe("the form's copy path", () => {
  it("refuses before touching the draft, and blanks hidden legacy fields under a native machine", () => {
    expect(copyBody.indexOf("copySourceMatchesMachine(machineKind, source)")).toBeGreaterThan(-1);
    expect(copyBody.indexOf("copySourceMatchesMachine")).toBeLessThan(copyBody.indexOf("setDraft("));
    expect(copyBody).toMatch(/machineKind === "native" \? legacyBlank/);
  });
  it("NEGATIVE CONTROL: the slice really is the copy function", () => {
    expect(copyBody).toContain("buildTreatmentSetupDraftPatch(source");
  });
});

describe("a valid client-last machine wins over an unavailable remembered preference", () => {
  const conn = readFileSync("components/machines/machine-first-setup-connected.tsx", "utf8");
  it("the unavailable-selection notice is dropped when client-last was applied", () => {
    expect(conn).toContain("unavailableSelection={newAreaLast ? null : ctx.rememberedUnavailable}");
  });
});
