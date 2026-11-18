import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Header navigation: named landmarks and the owner-only Business entry.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const LAYOUT = read("app/(app)/layout.tsx");

// THE BREAKPOINT CONTRACT — compact shell below 1024px, full desktop from
// 1024px — is pinned ONCE, in tests/app/mobile-ux.test.ts ("EVERY header-mode
// class switches at lg"). It is deliberately not restated here: a pin copied
// into a second file is how this repository previously ended up sweeping 18
// files for one change. The browser proof of the same contract, width by
// width, is the matrix in e2e/owner-practice-capacity.spec.ts.
describe("header navigation", () => {
  it("the two nav landmarks are individually named", () => {
    // Two <nav> elements exist in the authenticated shell. Unlabelled, a screen
    // reader announces "navigation" twice with nothing to tell them apart; it
    // is also what let a browser test bind to a nav by DOM position rather than
    // by which navigation it actually is.
    expect(LAYOUT).toMatch(/aria-label="Primary navigation"/);
    expect(read("app/(app)/MobileMenu.tsx")).toMatch(
      /aria-label="Mobile navigation"/,
    );
  });

  it("Business is an OWNER-ONLY nav entry on both breakpoints, to /dashboard/capacity", () => {
    // OWNER-CAP follow-up. The browser spec proves what an owner and a
    // practitioner each actually SEE; this is the cheap source-level pin that
    // the entry is role-gated at all, on both surfaces, and points at the one
    // route that exists — there is no /business hub.
    const MOBILE = read("app/(app)/MobileMenu.tsx");
    // NAV-ACK-02: same repair as the Records item above — the gate and the
    // destination are the properties, not the element's tag name or the
    // distance between its href and its label.
    const gated = LAYOUT.match(
      /\{practitioner\.role === "owner" && \(\s*<(\w+)[^>]*href="\/dashboard\/capacity"[^>]*>([\s\S]*?)<\/\1>/,
    );
    expect(gated).not.toBeNull();
    expect(gated![2].trim()).toBe("Business");
    expect(MOBILE).toMatch(
      /role === "owner"\s*\?\s*\[\{ href: "\/dashboard\/capacity", label: "Business" \}\]/,
    );
    // UNCONDITIONAL would be the defect, so assert the gate is the ONLY way
    // either file mentions the route: exactly one occurrence each, and both
    // inside the role branches pinned above.
    for (const [name, src] of [
      ["layout", LAYOUT],
      ["mobile menu", MOBILE],
    ] as const) {
      expect(
        src.match(/"\/dashboard\/capacity"/g)?.length,
        `${name} must link the owner surface exactly once`,
      ).toBe(1);
    }
    // No /business hub was invented to hold it.
    expect(existsSync(join(process.cwd(), "app/(app)/business"))).toBe(false);
    // ...and the role came from data the shell already had. A second
    // practitioner/role lookup in the layout would be the extra query this
    // change promised not to add.
    expect(LAYOUT.match(/requirePractitionerWithStudio\(\)/g)?.length).toBe(1);
    expect(LAYOUT).not.toMatch(/getCurrentPractitioner\b/);
  });
});
