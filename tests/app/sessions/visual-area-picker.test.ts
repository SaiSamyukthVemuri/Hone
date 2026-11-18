import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #269. Visual treatment-area picker V1 is reuse-only: NO copied Jane
// assets. Source-grep, no DB/network.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PICKER = read("components/area-picker.tsx");
const FORM = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
);

describe("no Jane assets", () => {
  for (const [label, src] of [
    ["area-picker", PICKER],
    ["block-setup-form", FORM],
  ] as const) {
    it(`${label} references no Jane CDN/thumbnail asset URL`, () => {
      expect(src).not.toMatch(/jane\.app/i);
      expect(src).not.toMatch(/\/thumbs\//i);
    });
  }
});
