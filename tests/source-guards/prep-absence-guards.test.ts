import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// SOURCE GUARDS — the Dashboard may not manufacture absence from a partial read.
//
// WHY A SOURCE GUARD AND NOT ONLY BEHAVIOURAL TESTS
// -------------------------------------------------
// The behavioural contract lives in tests/lib/dashboard/pre-visit-prep.test.ts
// and the wiring in tests/app/dashboard/**. What neither can see is a FUTURE
// refactor reintroducing the shape: a `?? "Not recorded"` added at a render
// site, a `blocks.length === 0` turned back into a chip, or a fresh
// `hasHistory`-style boolean added to license prose. That family cost five
// consecutive review rounds on PR #608, each closing one instance, and the
// enumeration never converged.
//
// SCOPE IS DELIBERATELY NARROW. These assertions run against the files on the
// LIVE prep path only. They are not a repository-wide ban on the word "no":
//
//   * app/(app)/records/** legitimately renders "Not recorded" for a field it
//     read on a record it holds. That is the SAFE shape and must stay legal.
//   * components/appointment-prep-memory-card.tsx renders per-area
//     "Not recorded" / "Setup not recorded" scoped to ONE returned block's own
//     scalar columns. Also the safe shape, also legal.
//   * lib/dashboard/before-today-previews.ts and lib/dashboard/today-workflow.ts
//     still contain retired copy. They are OFF this path and are excluded — but
//     a separate assertion below pins that the page does not re-import them,
//     which is what actually keeps that copy unreachable.
//
// READ-FAILURE LANGUAGE IS EXPLICITLY ALLOWED. "Previous treatment could not be
// loaded." is an observed operational fact and one of the two things this
// surface may say. A guard that banned it would push the code back toward
// silence, which is the failure mode on the other side.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

// Comments legitimately QUOTE the removed copy — every rationale in this change
// names the sentence it deleted. A guard that cannot tell a quotation from a
// render punishes documenting the fix, so every assertion runs on code only.
function codeOnly(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const PREP_PATH = [
  "app/(app)/dashboard/page.tsx",
  "app/(app)/dashboard/pre-visit-prep-block.tsx",
  "app/(app)/dashboard/dashboard-treatment-memory.tsx",
  "app/(app)/dashboard/prep-memory-actions.ts",
  "lib/dashboard/prep/pre-visit-prep.ts",
  "lib/dashboard/prep/build-pre-visit-prep.ts",
  "lib/dashboard/prep/direct-record-reminder.ts",
  "lib/sessions/prep-observations.ts",
  "lib/sessions/last-treatment-loader.ts",
  "lib/sessions/appointment-prep-memory.ts",
  "lib/sessions/point-of-care-memory.ts",
  "components/appointment-prep-memory-card.tsx",
] as const;

const SOURCES = PREP_PATH.map((rel) => [rel, codeOnly(read(rel))] as const);

// ---------------------------------------------------------------------------

describe("no history-absence sentence exists on the prep path", () => {
  // Each entry is a claim that was, at some point, rendered from an empty or
  // unread COLLECTION. They are listed literally rather than as one broad
  // pattern so the guard stays legible and cannot go vacuous.
  const BANNED: ReadonlyArray<readonly [string, RegExp]> = [
    ["the watch/plan denial", /No watch\/plan note/i],
    ["the setup denial", /Latest setup:\s*(\{[^}]*\}\s*)?["']?Not recorded/i],
    ["the no-prior-treatment denial", /No prior charted treatment/i],
    ["the no-history relationship claim", /No charted history yet/i],
    ["the relationship label", /\bNew client\b/],
    ["the treatment-area denial", /Treatment area not recorded/i],
    ["the disclosure denial", /No previous treatment to show/i],
    ["the block-absence claim", /without settings blocks/i],
    ["the areas-absence claim", /has no charted treatment areas/i],
    ["the notes denial", /No notes recorded at the last session/i],
    ["the newer-session-is-empty claim", /newer session has no treatment/i],
  ];

  for (const [rel, code] of SOURCES) {
    for (const [label, pattern] of BANNED) {
      it(`${rel} does not render ${label}`, () => {
        expect(code, `${label} in ${rel}`).not.toMatch(pattern);
      });
    }
  }
});

describe("a null may not acquire copy at the render site", () => {
  // THE PATTERN, not the string. `{workflow.setup ?? "Not recorded"}` is where
  // the setup denial actually lived: by the time a null reaches JSX, the
  // information needed to tell "none" from "not read" is long out of scope, so
  // ANY string fallback there is unprovable on principle.
  it("the preparation renderer contains no string-fallback operator at all", () => {
    const block = codeOnly(read("app/(app)/dashboard/pre-visit-prep-block.tsx"));
    expect(block).not.toMatch(/\?\?\s*["'`]/);
    expect(block).not.toMatch(/\|\|\s*["'`]/);
    // …and no ternary that substitutes prose for a missing prep fact.
    expect(block).not.toMatch(/prep\.\w+\s*\?[^:]*:\s*["'`]/);
  });

  it("the disclosure card substitutes no prose for an absent area headline", () => {
    const card = codeOnly(read("components/appointment-prep-memory-card.tsx"));
    expect(card).not.toMatch(/areaHeadline\s*\?\?/);
  });
});

describe("no completeness boolean may be introduced to license prose", () => {
  // The repeated failure was not that these flags were wrong; it is that ANY
  // such flag has to be RIGHT for the page to be truthful, and each new
  // narrowing operation is a fresh chance for it not to be. Round 5 arrived
  // through a path round 4's flag did not describe: `truncated` was computed
  // from the SESSION read and then used to gate BLOCK-derived outcomes.
  const BANNED_FLAGS = [
    "hasHistory",
    "briefingComplete",
    "historyKnown",
    "isTruncated",
    "maybeComplete",
    "allDataLoaded",
    "hasCharted",
    "historyComplete",
  ];

  const MODEL_FILES = [
    "lib/dashboard/prep/pre-visit-prep.ts",
    "lib/dashboard/prep/build-pre-visit-prep.ts",
    "lib/dashboard/prep/direct-record-reminder.ts",
    "app/(app)/dashboard/pre-visit-prep-block.tsx",
  ] as const;

  for (const rel of MODEL_FILES) {
    const code = codeOnly(read(rel));
    for (const flag of BANNED_FLAGS) {
      it(`${rel} declares no \`${flag}\``, () => {
        expect(code, `${flag} in ${rel}`).not.toMatch(
          new RegExp(`\\b${flag}\\b`),
        );
      });
    }
  }

  it("the model has NO field meaning 'nothing exists in history'", () => {
    const model = read("lib/dashboard/prep/pre-visit-prep.ts");
    const type = model.slice(
      model.indexOf("export type PreVisitPrep = {"),
      model.indexOf("};", model.indexOf("export type PreVisitPrep = {")),
    );
    expect(type.length).toBeGreaterThan(60);
    const fields = [...type.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
    expect(fields.sort()).toEqual(
      [
        "caution",
        "directRecordReminders",
        "lastTreatment",
        "latestSetup",
        "loadFailure",
        "remember",
      ].sort(),
    );
    // Every prep FACT is optional; absence is expressed by the field not being
    // there, which is what makes "render nothing" the only possible handling.
    for (const optional of [
      "remember",
      "caution",
      "latestSetup",
      "lastTreatment",
      "loadFailure",
    ]) {
      expect(type, `${optional} must be optional`).toMatch(
        new RegExp(`\\b${optional}\\?:`),
      );
    }
  });

  it("read-failure language is still permitted — the other half of the law", () => {
    // The Dashboard may state failures it OBSERVED. A guard that silenced this
    // would trade a false denial for an uninformative blank.
    const ui = read("app/(app)/dashboard/dashboard-treatment-memory.tsx");
    expect(ui).toMatch(/Previous treatment could not be loaded/);
    expect(read("lib/dashboard/prep/pre-visit-prep.ts")).toMatch(
      /reason: "read_error" \| "window_exhausted"/,
    );
  });
});

describe("a missing-record line REQUIRES a witness", () => {
  const WITNESS = read("lib/dashboard/prep/direct-record-reminder.ts");
  const BUILD = read("lib/dashboard/prep/build-pre-visit-prep.ts");

  it("the branded type has exactly one exported constructor", () => {
    // The brand symbol is declared but NOT exported, so no other module can
    // produce a DirectRecordReminder with an object literal.
    expect(WITNESS).toMatch(/declare const DIRECT_RECORD_REMINDER: unique symbol/);
    expect(WITNESS).not.toMatch(/export declare const DIRECT_RECORD_REMINDER/);
    expect(WITNESS).not.toMatch(/export const DIRECT_RECORD_REMINDER/);
    expect(
      (WITNESS.match(/export function directRecordReminder/g) ?? []).length,
    ).toBe(1);
  });

  it("a witness demands a ROW CARRYING A PRIMARY KEY", () => {
    // This one line is the architecture. None of the shapes that caused the
    // five failures can produce an `id`:
    //   blocks.length === 0            -> a number
    //   blocksBySession.get(id) ?? []  -> an array
    //   a missing Map entry            -> undefined
    expect(WITNESS).toMatch(/export type AuthoritativeRow = \{ id: string \}/);
    expect(WITNESS).toMatch(/TRow extends AuthoritativeRow/);
    expect(WITNESS).toMatch(
      /field: Exclude<keyof TRow & string, "id">/,
    );
  });

  it("every reminder on the prep path is built through that constructor", () => {
    const pushes = BUILD.match(/push\(/g) ?? [];
    const constructed = BUILD.match(/directRecordReminder\(/g) ?? [];
    expect(pushes.length).toBeGreaterThan(0);
    // Every push is fed by a constructor call (the helper itself is one `push(`).
    expect(constructed.length).toBeGreaterThanOrEqual(pushes.length - 1);
    // And nothing is derived from a collection's size.
    expect(codeOnly(BUILD)).not.toMatch(/\.length === 0/);
    expect(codeOnly(BUILD)).not.toMatch(/\.length > 0\s*\)?\s*\)?\s*\{?\s*reminders/);
    // No cast can smuggle one past the type.
    expect(BUILD).not.toMatch(/as unknown as/);
    expect(BUILD).not.toMatch(/as DirectRecordReminder/);
  });

  it("a recorded ZERO or FALSE is not treated as missing", () => {
    // `0` is a measurement. Flattening it with a falsy check is the mistake
    // compactSummary and outcomeRecorded already avoid elsewhere.
    expect(WITNESS).toMatch(/value === null \|\| value === undefined/);
    expect(WITNESS).not.toMatch(/if \(!value\)/);
  });
});

describe("the retired pipelines cannot come back through the page", () => {
  const PAGE = codeOnly(read("app/(app)/dashboard/page.tsx"));

  it("neither retired historical pipeline is imported or called", () => {
    // The retired copy still exists in those two modules. What keeps it
    // unreachable is this: the page does not use them.
    expect(PAGE).not.toMatch(/before-today-previews/);
    expect(PAGE).not.toMatch(/getBeforeTodayPreviews/);
    expect(PAGE).not.toMatch(/buildTodayWorkflow/);
    expect(PAGE).not.toMatch(/todayWorkflowByAppointment/);
  });

  it("exactly ONE historical read remains on the roster path", () => {
    expect(
      (PAGE.match(/loadLastChartedTreatmentsForClients\(/g) ?? []).length,
    ).toBe(1);
    // …and it is never called per row.
    expect(PAGE).not.toMatch(/loadLastChartedTreatmentForClient\b/);
  });

  it("every prep request carries its OWN appointment boundary", () => {
    expect(PAGE).toMatch(/requestKey: a\.id/);
    expect(PAGE).toMatch(/before: a\.starts_at/);
    expect(PAGE).toMatch(/excludeAppointmentId: a\.id/);
    // The boundary is the appointment's own start, never a clock read.
    expect(PAGE).not.toMatch(/before: (new Date|Date\.now|renderNow)/);
  });
});

describe("a SUPERLATIVE needs recency authority, not just positive evidence", () => {
  const COVERAGE = read("lib/sessions/block-read-coverage.ts");
  const OBSERVERS = read("lib/sessions/prep-observations.ts");
  const LOADER = read("lib/sessions/last-treatment-loader.ts");
  const MODEL = read("lib/dashboard/prep/pre-visit-prep.ts");
  const BUILD = read("lib/dashboard/prep/build-pre-visit-prep.ts");

  it("read coverage is a DISCRIMINATED UNION, not another boolean", () => {
    // A general-purpose completeness boolean on a shared model is the shape
    // PR #608 died of: the next caller uses it to license some other sentence,
    // and it then has to be right about a read it does not describe.
    expect(COVERAGE).toMatch(/kind: "complete"/);
    expect(COVERAGE).toMatch(/kind: "possibly_truncated"/);
    // Scoped to the TYPE ITSELF. `absentMeansEmpty` legitimately RETURNS a
    // boolean — it is a predicate over the union, which is the point: callers
    // ask it a question instead of reading a stored flag they can misuse.
    const union = COVERAGE.slice(
      COVERAGE.indexOf("export type BlockReadCoverage ="),
      COVERAGE.indexOf(";", COVERAGE.indexOf("export type BlockReadCoverage =")),
    );
    expect(union.length).toBeGreaterThan(40);
    expect(union).not.toMatch(/boolean/);
  });

  it("coverage NEVER reaches the Dashboard model or the renderer", () => {
    // The UI receives facts, or nothing. It is not handed completeness
    // authority to interpret.
    for (const [label, src] of [
      ["prep model", MODEL],
      ["prep builder", BUILD],
      ["prep renderer", read("app/(app)/dashboard/pre-visit-prep-block.tsx")],
      ["dashboard page", read("app/(app)/dashboard/page.tsx")],
    ] as const) {
      expect(codeOnly(src), label).not.toMatch(/BlockReadCoverage/);
      expect(codeOnly(src), label).not.toMatch(/possibly_truncated/);
    }
  });

  it("no generic completeness flag was added to the public prep model", () => {
    for (const flag of [
      "blocksComplete",
      "hasCompleteHistory",
      "latestKnown",
      "coverage",
      "complete",
    ]) {
      expect(codeOnly(MODEL), flag).not.toMatch(new RegExp(`\\b${flag}\\b`));
    }
  });

  it("the setup observer CANNOT be called without coverage", () => {
    // Structural, not conventional: the parameter is required, so every call
    // site is a compile error until it supplies the evidence.
    expect(OBSERVERS).toMatch(
      /export function observeLatestSetup\([\s\S]{0,400}coverage: BlockReadCoverage,\s*\)/,
    );
    // …and it refuses to walk past an unread candidate under truncation.
    expect(OBSERVERS).toMatch(/if \(!absentMeansEmpty\(coverage\)\) return null;/);
  });

  it("the CAUTION observer deliberately takes no coverage — the asymmetry is real", () => {
    // It is a bare positive fact under an existing product contract
    // (clinical-summary.ts, pickPreClientWatchPlanSource), so gating it would
    // suppress guidance the product intends to surface.
    expect(OBSERVERS).toMatch(
      /export function observeCaution\([\s\S]{0,300}\): PrepCautionObservation \| null/,
    );
    const cautionSig = OBSERVERS.slice(
      OBSERVERS.indexOf("export function observeCaution("),
      OBSERVERS.indexOf("): PrepCautionObservation | null"),
    );
    expect(cautionSig).not.toMatch(/coverage/);
  });

  it("'Last treatment' is guarded against the SAME attack", () => {
    // Repairing the setup line alone would fix the symptom and keep the defect
    // in the more consequential position.
    expect(LOADER).toMatch(/function newerCandidateUnresolved<T extends/);
    // Applied on BOTH selection paths: the single-client one inside
    // `selectFromCandidates`, and the batched one the Dashboard uses. The
    // generic definition does not match a bare call, so this counts CALL SITES.
    expect((LOADER.match(/newerCandidateUnresolved\(/g) ?? []).length).toBe(2);
    // Scoped to rows NEWER than the pick: an older unread row cannot falsify a
    // recency claim, and vetoing on it would make a busy day useless.
    expect(LOADER).toMatch(/if \(candidate\.id === selectedId\) return false;/);
  });

  it("the block bound cannot exceed PostgREST's own max_rows", () => {
    // THE LATENT HOLE THIS CLOSES. Truncation is detected as
    // `returned >= MAX_BATCH_BLOCK_ROWS`. If that bound were ever raised above
    // `max_rows`, the server would clamp BELOW our limit, `returned` would never
    // reach it, and a truncated read would report `complete` — the same failure
    // wearing a different number.
    const configured = read("supabase/config.toml").match(/^max_rows\s*=\s*(\d+)/m);
    expect(configured, "max_rows must be declared in supabase/config.toml").not.toBeNull();
    const ours = LOADER.match(/const MAX_BATCH_BLOCK_ROWS = (\d+)/);
    expect(ours, "MAX_BATCH_BLOCK_ROWS must be declared").not.toBeNull();
    expect(Number(ours![1])).toBeLessThanOrEqual(Number(configured![1]));
  });
});

describe("bounded reads are bounded EXPLICITLY, not by a silent clamp", () => {
  const LOADER = read("lib/sessions/last-treatment-loader.ts");

  it("both block reads state their own ceiling", () => {
    // PostgREST clamps at `max_rows` (supabase/config.toml) and a clamped
    // response is a 200 with fewer rows and NO error. Stating the bound here
    // makes the ceiling reviewable and exhaustion observable.
    expect(LOADER).toMatch(/const MAX_BATCH_BLOCK_ROWS = \d+/);
    expect((LOADER.match(/\.limit\(MAX_BATCH_BLOCK_ROWS\)/g) ?? []).length).toBe(2);
  });

  it("no pagination was added to the Dashboard hot path", () => {
    // Deliberate. Under the positive-evidence model an unread block OMITS a
    // fact rather than negating one, so chasing completeness here would buy
    // round-trips for a guarantee the surface does not need.
    expect(LOADER).not.toMatch(/fetchAllRows|EXPORT_PAGE_SIZE|while \(true\)/);
  });
});
