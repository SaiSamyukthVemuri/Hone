import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #204: charting field order follows Chloe's actual treatment flow.
// Layout only: no schema or save-action change.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const FORM = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
);

describe("charting field order (Chloe's exact flow)", () => {
  it("Area -> Frequency -> Probe -> Mode -> Modality -> Readings -> Hairs -> Minutes", () => {
    const anchors = [
      // Migration 0128: the single-area section is now the multi-area editor,
      // still first (areas treated with these settings), before machine settings.
      "<MultiAreaEditor",
      '>Machine frequency</span>',
      '>Probe</span>',
      '>Mode</span>',
      '>Modality</span>',
      '>Treatment readings</span>',
      '>Hairs treated</span>',
      '>Minutes performed (optional)</span>',
    ];
    let prev = -1;
    for (const anchor of anchors) {
      const idx = FORM.indexOf(anchor);
      expect(idx, anchor).toBeGreaterThan(prev);
      prev = idx;
    }
  });
});
