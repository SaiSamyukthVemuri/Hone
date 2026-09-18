import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Relative + @ts-expect-error, matching tests/ci/browser-selection.test.ts,
// which is the repo's established convention for these .mjs utilities.
//
// Worth recording: vitest resolved the `@/` alias form happily and ran 15 green
// tests, while `tsc` rejected it (TS7016). A passing test run is not evidence
// the typecheck gate passes — two different resolvers, two different answers.
// @ts-expect-error - .mjs utilities ship without type declarations
import { selectBrowserGroups, specsForGroups } from "../../scripts/browser-groups.mjs";

// UI-06 — systemic visual noise on the dashboard memory family.
//
// THE DESIGN PROBLEM, measured rather than asserted: these three cards each
// hand-rolled the SAME four surface treatments — a neutral chip, the outer
// card, a blue callout, and a bordered row box. That is why the page did not
// read as one design team: it was not one vocabulary, it was three copies of
// four. On top of that the row boxes nested to JSX depth 4 (a white card, in a
// coloured callout, in a card, in a card) and carried no information the list
// did not already give.
//
// These assertions pin the SYSTEMIC properties, not counts for their own sake:
// one label vocabulary, one neutral border token, one row treatment, and no
// re-introduction of the nesting.

const FILES = [
  "components/before-today-card.tsx",
  "components/last-treatment-memory-card.tsx",
  "components/appointment-prep-memory-card.tsx",
] as const;

const read = (p: string) => readFileSync(p, "utf8");
const code = (p: string) =>
  read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Boxed containers and the JSX depth each sits at. */
function boxes(src: string): number[] {
  let depth = 0;
  const out: number[] = [];
  for (const line of src.split("\n")) {
    if (/\brounded(-[a-z]+)?\b[^"]*\bborder\b/.test(line)) out.push(depth);
    depth +=
      (line.match(/<(section|div|ul|li)\b/g) ?? []).length -
      (line.match(/<\/(section|div|ul|li)>/g) ?? []).length;
  }
  return out;
}

describe("UI-06: one label vocabulary across the memory family", () => {
  it("no file declares its own SectionLabel any more", () => {
    // section-label.tsx's docblock names these three files by path as the
    // duplication it exists to replace. They were never migrated.
    for (const f of FILES) {
      expect(code(f), `${f} still declares a private label`).not.toMatch(
        /function SectionLabel\s*\(/,
      );
      expect(code(f), `${f} must import the primitive`).toContain(
        'from "@/components/ui/section-label"',
      );
    }
  });

  it("the blue callout uses the shared label, not a fourth spelling", () => {
    // It was `text-xs font-semibold uppercase tracking-wider text-blue-800` —
    // a fourth vocabulary beside the primitive's own. tone="inherit" keeps the
    // blue while the primitive owns the shape.
    for (const f of FILES) {
      const src = code(f);
      expect(src).not.toMatch(
        /text-xs font-semibold uppercase tracking-wider text-blue-800/,
      );
    }
    const withCallout = FILES.filter((f) => code(f).includes("text-blue-800"));
    expect(withCallout.length).toBeGreaterThan(0);
    for (const f of withCallout) {
      expect(code(f), `${f} tints via the primitive`).toMatch(
        /<SectionLabel[^>]*tone="inherit"[^>]*className="text-blue-800/s,
      );
    }
  });
});

describe("UI-06: one neutral surface vocabulary", () => {
  it("neutral borders are tokens, so no dark: pair is hand-maintained", () => {
    // 4 shades and 28 declarations became the `line` token, which carries its
    // own dark value. The remaining neutral utilities are foreground text,
    // which this slice does not claim to have migrated.
    for (const f of FILES) {
      const src = code(f);
      expect(src, `${f} must not hand-roll a neutral border`).not.toMatch(
        /\bborder-neutral-(200|300)\b/,
      );
      expect(src, `${f} must not pair it by hand`).not.toMatch(
        /dark:border-neutral-(700|800)\b/,
      );
    }
  });

  it("the outer card and chip use the token, not a literal shade", () => {
    for (const f of FILES) {
      const src = code(f);
      if (src.includes("rounded-lg border")) {
        expect(src, `${f} outer card`).toMatch(/rounded-lg border border-line/);
      }
      if (src.includes("rounded-full border")) {
        expect(src, `${f} chip`).toMatch(/rounded-full border border-line/);
      }
    }
  });
});

describe("UI-06: the nesting is gone and scanning is preserved", () => {
  it("no boxed container sits deeper than JSX depth 3", () => {
    // Depth 4 was a white card, inside a coloured callout, inside a card,
    // inside a card. The surviving depth-2/3 boxes are the blue and amber
    // SEMANTIC callouts, whose colour is load-bearing — the amber one exists
    // precisely so imported history is never read as live Hone charting.
    for (const f of FILES) {
      const depths = boxes(code(f));
      const deepest = depths.length ? Math.max(...depths) : 0;
      expect(deepest, `${f} has a box at depth ${deepest}`).toBeLessThanOrEqual(3);
    }
  });

  it("flattened rows keep a divider — flattening must not cost scanning", () => {
    // Removing a per-row box without replacing the separation would make the
    // list run together. The divider is what preserves scanning, and it is
    // tokened so it needs no dark: pair.
    for (const f of FILES) {
      const src = code(f);
      if (/className="py-2\.5( first:pt-1)?"/.test(src)) {
        expect(src, `${f} flattened rows need a divider`).toMatch(
          /divide-y divide-line/,
        );
      }
    }
  });

  it("no per-row bordered box returns", () => {
    for (const f of FILES) {
      expect(code(f), `${f} re-introduced a row box`).not.toMatch(
        /rounded-md border border-neutral-200[^"]*px-3 py-2/,
      );
    }
  });
});

describe("UI-06: measured against the real previous source", () => {
  it("strictly fewer boxes and shallower nesting than the base", (ctx) => {
    // Compared against git rather than a restated count, so the claim cannot
    // drift. Skips loudly on a shallow clone, per the UI-05 proof-truth rule.
    const BASE = "origin/feat/ui05-native-confirm-retirement";
    let beforeBoxes = 0;
    let beforeDeepest = 0;
    try {
      for (const f of FILES) {
        const src = execFileSync("git", ["show", `${BASE}:${f}`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const d = boxes(src);
        beforeBoxes += d.length;
        beforeDeepest = Math.max(beforeDeepest, ...d);
      }
    } catch {
      // MUST NOT RETURN NORMALLY. A bare `return` here is reported as PASS, so
      // on any clone without this ref the "fewer boxes than the base" claim
      // would be recorded green while doing nothing.
      //
      // I fixed exactly this defect in UI-02 — where a missing base made a
      // historical proof pass without executing — and then wrote the same
      // `catch { warn; return }` again here, two slices later. Codex caught it
      // a second time. The UI-02 repair guarded that suite only; the HABIT
      // travelled to a new file, which is the part worth recording.
      ctx.skip(`base ${BASE} unreachable — the box-count comparison did NOT run`);
      return;
    }

    let afterBoxes = 0;
    let afterDeepest = 0;
    for (const f of FILES) {
      const d = boxes(code(f));
      afterBoxes += d.length;
      afterDeepest = Math.max(afterDeepest, ...d);
    }
    expect(afterBoxes, `boxes ${beforeBoxes} -> ${afterBoxes}`).toBeLessThan(beforeBoxes);
    expect(afterDeepest, `depth ${beforeDeepest} -> ${afterDeepest}`).toBeLessThan(beforeDeepest);
  });

  it("adds no dependency and no client boundary", () => {
    // All three stay server components: a visual slice must not be the reason
    // a clinical page hydrates (#609).
    for (const f of FILES) {
      expect(code(f), `${f} must stay a server component`).not.toMatch(
        /^\s*["']use client["']/m,
      );
    }
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    for (const banned of ["framer-motion", "motion", "lucide-react", "clsx", "tailwind-merge"]) {
      expect(Object.keys(pkg.dependencies)).not.toContain(banned);
    }
  });

  it("adds NO motion — the gate rejected every candidate", () => {
    // find-animation-opportunities was run and produced no surviving
    // suggestion: the conditional renders are server output with no client
    // state change to bridge; the list staggers would delay clinical data a
    // practitioner is reading on a many-times-daily surface; the <details>
    // accordions would need a client boundary and a height animation.
    for (const f of FILES) {
      const src = code(f);
      expect(src, `${f} must not gain a transition`).not.toMatch(/\btransition-/);
      expect(src, `${f} must not gain an animation`).not.toMatch(/\banimate-/);
    }
  });
});

// ---------------------------------------------------------------------------
// CI TARGETING. Registering a spec in a group is only half the job: the CHANGED
// PATH has to select that group, or the spec never runs in a targeted lane.
//
// ui06-dashboard-chrome.spec.ts lives in `sessions` and exists to prove three
// cards. Before this fix those three paths resolved THREE different ways:
//
//   appointment-prep-memory-card.tsx  -> booking + smoke   (filename matched
//                                        /appointments?/i and nothing else)
//   last-treatment-memory-card.tsx    -> sessions + smoke  (correct already)
//   before-today-card.tsx             -> EXTENDED fallback (matches no rule)
//
// So the spec was unreachable from the very card it was written for. Third time
// this class has been caught in this stack.
//
// These assertions call the REAL planner — selectBrowserGroups and
// specsForGroups — not a re-implementation of the matching, because a
// duplicated oracle agrees with a broken subject.
// ---------------------------------------------------------------------------
describe("UI-06: the planner actually selects this spec for its own subjects", () => {
  const SPEC = "ui06-dashboard-chrome.spec.ts";

  /** Does a diff touching these files run the UI-06 spec? */
  const selection = (files: string[]) => {
    const r = selectBrowserGroups(files);
    const specs = specsForGroups(r.groups);
    return {
      groups: r.groups as string[],
      extended: specs === null,
      runsSpec: specs === null ? true : specs.includes(SPEC),
    };
  };

  it("CASE 1 — a change to the prep card alone selects this spec, targeted", () => {
    const s = selection(["components/appointment-prep-memory-card.tsx"]);
    expect(s.extended, "must be TARGETED, not the extended fallback").toBe(false);
    expect(s.groups, `groups were ${JSON.stringify(s.groups)}`).toContain("sessions");
    expect(s.runsSpec).toBe(true);
  });

  it("CASE 2 — an unrelated component does not select it via THIS rule", () => {
    // client-tags-card matches no PATH_TO_GROUP rule, so it takes the
    // pre-existing EXTENDED fail-safe and runs everything. That is not this
    // rule selecting it spuriously, and the distinction matters: the assertion
    // is that the NEW pattern does not match unrelated files.
    const s = selection(["components/client-tags-card.tsx"]);
    expect(s.groups).toEqual(["__extended__"]);

    // The pattern's specificity, proved on files that merely look similar.
    const actions = selection(["app/(app)/dashboard/prep-memory-actions.ts"]);
    expect(
      actions.groups,
      "a loose /prep-memory/ pattern would have NARROWED this file from extended to one group",
    ).toEqual(["__extended__"]);
  });

  it("CASE 3 — the siblings this spec also proves still behave as before", () => {
    const last = selection(["components/last-treatment-memory-card.tsx"]);
    expect(last.extended).toBe(false);
    expect(last.groups).toContain("sessions");
    expect(last.runsSpec).toBe(true);

    // before-today-card matches no rule and keeps its EXTENDED fail-safe. It is
    // reported rather than changed: narrowing it to one group would REDUCE its
    // coverage, which is a decision beyond this slice.
    const before = selection(["components/before-today-card.tsx"]);
    expect(before.groups).toEqual(["__extended__"]);
    expect(before.runsSpec, "reached via the fail-safe, not via targeting").toBe(true);
  });

  it("CASE 4 — targeting is real, not the extended fallback in disguise", () => {
    // If CASE 1 were passing only because everything runs, this would fail.
    const s = selection(["components/appointment-prep-memory-card.tsx"]);
    expect(s.groups).not.toContain("__extended__");
    expect(s.extended).toBe(false);

    // And docs-only still needs no browser at all, so the planner has not been
    // coarsened into selecting something for everything.
    const docs = selection(["docs/00_PRODUCT_OVERVIEW.md"]);
    expect(docs.groups).toEqual([]);
    expect(docs.runsSpec).toBe(false);
  });

  it("NEGATIVE CONTROL — the new pattern is what does the work", () => {
    // A near-miss filename differing only in the segment the pattern matches:
    // "memo" instead of "memory". It still hits the booking rule via
    // /appointments?/i, exactly as the real card did BEFORE this fix, and must
    // NOT reach `sessions` — which is precisely the broken state the P2
    // described. Run through the real planner, so this cannot pass by agreeing
    // with a copy of the matcher.
    const nearMiss = selection(["components/appointment-prep-memo-card.tsx"]);
    expect(nearMiss.groups).toContain("booking");
    expect(
      nearMiss.groups,
      "without the new pattern the prep card reached booking only — the bug",
    ).not.toContain("sessions");
    expect(nearMiss.runsSpec, "and so the UI-06 spec would not run").toBe(false);

    // The real card differs only by that segment and DOES reach sessions.
    const real = selection(["components/appointment-prep-memory-card.tsx"]);
    expect(real.groups).toContain("sessions");
    expect(real.runsSpec).toBe(true);
  });
});
