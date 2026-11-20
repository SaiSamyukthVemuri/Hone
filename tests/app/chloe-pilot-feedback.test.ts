import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #238: Chloe pilot feedback. The search-input iOS zoom fix must never be
// replaced by a viewport zoom lock.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("mobile search: no viewport zoom lock", () => {
  it("no viewport zoom-disabling hacks anywhere", () => {
    for (const rel of ["app/layout.tsx", "app/(app)/GlobalSearch.tsx"]) {
      const src = read(rel);
      expect(src).not.toMatch(/user-scalable|maximum-scale/i);
    }
  });
});
