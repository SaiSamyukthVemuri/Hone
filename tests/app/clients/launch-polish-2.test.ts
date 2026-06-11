import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #194. Pins for Chloe's launch-polish round 2: treatment time
// tracker framing, collapsible session groups, shared last-session
// summary, copy-from-last-session, price wording, allergies-first
// overview, birthday year, calendar today contrast.

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const TTT = read("components/treatment-time-card.tsx");
const TIMELINE = read("components/client-appointment-timeline.tsx");
const CLIENT_PAGE = read("app/(app)/clients/[id]/page.tsx");
const SESSION_PAGE = read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx");
const BLOCK_ACTIONS = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
);
const COPY_BUTTON = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/CopyPreviousAreasButton.tsx",
);
const INFO_CARD = read("components/session-performer-line.tsx");
const ATTACHMENT = read("components/treatment-plan-attachment.tsx");
const BIRTHDAY_ACTION = read("app/(app)/clients/[id]/birthday-actions.ts");
const BIRTHDAY_CARD = read("components/client-birthday-card.tsx");
const CALENDAR_PAGE = read("app/(app)/calendar/page.tsx");
const DAY_COLUMN = read("app/(app)/calendar/DayColumn.tsx");

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

describe("2. treatment time tracker, not a goal surface", () => {
  it("retitled with tracker copy and a pointer to Treatment Plans", () => {
    expect(TTT).toMatch(/Total electrolysis treatment time/);
    expect(TTT).toMatch(/Time tracked from charted sessions/);
    expect(TTT).toMatch(/Treatment goals live in\s*\n?\s*Treatment Plans/);
  });

  it("goal-setting UI hides unless a goal already exists", () => {
    expect(TTT).toMatch(/\{goal && \(\s*\n?\s*<GoalSection/);
  });
});

describe("3 + 4. collapsible session groups", () => {
  it("only Needs charting is expanded by default", () => {
    expect(TIMELINE).toMatch(
      /const openByDefault = group\.key === "needsCharting";/,
    );
    expect(TIMELINE).toMatch(/<details open=\{openByDefault\}/);
  });

  it("cancelled and no-shows merge into one labeled group", () => {
    expect(TIMELINE).toMatch(/Cancelled and no-shows/);
    expect(TIMELINE).toMatch(
      /cancelledGroup\.rows\.push\(\.\.\.noShowGroup\.rows\);/,
    );
  });

  it("history is unified (PR #197): timeline History group + walk-in fallback only", () => {
    // "Charted" and "Session history" merged; the appointment
    // timeline's History group is the single history surface.
    expect(CLIENT_PAGE).not.toMatch(/>All sessions</);
    expect(CLIENT_PAGE).not.toMatch(/>\s*Session history/);
    expect(CLIENT_PAGE).toMatch(/Sessions without an appointment/);
    expect(CLIENT_PAGE).toMatch(/sess\.appointment_id == null/);
  });
});

describe("5. copy areas and settings from last session", () => {
  const action = codeOnly(BLOCK_ACTIONS).slice(
    codeOnly(BLOCK_ACTIONS).indexOf(
      "export async function copyPreviousSessionAreasAction",
    ),
    codeOnly(BLOCK_ACTIONS).indexOf("export type SoftDeleteBlockInput"),
  );

  it("copies area identity, settings, and the structured probe", () => {
    for (const f of [
      "block_name: b.block_name",
      "primary_area: b.primary_area",
      "mode: b.mode",
      "energy_level: b.energy_level",
      "minutes_performed: b.minutes_performed",
      "machine_frequency: b.machine_frequency",
      "probe_key: b.probe_key",
      "probe_label: b.probe_label",
    ]) {
      expect(action).toContain(f);
    }
  });

  it("never copies the previous client response", () => {
    expect(action).not.toMatch(
      /tolerance_rating:|reaction_type:|reaction_notes:|caution_for_next_session:|caution_note:/,
    );
  });

  it("refuses when the current session already has areas (no duplication)", () => {
    expect(action).toMatch(/\(existingCount \?\? 0\) > 0/);
    expect(action).toMatch(/already has treatment areas/);
  });

  it("validates the previous session belongs to the same studio and client", () => {
    expect(action).toMatch(
      /\.eq\("id", input\.previousSessionId\)\s*\n?\s*\.eq\("studio_id", studio\.id\)\s*\n?\s*\.eq\("client_id", input\.clientId\)/,
    );
  });

  it("handles a previous session with nothing to copy", () => {
    expect(action).toMatch(/has no treatment areas to copy/);
  });

  it("the button renders only on an empty electrolysis chart with a previous session that HAS areas", () => {
    expect(SESSION_PAGE).toMatch(
      /blockData\.blocks\.length === 0 &&\s*\n?\s*previousSessionAny &&\s*\n?\s*previousSessionHasAreas && \(/,
    );
    expect(SESSION_PAGE).toMatch(/previousSessionHasAreas = \(count \?\? 0\) > 0;/);
    expect(COPY_BUTTON).toMatch(/Copy areas and settings from last session/);
    expect(COPY_BUTTON).toMatch(/Copied \{result\.copiedCount\} treatment/);
    expect(COPY_BUTTON).toMatch(/Review and adjust before saving/);
  });
});

describe("7 + 8. plan card and price wording", () => {
  it("attached state is detach-only; the banner carries plan identity", () => {
    expect(ATTACHMENT).toMatch(/Detach from this plan/);
    expect(ATTACHMENT).not.toMatch(/Treatment plan:<\/span>/);
  });

  it("the redundant session-number line hides when a plan is attached", () => {
    expect(SESSION_PAGE).toMatch(/\{runningTotal && !attachedPlan && \(/);
  });

  it("PR #198: the price block left the session header entirely", () => {
    expect(INFO_CARD).not.toMatch(/Price paid/);
    expect(INFO_CARD).not.toMatch(/Add session price/);
    expect(CLIENT_PAGE).toMatch(/Session price \$\{formatPrice/);
    expect(CLIENT_PAGE).not.toMatch(/\)\} paid`/);
  });
});

describe("10. allergies first, messages collapsed", () => {
  it("PR #197: messages left Overview entirely for their own tab", () => {
    const overview = CLIENT_PAGE.slice(
      CLIENT_PAGE.indexOf('{activeTab === "overview"'),
      CLIENT_PAGE.indexOf('{activeTab === "messages"'),
    );
    expect(overview.indexOf("Allergies")).toBeGreaterThan(-1);
    expect(overview).not.toMatch(/<PortalMessagesCard/);
    const messagesTab = CLIENT_PAGE.slice(
      CLIENT_PAGE.indexOf('{activeTab === "messages"'),
    );
    expect(messagesTab).toMatch(/<PortalMessagesCard/);
  });
});

describe("11. birthday year", () => {
  it("the row still surfaces a stored real year (PR #199: display-only row; editing via the edit page)", () => {
    expect(BIRTHDAY_CARD).toMatch(/realYear/);
    expect(BIRTHDAY_CARD).toMatch(/storedYear >= 1900/);
  });

  it("the action stores a provided year, preserves an existing one when blank", () => {
    expect(BIRTHDAY_ACTION).toMatch(
      /const yearInput = parseIntOrNull\(formData\.get\("birthday_year"\)\);/,
    );
    expect(BIRTHDAY_ACTION).toMatch(
      /if \(yearInput != null\) \{\s*\n?\s*year = yearInput;\s*\n?\s*\} else if \(client\.date_of_birth\) \{/,
    );
  });

  it("display shows the year only when a real year exists", () => {
    expect(BIRTHDAY_CARD).toMatch(/\{realYear \? `, \$\{realYear\}` : ""\}/);
  });
});

describe("13. calendar today contrast", () => {
  it("today's header uses a stronger tint plus an accent bar", () => {
    expect(CALENDAR_PAGE).toMatch(/border-t-\[3px\] border-t-sky-600 bg-sky-200/);
  });

  it("today's column wash is stronger than the old 50/70 tint", () => {
    expect(DAY_COLUMN).toMatch(/bg-sky-200\/60 dark:bg-sky-900\/40/);
    expect(DAY_COLUMN).not.toMatch(/bg-sky-50\/70/);
  });
});

describe("9 + back-nav regressions hold", () => {
  it("For next visit heading replaces Plan for next visit", () => {
    expect(SESSION_PAGE).toMatch(/>For next visit</);
    expect(SESSION_PAGE).not.toMatch(/>Plan for next visit</);
  });

  it("back links to the Sessions tab still present", () => {
    expect(SESSION_PAGE).toMatch(/\?tab=sessions/);
  });

  it("client page Last session uses the shared summary components", () => {
    expect(CLIENT_PAGE).toMatch(/<AreaSummaries summary=\{lastTreatmentSummary\}/);
    expect(CLIENT_PAGE).toMatch(
      /<FromLastVisitForToday[\s\S]{0,40}summary=\{preClientWatchPlan\}/,
    );
  });
});
