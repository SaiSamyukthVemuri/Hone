import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// ===========================================================================
// CHART-SESSION-01 / #699 — THE CTA IS WITHHELD, AND THIS PROVES IT
// ===========================================================================
//
// `lib/dashboard/session-resolution.ts` decides a chart CTA whose zero-branch
// routes to `sessions/new?appointment_id=…`, i.e. into `start_session`. That
// RPC is NOT appointment-safe yet: with `p_appointment_id` supplied it can
// still reuse a session linked to a DIFFERENT appointment (finding
// 4008020858), because its coalesce window has no appointment term.
//
// So the resolver ships as a TESTED, UNREACHABLE decision. This guard fails
// the moment someone wires it into a production-facing surface, which is the
// one way this work could cause harm before the database repair lands.
//
// DELETE THIS FILE in the same change that makes the CTA reachable — and only
// after the migration proving appointment-scoped coalescence is applied.
// ===========================================================================

const ROOT = path.resolve(__dirname, "../..");

/** Tracked files only, so node_modules and build output cannot skew a result. */
function tracked(...globs: string[]): string[] {
  const out = execFileSync("git", ["ls-files", "--", ...globs], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

function grepTracked(pattern: string, globs: string[]): string[] {
  try {
    const out = execFileSync(
      "git",
      ["grep", "-l", "-E", pattern, "--", ...globs],
      { cwd: ROOT, encoding: "utf8" },
    );
    return out.split("\n").filter(Boolean);
  } catch {
    // git grep exits 1 when there is no match. That is the passing case.
    return [];
  }
}

// Production-facing runtime: what a signed-in practitioner's browser can reach.
// Tests and the resolver's own module are deliberately excluded.
const RUNTIME = ["app", "components", "lib"];

describe("the resolver exists but is NOT reachable", () => {
  it("is imported by NO production-facing runtime file", () => {
    const importers = grepTracked(
      "session-resolution",
      RUNTIME.map((d) => `${d}/**/*.ts*`),
    ).filter((f) => f !== "lib/dashboard/session-resolution.ts");
    expect(
      importers,
      "wiring the resolver in exposes Start charting before start_session is appointment-safe",
    ).toEqual([]);
  });

  it("renders 'Start charting' as a CTA label in NO runtime file", () => {
    // Comment-stripped, following the repo idiom: explanatory prose naming a
    // label must not read as the label shipping. Two tracked files mention the
    // phrase legitimately and neither renders it —
    //   app/(app)/dashboard/page.tsx  a comment listing CTA names
    //   app/resources/...paper-records/page.tsx  a marketing heading
    // — so the check is on CODE, and the marketing page is out of scope for a
    // practitioner CTA guard.
    const strip = (s: string) =>
      s.replace(/\/\/.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
    const candidates = grepTracked(
      "Start charting",
      RUNTIME.map((d) => `${d}/**/*.ts*`),
    ).filter(
      (f) =>
        f !== "lib/dashboard/session-resolution.ts" &&
        !f.startsWith("app/resources/"),
    );
    // WORKING TREE, not HEAD. `git grep` already reads the working tree, and
    // reading HEAD here would let uncommitted wiring pass a check the grep
    // above had just flagged.
    const rendering = candidates.filter((f) =>
      strip(readFileSync(path.join(ROOT, f), "utf8")).includes("Start charting"),
    );
    expect(
      rendering,
      "a runtime file renders Start charting before start_session is appointment-safe",
    ).toEqual([]);
  });

  it("does not add the label to the dashboard's shipped CTA union", () => {
    const nextAction = readFileSync(
      path.join(ROOT, "lib/dashboard/next-action.ts"),
      "utf8",
    );
    // The shipped labels are unchanged by this lane.
    expect(nextAction).not.toMatch(/Start charting/);
    expect(nextAction).not.toMatch(/Open chart/);
    expect(nextAction).not.toMatch(/View charts/);
    // And the withheld-CTA status quo still holds.
    expect(nextAction).toMatch(/Review Before Today/);
  });

  it("adds no migration SQL — the number is not ours to allocate", () => {
    // 0196 is owned by WAIT #703. Nothing here may claim a number, and the
    // next safe one must be re-derived from the integration tree after #703
    // settles rather than assumed to be 0197.
    const base = execFileSync(
      "git",
      ["merge-base", "HEAD", "origin/claude/build-hone-saas-hOex7"],
      { cwd: ROOT, encoding: "utf8" },
    ).trim();
    const changed = execFileSync(
      "git",
      ["diff", "--name-only", base, "HEAD"],
      { cwd: ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(changed.filter((f) => f.startsWith("supabase/migrations/"))).toEqual([]);
  });

  it("leaves the existing start_session callers untouched", () => {
    // Those callers are the LIVE defect surface (4008020858). Repairing them
    // is a database change, not an application edit, so this lane must not
    // quietly alter their behaviour.
    const base = execFileSync(
      "git",
      ["merge-base", "HEAD", "origin/claude/build-hone-saas-hOex7"],
      { cwd: ROOT, encoding: "utf8" },
    ).trim();
    const changed = execFileSync("git", ["diff", "--name-only", base, "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    for (const f of [
      "app/(app)/clients/[id]/sessions/new/actions.ts",
      "app/(app)/clients/[id]/sessions/new/page.tsx",
      "app/(app)/dashboard/page.tsx",
      "lib/dashboard/next-action.ts",
      "components/client-appointment-timeline.tsx",
    ]) {
      expect(changed, `${f} must not change in the pre-migration lane`).not.toContain(f);
    }
  });

  it("the resolver module itself is tracked and tested", () => {
    expect(tracked("lib/dashboard/session-resolution.ts")).toHaveLength(1);
    expect(tracked("tests/lib/dashboard/session-resolution.test.ts")).toHaveLength(1);
  });
});
