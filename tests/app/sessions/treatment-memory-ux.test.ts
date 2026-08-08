import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #191. Pins for the treatment-memory UX cleanup driven by
// Chloe's practitioner smoke: no auto-filled area on a new treatment
// area, full + area-aware settings copy, one combined From last
// visit box, bucketed form sections, Sessions tab order, and back
// navigation to the Sessions tab.

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const FORM = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
);
// Charting polish: heading/helper copy lives in a shared single-source module
// used by every charting form + the saved-record display.
const LABELS = read("lib/sessions/charting-labels.ts");
const SNAPSHOT = read("lib/sessions/treatment-setup-snapshot.ts");
const BLOCKS_VIEW = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx",
);
const SESSION_PAGE = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
);
const NEW_SESSION_PAGE = read("app/(app)/clients/[id]/sessions/new/page.tsx");
const APPOINTMENT_PAGE = read("app/(app)/calendar/[id]/page.tsx");
const CLIENT_PAGE = read("app/(app)/clients/[id]/page.tsx");
const TIMELINE = read("components/client-appointment-timeline.tsx");
const SUMMARY_COMPONENT = read("components/last-session-summary.tsx");

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\/|^\s*\{?\/\*|^\s*\*/.test(line))
    .join("\n");
}

describe("1. a new treatment area never auto-copies the previous area", () => {
  it("the plan-area seed applies only when the session has no areas yet", () => {
    expect(BLOCKS_VIEW).toMatch(
      /defaultPrimaryArea=\{blocks\.length === 0 \? defaultPrimaryArea : null\}/,
    );
  });

  it("the create draft never seeds the area from the previous block", () => {
    // initialDraft's only area seed is the (plan-derived) default.
    const initial = FORM.slice(
      FORM.indexOf("function initialDraft"),
      FORM.indexOf("export function BlockSetupForm"),
    );
    // Migration 0128: the create draft seeds ONLY from the plan-derived default
    // (into both the legacy primaryArea and the structured areas set); never from
    // the previous block.
    expect(initial).toMatch(/const seed = defaultPrimaryArea\?\.trim\(\) \|\| ""/);
    expect(initial).toMatch(/primaryArea: seed/);
    expect(initial).toMatch(/areas: seed \?/);
    expect(initial).not.toMatch(/previousBlock/);
  });
});

describe("2. copy settings: full, area-aware, never the response", () => {
  const copyFn = codeOnly(FORM).slice(
    codeOnly(FORM).indexOf("function copySettings"),
    codeOnly(FORM).indexOf("function submit"),
  );

  it("copies every treatment setting a practitioner expects (via the shared snapshot contract)", () => {
    // copySettings now delegates to the canonical treatment-setup contract,
    // which carries the block machine settings AND the primary entry's
    // mode-gated machine readings — a superset of the old block-only copy.
    expect(copyFn).toMatch(/firstLiveEntry\(source\.electrolysis_entries\)/);
    expect(copyFn).toMatch(/buildTreatmentSetupDraftPatch\(source, firstEntry, linkable\)/);
    for (const field of [
      "mode",
      "apilusModality",
      "energyLevel",
      "probeKey",
      "machineFrequency",
      // primary-entry machine readings, now carried too:
      "thermolysisIntensityPercent",
      "thermolysisDurationSeconds",
      "galvanicMa",
      "galvanicDurationSeconds",
      "unitsOfLye",
      "pulseCount",
      "pulseDelay",
    ]) {
      expect(SNAPSHOT).toContain(`${field}:`);
    }
    // Final amendment: galvanic intensity is a RETIRED reading — it is NOT a
    // copyable setup key, so the snapshot must not emit it as a patch field.
    expect(SNAPSHOT).not.toMatch(/galvanicIntensityPercent:/);
    // Session 1C: minutes performed is an OUTCOME. The contract must emit no
    // minutes patch key AND must not read the source column. A partial removal
    // (type key deleted, builder assignment left behind, or vice versa) fails
    // here — the `toContain` loop above would have passed on either half alone.
    // Comments are stripped first: the header deliberately NAMES the rejected
    // `minutes: ""` shape as documentation, and documenting a mistake must not
    // read as committing it.
    const snapshotCode = SNAPSHOT.split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(snapshotCode).not.toMatch(/\bminutes:/);
    expect(snapshotCode).not.toMatch(/block\.minutes_performed/);
  });

  it("does NOT copy the area identity or any response field", () => {
    expect(copyFn).not.toMatch(/primaryArea:|side:|customAreaDetail:/);
    expect(copyFn).not.toMatch(
      /toleranceRating|reactionType|reactionNotes|cautionForNextSession|cautionNote/,
    );
  });

  it("prefers the most recent saved area matching the selected area", () => {
    expect(copyFn).toMatch(/wantedArea/);
    expect(copyFn).toMatch(
      /\(b\.primary_area \?\? ""\)\.trim\(\)\.toLowerCase\(\) === wantedArea/,
    );
  });

  it("shows a clear message, including the no-match case", () => {
    expect(copyFn).toMatch(/No previous treatment area to copy from\./);
    expect(copyFn).toMatch(/No earlier \$\{draft\.primaryArea\.trim\(\)\} settings/);
    expect(FORM).toMatch(/\{copyMessage && \(/);
  });

  it("the wording never implies cross-session copying (review patch)", () => {
    // The copy source is the CURRENT session only; the button and
    // every message say so. The old "from last treatment area" label
    // could read as prior-visit settings.
    expect(FORM).toMatch(/Copy settings from another area in this session/);
    expect(FORM).not.toMatch(/Copy settings from last treatment area/);
    const messages = copyFn.match(/setCopyMessage\([\s\S]*?\);/g) ?? [];
    expect(messages.length).toBeGreaterThanOrEqual(3);
    for (const m of messages.filter((x) => x.includes("Copied"))) {
      expect(m).toMatch(/in this session/);
    }
  });
});

describe("5 + 6. per-area summary and ONE combined warning box", () => {
  it("the shared component renders one mini-summary per treatment area", () => {
    expect(SUMMARY_COMPONENT).toMatch(/summary\.areas\.map\(\(area\)/);
    expect(SUMMARY_COMPONENT).toMatch(/Tolerance/);
    expect(SUMMARY_COMPONENT).toMatch(/Response/);
  });

  it("the combined box carries Watch lines AND the Plan, under one heading", () => {
    expect(SUMMARY_COMPONENT).toMatch(/From last visit, for today/);
    expect(SUMMARY_COMPONENT).toMatch(/Watch:<\/span>/);
    expect(SUMMARY_COMPONENT).toMatch(/Plan:<\/span>/);
  });

  it("no surface renders the old separate warning boxes any more", () => {
    // THE INVARIANT (PR #191): never two competing warning boxes on one
    // surface. It is unchanged; only the appointment page's implementation of
    // it moved (Session 1D).
    expect(NEW_SESSION_PAGE).not.toMatch(/Watch today/);
    expect(NEW_SESSION_PAGE).not.toMatch(/cautionFlagged/);
    expect((NEW_SESSION_PAGE.match(/<FromLastVisitForToday /g) ?? []).length).toBe(1);

    // The appointment page now renders the full prep card instead of the
    // compact combined box — so it must render NEITHER the old box nor a
    // second warning surface of its own.
    expect(APPOINTMENT_PAGE).not.toMatch(/<FromLastVisitForToday /);
    expect(APPOINTMENT_PAGE).not.toMatch(/<AreaSummaries /);
    expect(APPOINTMENT_PAGE).not.toMatch(/cautionFlagged/);
    // And the card itself carries exactly one caution band and one plan band.
    const CARD = readFileSync(
      path.join(ROOT, "components/appointment-prep-memory-card.tsx"),
      "utf8",
    );
    expect((CARD.match(/Watch today/g) ?? []).length).toBe(1);
    expect((CARD.match(/notes\.forNextVisit\.label/g) ?? []).length).toBe(1);
    expect((CARD.match(/notes\.cautions\.map/g) ?? []).length).toBe(1);
  });

  it("no misleading first-area-only labeling remains", () => {
    for (const page of [APPOINTMENT_PAGE, NEW_SESSION_PAGE]) {
      expect(page).not.toMatch(/Settings \(first area\)/);
      expect(page).not.toMatch(/blockCount/);
    }
  });

  it("practitioner-facing copy says treatment area, not block", () => {
    expect(SUMMARY_COMPONENT).not.toMatch(/>[^<]*\bblock\b[^<]*</i);
  });
});

describe("4. back navigation returns to the Sessions tab", () => {
  it("session detail and new-session back links carry ?tab=sessions", () => {
    expect(SESSION_PAGE).toMatch(/href=\{`\/clients\/\$\{id\}\?tab=sessions`\}/);
    expect(NEW_SESSION_PAGE).toMatch(
      /href=\{`\/clients\/\$\{id\}\?tab=sessions`\}/,
    );
  });
});

describe("7. bucketed charting form", () => {
  it("PR #199 order: tolerance, then observations & skin response; next visit moved to the session level", () => {
    const resp = FORM.indexOf("Client tolerance");
    // Charting unification: the observations heading is now the merged
    // "Treatment observations & skin response" box heading (shared constant).
    const obs = FORM.indexOf("{OBSERVATIONS_RESPONSE_HEADING}");
    expect(resp).toBeGreaterThan(-1);
    expect(obs).toBeGreaterThan(resp);
    // PR #199: the per-area For next visit bucket is gone; the
    // session-level note is the single next-visit surface.
    expect(FORM.indexOf(">For next visit<")).toBe(-1);
  });

  it("each bucket explains its purpose", () => {
    // Charting unification: the merged observations & skin response box uses ONE
    // helper (from the shared module) explaining both what was seen AND how the
    // skin responded.
    expect(FORM).toMatch(/\{OBSERVATIONS_RESPONSE_HELPER\}/);
    expect(LABELS).toMatch(/What you saw and how the skin responded/);
    // The shared module still defines the original per-concept helpers (used by the
    // saved-record display + the simplified form), so their wording is preserved.
    expect(LABELS).toMatch(/What you saw during treatment/);
    expect(LABELS).toMatch(/How the client's skin reacted/);
    // PR #279: tolerance bucket explainer is now the question prompt.
    expect(FORM).toMatch(/Optional\. How did the client tolerate this area\?/);
    // PR #199: the per-area For next visit bucket is consolidated into
    // the session-level note.
    expect(FORM).not.toMatch(
      /Anything to watch or do differently on this area next time\./,
    );
  });
});

describe("8. Sessions tab order (Chloe's order, verbatim)", () => {
  it("treatment time, then last session, then appointments, then history", () => {
    const sessionsTab = CLIENT_PAGE.slice(
      CLIENT_PAGE.indexOf('{activeTab === "sessions"'),
      CLIENT_PAGE.indexOf('{activeTab === "treatment"'),
    );
    const ttt = sessionsTab.indexOf("<TreatmentTimeCard");
    const last = sessionsTab.indexOf(">Last treatment</h2>");
    const timeline = sessionsTab.indexOf("<ClientAppointmentTimeline");
    // PR #194: Session history is collapsible; the heading moved into
    // the <details> summary. Search after the timeline so the intro
    // comment's mention does not match.
    const history = sessionsTab.indexOf("Session history", timeline);
    expect(ttt).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(ttt);
    expect(timeline).toBeGreaterThan(last);
    expect(history).toBeGreaterThan(timeline);
  });

  it("Needs charting renders above Upcoming in the appointment timeline", () => {
    const groupsBlock = TIMELINE.slice(
      TIMELINE.indexOf("const groups: Group[]"),
      TIMELINE.indexOf("const groupByKey"),
    );
    const needs = groupsBlock.indexOf('"needsCharting"');
    const upcoming = groupsBlock.indexOf('"upcoming"');
    expect(needs).toBeGreaterThan(-1);
    expect(upcoming).toBeGreaterThan(needs);
  });

  it("the confusing All sessions heading is renamed Session history", () => {
    expect(CLIENT_PAGE).not.toMatch(/>All sessions</);
    expect(CLIENT_PAGE).toMatch(/Session history/);
  });
});

describe("9. payment surfaces untouched", () => {
  it("the session payment card block is byte-identical in shape", () => {
    expect(SESSION_PAGE).toMatch(/<SessionPaymentPrepareCard/);
    expect(SESSION_PAGE).toMatch(/id="session-payment"/);
  });
});
