import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Owner setup guidance is for the owner. The onboarding wizard is already
// owner-gated, but its flag is studio-wide, so before this a staff member on a
// set-up studio fell into the legacy branch and was shown the owner's
// "N of M steps complete" card, and the account and mobile menus offered
// "Getting Started" to everyone. These contracts read the three call sites with
// comments stripped, so a comment cannot satisfy or trip them.
const read = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const MENUS = ["app/(app)/AccountMenu.tsx", "app/(app)/MobileMenu.tsx"];
const ENTRY = /\{\s*href:\s*"\/getting-started",\s*label:\s*"Getting Started"\s*\}/g;

describe("setup guidance is owner-only", () => {
  for (const file of MENUS) {
    it(`${file}: the Getting Started entry exists once and only inside an owner-gated spread`, () => {
      const code = read(file);
      expect(code.match(ENTRY)?.length, "exactly one Getting Started entry").toBe(1);
      expect(code).toMatch(
        /\.\.\.\(\s*role\s*===\s*"owner"\s*\?\s*\[\s*\{\s*href:\s*"\/getting-started",\s*label:\s*"Getting Started"\s*\}\s*\]\s*:\s*\[\s*\]\s*\)/,
      );
    });

    it(`${file}: Settings stays ungated, so an owner keeps the way to setup help and staff keep Settings`, () => {
      // The overview is the first unconditional menu item for both roles.
      expect(read(file)).toMatch(/\{\s*\[\s*\{\s*href:\s*"\/settings",\s*label:\s*"Settings"\s*\}/);
    });
  }

  it("the legacy dashboard setup card renders only for an owner", () => {
    const code = read("app/(app)/dashboard/secondary-stack.tsx");
    expect(code).toMatch(/\{\s*isOwner\s*&&\s*!onboardingV2On\s*&&\s*!setupComplete\s*&&\s*\(/);
    // No second render path for the same card without the owner gate.
    expect(code.match(/steps complete/g)?.length).toBe(1);
    expect(code).not.toMatch(/\{\s*!onboardingV2On\s*&&\s*!setupComplete/);
  });
});
