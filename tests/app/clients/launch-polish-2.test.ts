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

describe("5. whole-session copy is TEMPORARILY CONTAINED (zero writes)", () => {
  const action = codeOnly(BLOCK_ACTIONS).slice(
    codeOnly(BLOCK_ACTIONS).indexOf(
      "export async function copyPreviousSessionAreasAction",
    ),
    codeOnly(BLOCK_ACTIONS).indexOf("export type SoftDeleteBlockInput"),
  );

  it("keeps the authenticated + current-session lineage checks", () => {
    expect(action).toContain("getCurrentPractitionerWithStudio()");
    expect(action).toContain(
      "assertSessionForClient(studio.id, input.clientId, input.sessionId)",
    );
    expect(action).toContain("Inactive practitioners cannot log sessions.");
  });

  it("returns a fixed unavailable result and performs ZERO writes/reads of the source", () => {
    expect(action).toMatch(
      /Copy all areas from last session is temporarily unavailable/,
    );
    // No source-session lookup, no session_blocks read/insert, no revalidate.
    expect(action).not.toContain("createClient(");
    expect(action).not.toContain('.from("session_blocks")');
    expect(action).not.toContain('.from("sessions")');
    expect(action).not.toContain(".insert(");
    expect(action).not.toContain("copiedCount");
    expect(action).not.toContain("previousSessionId)"); // never dereferenced
  });

  it("the control is a NON-INTERACTIVE notice, it never calls the action", () => {
    expect(COPY_BUTTON).not.toContain("copyPreviousSessionAreasAction");
    expect(COPY_BUTTON).not.toContain('"use client"');
    expect(COPY_BUTTON).not.toContain("onClick");
    expect(COPY_BUTTON).toMatch(/Temporarily unavailable/);
    expect(COPY_BUTTON).toMatch(/Copy settings/); // points to the safe in-form path
    // Never implies data loss.
    expect(COPY_BUTTON).not.toMatch(/lost|deleted|removed your/i);
  });

  it("the draft-model copy panel (0157) renders only on an empty electrolysis chart with a canonical eligible source", () => {
    // Migration 0157 replaced the paused one-tap copy with the ephemeral editable
    // preview panel (CopyPreviousAreasPanel), gated on the CANONICAL source
    // descriptor (same authority the commit RPC derives its source from).
    expect(SESSION_PAGE).toMatch(
      /blockData\.blocks\.length === 0 &&\s*\n?\s*canCopyFromPrevious && \(/,
    );
    expect(SESSION_PAGE).toMatch(/<CopyPreviousAreasPanel/);
    expect(SESSION_PAGE).toMatch(/whole_session_copy_source_descriptor/);
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
