import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Privacy condition P2 (PEER-1299-EARLY): no studio aggregate may be serialized
// into a page through a client component's props. Every 'use client' file in the
// dashboard may receive prepared view data, never the metrics object or its
// fields. P3: the procedure roll-up is a STUDIO count visible to every role and
// must not be described as personal or private.

const DIR = "app/(app)/dashboard";
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.(tsx?)$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}
const clientFiles = walk(DIR).filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));

describe("P2: no metrics object crosses a client boundary", () => {
  it("finds the client components (anti-vacuity)", () => {
    expect(clientFiles.length).toBeGreaterThan(3);
    expect(clientFiles.some((f) => f.endsWith("needs-attention-panel.tsx"))).toBe(true);
  });

  for (const f of clientFiles) {
    it(`${f} takes no metrics, money, appointment-count or charted-within-24h prop`, () => {
      const code = readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => !/^\s*\/\//.test(l))
        .join("\n");
      expect(code).not.toMatch(/practiceMetrics|PracticeDashboardMetrics|chartedWithin24h|bookedValueCents|completedValueCents|testPayments/);
    });
  }

  it("the page and stack never pass a metrics value to a client component", () => {
    const stack = readFileSync(join(DIR, "secondary-stack.tsx"), "utf8");
    // The only client component the stack renders with data is the panel; it
    // receives `needs`, built by the pure model.
    expect(stack).toMatch(/<NeedsAttentionPanel\s+needs=\{buildNeedsAttention\(/);
  });
});

describe("P3: the records roll-up is not described as personal or private", () => {
  it("its copy says the studio's sessions", () => {
    const model = readFileSync("lib/dashboard/todo-model.ts", "utf8");
    expect(model).toContain("Across the studio's ${input.metrics.reviewedSessions} most recent charted sessions.");
    expect(model).not.toMatch(/Across your/);
  });
});
