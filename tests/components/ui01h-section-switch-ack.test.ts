import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// UI-01H-A — section-switch tap acknowledgement.
//
// A <Link> click starts a React transition that keeps the OLD page mounted,
// fully painted and fully interactive, until the RSC payload arrives. Nothing
// on screen says the tap registered, so on a tablet the practitioner taps
// again. Nine `aria-current` section-switch rows exist; three already
// acknowledge. These five did not.
//
// The primitive itself is proved in tests/components/pending-link.test.ts.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const FILES = [
  "app/(app)/clients/page.tsx",
  "app/(app)/records/page.tsx",
  "app/(app)/dashboard/practice-snapshot.tsx",
  "app/(app)/settings/availability/ScopeSelector.tsx",
  "components/settings/settings-shell.tsx",
];

describe("UI-01H-A: every section-switch row acknowledges the tap", () => {
  it("no aria-current row in these files is still a bare <Link>", () => {
    // The regression this guards: converting the opening tag but leaving a
    // sibling row behind, which would acknowledge inconsistently within one nav.
    for (const file of FILES) {
      const src = read(file);
      const bare = [...src.matchAll(/<Link\b[\s\S]{0,400}?aria-current/g)];
      expect(bare.map(() => file), `${file} has a bare <Link> on an aria-current row`).toEqual([]);
    }
  });

  it("aria-current survives on every row — the semantics were already correct", () => {
    for (const file of FILES) {
      expect(read(file)).toMatch(/aria-current=\{/);
    }
  });
});
