import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #191. Pins for the treatment-memory UX cleanup driven by
// Chloe's practitioner smoke: no auto-filled area on a new treatment
// area, area-aware settings copy, and Sessions tab order.

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const FORM = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
);
const BLOCKS_VIEW = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx",
);
const CLIENT_PAGE = read("app/(app)/clients/[id]/page.tsx");
const TIMELINE = read("components/client-appointment-timeline.tsx");

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

describe("2. copy settings: area-aware", () => {
  const copyFn = codeOnly(FORM).slice(
    codeOnly(FORM).indexOf("function copySettings"),
    codeOnly(FORM).indexOf("function submit"),
  );

  it("prefers the most recent saved area matching the selected area", () => {
    expect(copyFn).toMatch(/wantedArea/);
    expect(copyFn).toMatch(
      /\(b\.primary_area \?\? ""\)\.trim\(\)\.toLowerCase\(\) === wantedArea/,
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
});
