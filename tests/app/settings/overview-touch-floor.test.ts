import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The Settings overview shortcuts and the category headings are links a thumb must hit. They use the shared touch
// floor (44px) and relax to 40px only where the pointer is precise, the same convention as the Settings shell.
// The measured proof is the touch-target e2e; this pins the class convention so a bare min-h-10 cannot return.
describe("Settings overview touch floor", () => {
  const src = readFileSync("app/(app)/settings/page.tsx", "utf8");
  it("the directory shortcuts and category headings use CONTROL_MIN_TOUCH with the fine-pointer relaxation", () => {
    const uses = src.match(/cx\(CONTROL_MIN_TOUCH, "pointer-fine:min-h-10/g) ?? [];
    expect(uses.length).toBe(2);
  });
  it("no overview link keeps a bare min-h-10", () => {
    expect(src).not.toMatch(/(?<!pointer-fine:)min-h-10/);
  });
});
