import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// THE BOUNDARY, ENFORCED — because a returned type is not a boundary.
//
// The retired design failed for a reason worth restating: it returned better
// data and left every other route open. Selectors stayed exported over `T[]`,
// pages kept their own reads, and the authority was opt-in. A chokepoint one
// caller can walk around is a library.
//
// These assertions are what make it not opt-in. They are scoped to the SEVEN
// consumers and the authority's own modules — they are not a repo-wide ban on
// ordinary Supabase destructuring.
//
// Every assertion runs COMMENT-STRIPPED. These files explain at length which
// call sites were retired and why, and a guard that cannot tell a rationale
// from a call punishes recording the reason.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * SEVEN CONSUMERS, SIX FILES.
 *
 * Consumers 2 and 3 are the Dashboard row and its on-demand disclosure, and the
 * disclosure is two files: the server action that performs the read (listed
 * here) and the client component that renders it, which reads no history of its
 * own. The list is CLOSED — a new file performing a governed historical read is
 * a scope decision, not something to add here quietly.
 */
const CONSUMERS = [
  "app/(app)/calendar/[id]/page.tsx",
  "app/(app)/dashboard/page.tsx",
  "app/(app)/dashboard/prep-memory-actions.ts",
  "app/(app)/clients/[id]/sessions/new/page.tsx",
  "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
  "app/(app)/clients/[id]/page.tsx",
] as const;

const AUTHORITY_DIR = "lib/sessions/history";

describe("a consumer cannot reach history any way but through the authority", () => {
  it("every consumer DOES reach it — without this, silence satisfies the rest", () => {
    for (const rel of CONSUMERS) {
      // Word-bounded: `loadAppointmentPrepMemory` must not satisfy this by
      // merely containing the name of the entry point.
      expect(codeOnly(read(rel)), rel).toMatch(
        /\bloadVisitPreparations?\b/,
      );
    }
  });

  const RETIRED = [
    "loadLastChartedTreatment",
    "loadLastChartedTreatmentForClient",
    "loadLastChartedTreatmentsForClients",
    "pickLastTreatment",
    "pickNewestChartedSession",
    "pickPreClientWatchPlanSource",
    "chartedSessionCandidates",
    "getBeforeTodayPreviews",
  ];

  for (const rel of CONSUMERS) {
    const code = codeOnly(read(rel));
    for (const selector of RETIRED) {
      // The Dashboard still reads records-completeness chips from the previews
      // helper. Those are about the CLIENT, not a visit: no latest/last/absence
      // claim about treatment, so they are outside this family.
      const permitted =
        selector === "getBeforeTodayPreviews" && rel === "app/(app)/dashboard/page.tsx";
      if (permitted) continue;
      it(`${rel} cannot reach ${selector}`, () => {
        expect(code).not.toMatch(new RegExp(`\\b${selector}\\b`));
      });
    }
  }

  it("no consumer applies a historical horizon of its own", () => {
    // `.lt("started_at", …)` IS a historical cutoff — "the visits strictly
    // before this point" — and answering that is the authority's entire job. A
    // consumer asking it directly has re-created the bypass, whatever it does
    // with the answer.
    for (const rel of CONSUMERS) {
      expect(codeOnly(read(rel)), `${rel} applies its own cutoff`).not.toMatch(
        /\.lt\(\s*"started_at"/,
      );
    }
  });

  it("an array POSITION is not a recency answer", () => {
    // Acceptance question 1 in its cheapest disguise: a consumer does not need
    // a selector to re-decide recency — `sessions[0]` is enough, and it is what
    // the client profile used in two places.
    for (const rel of CONSUMERS) {
      expect(codeOnly(read(rel)), `${rel} indexes a session array`).not.toMatch(
        /\bsessions\s*\[\s*0\s*\]/,
      );
    }
  });

  it("no consumer re-sorts visits by started_at", () => {
    // These pages legitimately order note entries and passes WITHIN a visit by
    // `created_at`. What they may not do is order VISITS.
    for (const rel of CONSUMERS) {
      expect(codeOnly(read(rel)), `${rel} re-sorts visits`).not.toMatch(
        /\.sort\([^;]*started_at/,
      );
    }
  });
});

describe("the clinical model is built in exactly ONE place", () => {
  it("no consumer builds it, because the builder accepts partial input", () => {
    // `AppointmentPrepMemoryInput` marks four evidence channels optional, so a
    // page-side build can drop a laser visit's narrative, a legacy entry-only
    // visit's passes and the superseded line WITHOUT a type error. That is not
    // a hypothetical: it is what shipped.
    for (const rel of CONSUMERS) {
      const code = codeOnly(read(rel));
      expect(code, `${rel} builds the model`).not.toMatch(
        /buildAppointmentPrepMemory\(/,
      );
      expect(code, `${rel} maps its own input`).not.toMatch(
        /prepMemoryInputFromTreatment\(/,
      );
    }
  });

  it("and inside the authority, only the adapter reaches the builder", () => {
    for (const file of readdirSync(path.join(ROOT, AUTHORITY_DIR))) {
      if (!file.endsWith(".ts") || file === "visit-summary.ts") continue;
      expect(
        read(`${AUTHORITY_DIR}/${file}`),
        `${file} builds prep memory itself`,
      ).not.toContain("buildAppointmentPrepMemory");
    }
  });
});

describe("ONE canonical clinical projection, and the authority names no column", () => {
  it("the detail read selects only `*`", () => {
    const code = codeOnly(read(`${AUTHORITY_DIR}/visit-detail.ts`));
    const selects = code.match(/\.select\(([^)]*)\)/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) expect(s, `non-canonical projection: ${s}`).toBe('.select("*")');
  });

  it("the selection read selects `*` plus aggregates, and no clinical column", () => {
    const code = codeOnly(read(`${AUTHORITY_DIR}/select-visit.ts`));
    expect(code).toMatch(/\.select\(`\*, \$\{CHARTED_COUNT_COLUMNS\}`\)/);
  });

  it("NO clinical column name appears anywhere in the authority", () => {
    // The projection law, mechanically. Adding a treatment-entry field must not
    // require editing this directory at all.
    const CLINICAL = [
      "hairs_treated", "primary_area", "energy_level", "probe_lot_number",
      "tolerance_rating", "machine_frequency", "observation_chips",
      "apilus_modality", "minutes_performed", "reaction_type",
    ];
    for (const file of readdirSync(path.join(ROOT, AUTHORITY_DIR))) {
      if (!file.endsWith(".ts")) continue;
      const code = codeOnly(read(`${AUTHORITY_DIR}/${file}`));
      for (const column of CLINICAL) {
        expect(code, `${file} names the clinical column ${column}`).not.toContain(
          `"${column}`,
        );
      }
    }
  });
});

describe("uncertainty cannot be ignored, and absence cannot be invented", () => {
  it("the window brand is module-private and the eliminator is total", () => {
    const window = read(`${AUTHORITY_DIR}/window.ts`);
    expect(window).toMatch(/declare const HISTORICAL_WINDOW: unique symbol/);
    expect(window).not.toMatch(/export (declare )?const HISTORICAL_WINDOW/);
    for (const handler of ["observed", "none", "indeterminate", "failed"]) {
      expect(codeOnly(window)).toMatch(new RegExp(`\\n\\s{4}${handler}: \\(`));
    }
    expect(codeOnly(window)).not.toMatch(/unwrapOr|valueOrNull|orElse|getOrDefault/);
  });

  it("`none` is reachable only from a COMPLETE window", () => {
    const code = codeOnly(read(`${AUTHORITY_DIR}/window.ts`));
    const nones = code.match(/kind: "none"/g) ?? [];
    expect(nones.length).toBeGreaterThan(0);
    expect(code).toMatch(
      /window\.bound\.kind === "complete"\s*\n?\s*\? \{ kind: "none" \}\s*\n?\s*: \{ kind: "indeterminate" \}/,
    );
  });

  it("every governed read binds its error", () => {
    for (const rel of [`${AUTHORITY_DIR}/select-visit.ts`, `${AUTHORITY_DIR}/visit-detail.ts`]) {
      const code = codeOnly(read(rel));
      const destructures = code.match(/const \{ data[^}]*\} = await/g) ?? [];
      for (const d of destructures) expect(d, `${rel}: ${d}`).toMatch(/error/);
      expect(code, `${rel} declares no bound`).toMatch(/\.limit\(/);
    }
  });

  it("no generic completeness boolean is exposed to a consumer", () => {
    // The shape the retired design died of: a boolean a caller must remember to
    // inspect. Coverage informs the AUTHORITY; it never reaches a renderer.
    for (const rel of CONSUMERS) {
      const code = codeOnly(read(rel));
      for (const flag of [
        "briefingComplete", "historyComplete", "blocksComplete",
        "hasCompleteHistory", "latestKnown", "historyKnown",
      ]) {
        expect(code, `${flag} declared in ${rel}`).not.toMatch(
          new RegExp(`\\b${flag}\\??:\\s*boolean`),
        );
      }
    }
  });
});
