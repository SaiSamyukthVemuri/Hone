import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickPreClientWatchPlanSource } from "@/lib/sessions/clinical-summary";

// PR #203: sticky machine frequency (migration 0084) + reaction-chip
// plus signs + Sessions-tab Watch/Plan pre-client source fix.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const FORM = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
);
const ACTIONS = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
);
const VIEW = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx",
);
const SESSION_PAGE = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
);
const CLIENT_PAGE = read("app/(app)/clients/[id]/page.tsx");
const MIGRATION = read(
  "supabase/migrations/0084_practitioner_default_machine_frequency.sql",
);

// ---------------------------------------------------------------------------
// 1. Sticky machine frequency
// ---------------------------------------------------------------------------

describe("machine frequency: tap toggle with a sticky last-used default", () => {
  it("renders as a tap-friendly two-value toggle (no free text input)", () => {
    const region = FORM.slice(
      FORM.indexOf(">Machine frequency<"),
      FORM.indexOf(">Mode<"),
    );
    expect(region).toMatch(/MACHINE_FREQUENCIES\.map/);
    expect(region).toMatch(/type="button"/);
    // iPad-friendly hit area (same px-4 py-2 pills as Mode).
    expect(region).toMatch(/px-4 py-2/);
    expect(region).not.toMatch(/<input/);
  });

  it("the allowed values are exactly the schema's two frequencies", () => {
    const constants = read("lib/constants.ts");
    expect(constants).toMatch(/"13\.56 MHz",\s*\n\s*"27\.12 MHz",/);
    expect(MIGRATION).toMatch(/in \('13\.56 MHz','27\.12 MHz'\)/);
  });

  it("NEW treatment-area drafts seed from the practitioner's sticky default", () => {
    expect(SESSION_PAGE).toMatch(
      /defaultMachineFrequency=\{practitioner\.default_machine_frequency \?\? null\}/,
    );
    expect(VIEW).toMatch(/defaultMachineFrequency=\{defaultMachineFrequency \?\? null\}/);
    expect(FORM).toMatch(
      /machineFrequency: defaultMachineFrequency\?\.trim\(\) \|\| ""/,
    );
  });

  it("saving a treatment area remembers the value as the new default (both save paths)", () => {
    expect(ACTIONS).toMatch(/async function rememberMachineFrequencyDefault/);
    // Guarded to the two valid values only.
    expect(ACTIONS).toMatch(
      /frequency !== "13\.56 MHz" && frequency !== "27\.12 MHz"/,
    );
    // Called from BOTH the create and update area-with-entry actions.
    expect(
      ACTIONS.match(/await rememberMachineFrequencyDefault\(/g)?.length,
    ).toBe(2);
    // Best-effort: never fails the block save.
    expect(ACTIONS).toMatch(/\/\/ UI default only; the block row already saved\./);
  });

  it("changing the toggle still updates the draft and the save payload", () => {
    expect(FORM).toMatch(/update\("machineFrequency", selected \? "" : \(f as string\)\)/);
    expect(FORM).toMatch(/machineFrequency: \(draft\.machineFrequency \|\| null\) as/);
  });

  it("existing saved values and null/legacy records still render safely", () => {
    expect(FORM).toMatch(/machineFrequency: block\.machine_frequency \?\? ""/);
  });

  it("copy-settings still carries machine frequency (within-session and from last session)", () => {
    expect(FORM).toMatch(/machineFrequency: source\.machine_frequency \?\? ""/);
    expect(ACTIONS).toMatch(
      /minutes_performed, machine_frequency, probe_key/,
    );
  });

  it("migration 0084 is additive and nullable (no backfill, old rows unaffected)", () => {
    expect(MIGRATION).toMatch(
      /add column if not exists default_machine_frequency text/,
    );
    expect(MIGRATION).toMatch(/default_machine_frequency is null/);
    expect(MIGRATION).not.toMatch(/not null/i);
    expect(MIGRATION).not.toMatch(/update public\./);
    expect(MIGRATION).not.toMatch(/drop column/);
  });
});

// ---------------------------------------------------------------------------
// 2. Reaction chips get plus signs
// ---------------------------------------------------------------------------

describe("reaction/response chips match the observation chips", () => {
  const obsRegion = FORM.slice(
    FORM.indexOf(">Treatment observations<"),
    FORM.indexOf('placeholder="Tap a chip or type a note"'),
  );

  it("reaction chips render with a leading +", () => {
    expect(obsRegion).toMatch(/\+ \{reactionTypeLabel\(r\)\}/);
    // The observation chips keep theirs too.
    expect(obsRegion).toMatch(/\+ \{c\}/);
  });

  it("no plain non-plus reaction label remains in the chip list", () => {
    expect(obsRegion).not.toMatch(/>\s*\{reactionTypeLabel\(r\)\}/);
  });

  it("selection behavior is unchanged: single-select toggle on reaction_type", () => {
    expect(obsRegion).toMatch(/aria-pressed=\{draft\.reactionType === r\}/);
    expect(obsRegion).toMatch(
      /update\("reactionType", draft\.reactionType === r \? "" : r\)/,
    );
    expect(FORM).not.toMatch(/<select[\s\S]{0,200}reactionType/);
  });
});

// ---------------------------------------------------------------------------
// 3. Sessions tab Watch/Plan pre-client source (pure helper, behavioral)
// ---------------------------------------------------------------------------

type Candidate = { id: string; next_session_note?: string | null };

function blocksMap(
  entries: Array<[string, Array<{ caution_for_next_session: boolean; caution_note: string | null }>]>,
) {
  return new Map(entries);
}

describe("pickPreClientWatchPlanSource", () => {
  it("a newer charted session WITHOUT notes does not hide older guidance", () => {
    const newerCharted: Candidate = { id: "new", next_session_note: null };
    const olderWithNote: Candidate = {
      id: "old",
      next_session_note: "Start lower on upper lip.",
    };
    expect(
      pickPreClientWatchPlanSource([newerCharted, olderWithNote], blocksMap([])),
    ).toBe(olderWithNote);
  });

  it("the newest session WITH a note wins over older ones", () => {
    const a: Candidate = { id: "a", next_session_note: "newest plan" };
    const b: Candidate = { id: "b", next_session_note: "older plan" };
    expect(pickPreClientWatchPlanSource([a, b], blocksMap([]))).toBe(a);
  });

  it("area-level caution data qualifies a session even without a note", () => {
    const newerEmpty: Candidate = { id: "new", next_session_note: null };
    const olderCaution: Candidate = { id: "old", next_session_note: null };
    const map = blocksMap([
      ["old", [{ caution_for_next_session: true, caution_note: null }]],
    ]);
    expect(pickPreClientWatchPlanSource([newerEmpty, olderCaution], map)).toBe(
      olderCaution,
    );
  });

  it("whitespace-only notes do not qualify; no content anywhere returns null", () => {
    const a: Candidate = { id: "a", next_session_note: "   " };
    const b: Candidate = { id: "b", next_session_note: null };
    expect(pickPreClientWatchPlanSource([a, b], blocksMap([]))).toBeNull();
  });
});

describe("Sessions tab wiring", () => {
  it("the band renders the pre-client context, attached, exactly once", () => {
    const tab = CLIENT_PAGE.slice(
      CLIENT_PAGE.indexOf('{activeTab === "sessions"'),
      CLIENT_PAGE.indexOf('{activeTab === "treatment"'),
    );
    expect(CLIENT_PAGE).toMatch(
      /pickPreClientWatchPlanSource\(\s*\n?\s*recentSessions/,
    );
    expect(tab).toMatch(
      /<FromLastVisitForToday[\s\S]{0,60}summary=\{preClientWatchPlan\}[\s\S]{0,40}attached/,
    );
    expect(tab.match(/<FromLastVisitForToday/g)?.length).toBe(1);
    // Omitted cleanly when no content anywhere.
    expect(tab).toMatch(/hasFromLastVisitContent\(preClientWatchPlan\)/);
    // Area summaries still come from the last charted treatment.
    expect(tab).toMatch(/<AreaSummaries summary=\{lastTreatmentSummary\}/);
  });
});
