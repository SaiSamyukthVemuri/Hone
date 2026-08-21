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
const SNAPSHOT = read("lib/sessions/treatment-setup-snapshot.ts");
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

/**
 * The page with COMMENTS REMOVED.
 *
 * These files explain at length which call sites were retired and why, so a
 * guard matching raw text cannot tell a rationale from a call — and would
 * punish recording the reason, which is how a guard quietly becomes a reason
 * not to document anything.
 */
function codeOnlyClientPage(): string {
  return CLIENT_PAGE
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("machine frequency: tap toggle with a sticky last-used default", () => {
  it("renders as a tap-friendly two-value toggle (no free text input)", () => {
    // PR #204 moved Probe (and PR #205 added its lot input) between
    // frequency and Mode; slice only the frequency section.
    const region = FORM.slice(
      FORM.indexOf(">Machine frequency<"),
      FORM.indexOf(">Probe<"),
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
    // Best-effort: never fails the block save. 0178 moved the write from the
    // ADMIN client to a governed auth.uid()-bound command — the entitlement is
    // identical, the service-role bypass is gone — and the swallow is preserved
    // verbatim because a preference failure must never roll back a successful
    // clinical write.
    expect(ACTIONS).toMatch(/set_own_default_machine_frequency/);
    expect(ACTIONS).not.toMatch(/createAdminClient/);
    expect(ACTIONS).toMatch(/BEST EFFORT, deliberately unchanged/);
  });

  it("changing the toggle still updates the draft and the save payload", () => {
    expect(FORM).toMatch(/update\("machineFrequency", selected \? "" : \(f as string\)\)/);
    expect(FORM).toMatch(/machineFrequency: \(draft\.machineFrequency \|\| null\) as/);
  });

  it("existing saved values and null/legacy records still render safely", () => {
    expect(FORM).toMatch(/machineFrequency: block\.machine_frequency \?\? ""/);
  });

  it("copy-settings still carries machine frequency (in-form, via the shared contract)", () => {
    // In-form copy carries machine frequency via the shared snapshot contract.
    // The whole-session action is temporarily contained (writes nothing), so it
    // no longer selects/copies these columns at all.
    expect(FORM).toMatch(/buildTreatmentSetupDraftPatch\(source, firstEntry, linkable\)/);
    expect(SNAPSHOT).toMatch(/machineFrequency: block\.machine_frequency \?\? ""/);
    expect(ACTIONS).toMatch(/copyPreviousSessionAreasAction/);
    expect(ACTIONS).toMatch(/temporarily unavailable/);
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

describe("merged observation & reaction chips render consistently", () => {
  // Charting unification: observations and the client/skin response are now ONE
  // merged multi-select box. Reaction labels are part of MERGED_OBSERVATION_CHIPS,
  // so they render exactly like observation chips. Anchor on the unified box.
  const box = FORM.slice(
    FORM.indexOf("{OBSERVATIONS_RESPONSE_HEADING}"),
    FORM.indexOf("save-treatment-area"),
  );

  it("every merged chip (including reaction labels) renders with a leading + when unselected", () => {
    // Unselected chips show `+ ${c}`; selected show the bare label. This applies to
    // the whole merged vocabulary (observation presets + reaction labels).
    expect(box).toMatch(/MERGED_OBSERVATION_CHIPS\.map/);
    expect(box).toMatch(/selected \? c : `\+ \$\{c\}`/);
    // The old separate single-select reaction row (`+ {reactionTypeLabel(r)}`) is gone.
    expect(FORM).not.toMatch(/\+ \{reactionTypeLabel\(r\)\}/);
  });

  it("no bare reaction chip renders outside the unified multi-select box", () => {
    // No standalone REACTION_TYPES chip row remains.
    expect(FORM).not.toMatch(/REACTION_TYPES\.map/);
    expect(FORM).not.toMatch(/reactionTypeLabel\(r\)/);
  });

  it("selection is a MULTI-select toggle on observationChips (reaction folded in), not single-select on reaction_type", () => {
    // Reactions toggle exactly like observation chips, via observationChips.
    expect(box).toMatch(/aria-pressed=\{selected\}/);
    expect(box).toMatch(
      /update\("observationChips", toggleFindingChip\(draft\.observationChips, c\)\)/,
    );
    // The old single-select reaction toggle is gone.
    expect(FORM).not.toMatch(/aria-pressed=\{draft\.reactionType === r\}/);
    expect(FORM).not.toMatch(
      /update\("reactionType", draft\.reactionType === r \? "" : r\)/,
    );
    // No reaction <select> dropdown either.
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
    // The watch/plan visit is chosen by the authority and its own record comes
    // back with it, so the page renders a DIFFERENT visit's blocks without
    // fetching them — which is how an eighth clinical projection would have
    // been born.
    expect(CLIENT_PAGE).toMatch(/clientPrep\.watchPlanVisit/);
    expect(codeOnlyClientPage()).not.toMatch(/\bpickPreClientWatchPlanSource\b/);
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
