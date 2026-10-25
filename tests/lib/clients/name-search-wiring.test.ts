import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// HON-58 — every surface that finds a client uses the ONE rule in
// lib/clients/name-search.ts. Before this there were three hand-copied raw
// substring matchers, and a fix to one would silently miss the others.
// The rule itself is proved behaviourally in name-search.test.ts and
// tests/app/search/global-search-client-names.test.ts; this pins the wiring
// of the two client components, which have no interactive render harness.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const SURFACES = [
  "components/client-search.tsx",
  "app/(app)/calendar/QuickBookDrawer.tsx",
  "app/(app)/global-search-actions.ts",
];

describe("client search surfaces share one matcher", () => {
  it.each(SURFACES)("%s imports and calls matchesClientSearch", (rel) => {
    const src = read(rel);
    expect(src).toMatch(/from "@\/lib\/clients\/name-search"/);
    expect(src).toMatch(/matchesClientSearch\(/);
  });

  it.each(SURFACES)("%s no longer hand-rolls a raw name substring match", (rel) => {
    expect(read(rel)).not.toMatch(/\.name \?\? ""\)\.toLowerCase\(\)\.includes\(/);
  });
});
