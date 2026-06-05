import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #156 (migration 0068). getPastConfirmedAppointmentsForClient is
// the single dedup site between past confirmed appointments and
// charted sessions. After 0068 it must:
//
//   1. Prefer the explicit sessions.appointment_id link (exact, robust
//      to same-day visits and reschedules).
//
//   2. Fall back to the +/- 2 hour starts_at proximity heuristic ONLY
//      for sessions where appointment_id is null (legacy + client-
//      scoped rows). A session that already has an explicit link must
//      NOT also participate in the proximity scan, or the same visit
//      could be counted twice.
//
// These invariants are enforced as text on the source file so a
// future refactor that drops the split (e.g. recomputes a single
// list from started_at without consulting appointment_id) is caught
// by `npm test`.

const QUERIES_PATH = path.resolve(
  __dirname,
  "../../../lib/supabase/queries.ts",
);
const SOURCE = readFileSync(QUERIES_PATH, "utf8");

function helperBlock(): string {
  const match = SOURCE.match(
    /export async function getPastConfirmedAppointmentsForClient[\s\S]*?\n\}/,
  );
  if (!match) throw new Error("helper function not found in queries.ts");
  return match[0];
}

describe("getPastConfirmedAppointmentsForClient prefers the explicit FK", () => {
  it("exports a session-shape type carrying appointment_id alongside started_at", () => {
    // The shared type lives outside the function block and carries the
    // canonical shape; assert against the type definition by name so
    // callers compile against the same contract.
    const typeBlock =
      SOURCE.match(
        /export type KnownSessionForPastAppointmentDedup[\s\S]*?\};/,
      )?.[0] ?? "";
    expect(typeBlock).toMatch(/started_at:\s*string/);
    expect(typeBlock).toMatch(/appointment_id:\s*string\s*\|\s*null/);
  });

  it("the helper takes a ReadonlyArray of that shape", () => {
    const fn = helperBlock();
    expect(fn).toMatch(
      /knownSessions:\s*ReadonlyArray<KnownSessionForPastAppointmentDedup>/,
    );
  });

  it("collects a Set of explicit appointment_ids from the linked sessions", () => {
    const fn = helperBlock();
    expect(fn).toMatch(/linkedAppointmentIds\s*=\s*new Set<string>\(\)/);
    expect(fn).toMatch(/linkedAppointmentIds\.add\(/);
  });

  it("excludes an appointment whose id is in the explicit-link set", () => {
    const fn = helperBlock();
    expect(fn).toMatch(/if \(linkedAppointmentIds\.has\(a\.id\)\) return false/);
  });

  it("collects the proximity window only from unlinked sessions", () => {
    const fn = helperBlock();
    // The unlinked-session bucket is populated only when
    // s.appointment_id is null/false. The filter MUST consult only
    // this bucket so a linked session does not also count as a
    // proximity match against its own appointment.
    expect(fn).toMatch(/unlinkedSessionStartMs/);
    expect(fn).toMatch(/if \(s\.appointment_id\) \{/);
    expect(fn).toMatch(/unlinkedSessionStartMs\.push\(/);
  });

  it("filters past appointments via the unlinked-only proximity bucket", () => {
    const fn = helperBlock();
    expect(fn).toMatch(
      /unlinkedSessionStartMs\.some\([\s\S]*?Math\.abs\([\s\S]*?\)\s*<=\s*TWO_HOURS_MS/,
    );
  });

  it("keeps the +/- 2 hour window (TWO_HOURS_MS = 2 * 60 * 60 * 1000)", () => {
    const fn = helperBlock();
    expect(fn).toMatch(/TWO_HOURS_MS\s*=\s*2\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it("still queries past confirmed appointments only (status=confirmed, starts_at<now)", () => {
    const fn = helperBlock();
    expect(fn).toMatch(/\.eq\(\s*["']status["']\s*,\s*["']confirmed["']\s*\)/);
    expect(fn).toMatch(/\.lt\(\s*["']starts_at["']\s*,\s*nowIso\s*\)/);
  });
});

// ---------------------------------------------------------------------------
// PR #157 supersedes the caller-side check from PR #156. The client
// profile no longer calls getPastConfirmedAppointmentsForClient; it
// reads the timeline via getAppointmentsForClientProfile which joins
// to sessions.appointment_id directly. The helper above stays in
// queries.ts as a reusable utility (and is still validated by the
// invariants in this file), but no production code calls it today.
// We assert that explicitly so a future PR that re-enables it knows
// to revisit the invariants on its new caller.
// ---------------------------------------------------------------------------

describe("getPastConfirmedAppointmentsForClient is currently unused by app code", () => {
  it("has no caller in app/ or lib/ (outside queries.ts itself)", () => {
    // Walk app/ and lib/ in pure Node so the test works on any PATH
    // (the GitHub Actions CI runner does not have ripgrep
    // installed). We grep file contents for the symbol name and
    // self-exclude the helper's home file.
    const { readdirSync, readFileSync, statSync } =
      require("node:fs") as typeof import("node:fs");
    const repoRoot = path.resolve(__dirname, "../../..");
    const SCAN_ROOTS = ["app", "lib"];
    const SELF_EXCLUDE = "lib/supabase/queries.ts";
    const INCLUDE = new Set([".ts", ".tsx", ".js", ".jsx"]);
    const SKIP = new Set([
      "node_modules",
      ".next",
      ".git",
      "coverage",
      "tests",
    ]);
    const offenders: string[] = [];
    function walk(absDir: string) {
      let entries: string[];
      try {
        entries = readdirSync(absDir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (SKIP.has(entry)) continue;
        const full = path.join(absDir, entry);
        let s;
        try {
          s = statSync(full);
        } catch {
          continue;
        }
        if (s.isDirectory()) {
          walk(full);
          continue;
        }
        if (!s.isFile()) continue;
        if (!INCLUDE.has(path.extname(full))) continue;
        const rel = path.relative(repoRoot, full);
        if (rel === SELF_EXCLUDE) continue;
        let text: string;
        try {
          text = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        // Match a CALL site, not the bare substring. The page may
        // legitimately mention the helper name in a comment that
        // explains why it is no longer called; we only flag actual
        // invocations: `getPastConfirmedAppointmentsForClient(`.
        if (/\bgetPastConfirmedAppointmentsForClient\s*\(/.test(text)) {
          offenders.push(rel);
        }
      }
    }
    for (const root of SCAN_ROOTS) walk(path.join(repoRoot, root));
    expect(offenders).toEqual([]);
  });
});
