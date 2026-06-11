import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #190 (clinical memory). Pins the next-session-note loop: saved
// on the session being charted, surfaced on the client's NEXT
// charting screen and in both previous-session context surfaces.

const ROOT = path.resolve(__dirname, "../../..");
const SESSION_ACTIONS = readFileSync(
  path.join(ROOT, "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts"),
  "utf8",
);
const SESSION_PAGE = readFileSync(
  path.join(ROOT, "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx"),
  "utf8",
);
const NEW_SESSION_PAGE = readFileSync(
  path.join(ROOT, "app/(app)/clients/[id]/sessions/new/page.tsx"),
  "utf8",
);
const APPOINTMENT_PAGE = readFileSync(
  path.join(ROOT, "app/(app)/calendar/[id]/page.tsx"),
  "utf8",
);

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

describe("capture: updateNextSessionNoteAction", () => {
  const CODE = codeOnly(SESSION_ACTIONS);

  it("writes sessions.next_session_note scoped to the studio", () => {
    expect(CODE).toMatch(
      /\.update\(\{ next_session_note: note \}\)\s*\n?\s*\.eq\("id", sessionId\)\s*\n?\s*\.eq\("studio_id", studio\.id\)/,
    );
  });

  it("verifies session visibility before writing", () => {
    const body = CODE.slice(
      CODE.indexOf("export async function updateNextSessionNoteAction"),
      CODE.indexOf("export async function updateSessionPerformerAction"),
    );
    const visIdx = body.indexOf("assertSessionVisible(studio.id, clientId, sessionId)");
    const writeIdx = body.indexOf("next_session_note: note");
    expect(visIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(visIdx);
  });

  it("empty input clears the note (nullableString)", () => {
    expect(CODE).toMatch(
      /const note = nullableString\(formData\.get\("next_session_note"\)\);/,
    );
  });
});

describe("capture surface: session detail page", () => {
  const NOTE_FORM = readFileSync(
    path.join(
      ROOT,
      "app/(app)/clients/[id]/sessions/[sessionId]/NextVisitNoteForm.tsx",
    ),
    "utf8",
  );

  it("renders the For next visit form bound to the action (renamed in PR #194)", () => {
    expect(SESSION_PAGE).toMatch(/>For next visit</);
    expect(SESSION_PAGE).toMatch(/action=\{updateNextSessionNoteAction\}/);
    expect(SESSION_PAGE).toMatch(
      /initialNote=\{session\.next_session_note \?\? ""\}/,
    );
  });

  it("the field is the ONE next-visit surface (PR #199 copy)", () => {
    expect(SESSION_PAGE).toMatch(
      /Anything to remember, watch, or do differently next time\./,
    );
    expect(NOTE_FORM).toMatch(/Upper lip: start lower and check sensitivity/);
  });

  it("PR #191: saving shows explicit saved / cleared / error feedback", () => {
    expect(NOTE_FORM).toMatch(/Saved just now\./);
    expect(NOTE_FORM).toMatch(/Note cleared\./);
    expect(NOTE_FORM).toMatch(/Unsaved changes/);
    expect(NOTE_FORM).toMatch(/role="alert"/);
    expect(NOTE_FORM).toMatch(/\{pending \? "Saving…" : "Save note"\}/);
  });

  it("PR #191: the action returns a result so failures surface in the form", () => {
    const CODE = codeOnly(SESSION_ACTIONS);
    expect(CODE).toMatch(/Promise<NextSessionNoteResult>/);
    expect(CODE).toMatch(
      /return \{ ok: false, error: "Could not save the note\. Try again\." \};/,
    );
    expect(CODE).toMatch(/return \{ ok: true, cleared: note === null \};/);
  });
});

describe("surfacing: the latest previous note appears when charting", () => {
  it("session detail queries the most recent PREVIOUS session with a note", () => {
    const CODE = codeOnly(SESSION_PAGE);
    expect(CODE).toMatch(
      /\.not\("next_session_note", "is", null\)\s*\n?\s*\.lt\("started_at", session\.started_at\)\s*\n?\s*\.order\("started_at", \{ ascending: false \}\)\s*\n?\s*\.limit\(1\)/,
    );
  });

  it("renders the From last visit banner only when a note exists", () => {
    expect(SESSION_PAGE).toMatch(/\{fromLastVisit && \(/);
    expect(SESSION_PAGE).toMatch(/From last visit, for today/);
  });

  it("new-session page surfaces the previous note inside the context panel", () => {
    expect(NEW_SESSION_PAGE).toMatch(/Previous session context/);
    expect(NEW_SESSION_PAGE).toMatch(
      /<FromLastVisitForToday summary=\{previousSummary\} \/>/,
    );
  });

  it("new-session panel renders nothing for first-visit clients", () => {
    expect(NEW_SESSION_PAGE).toMatch(/\{previousSummary && previousMeta && \(/);
  });

  it("appointment detail card surfaces the note via the shared summary", () => {
    expect(APPOINTMENT_PAGE).toMatch(/<FromLastVisitForToday summary=\{summary\} \/>/);
    expect(APPOINTMENT_PAGE).toMatch(/buildLastSessionSummary\(\{/);
  });
});

describe("shared summary usage (both context surfaces)", () => {
  it("new-session page and appointment page both use the tested helper", () => {
    for (const page of [NEW_SESSION_PAGE, APPOINTMENT_PAGE]) {
      expect(page).toMatch(
        /from "@\/lib\/sessions\/clinical-summary"/,
      );
    }
  });

  it("both surfaces render per-area summaries via the shared component (PR #191)", () => {
    for (const page of [NEW_SESSION_PAGE, APPOINTMENT_PAGE]) {
      expect(page).toMatch(/from "@\/components\/last-session-summary"/);
      expect(page).toMatch(/<AreaSummaries summary=\{/);
    }
  });

  it("blocks are read with a narrow select scoped to studio + session, deleted excluded", () => {
    const CODE = codeOnly(APPOINTMENT_PAGE);
    expect(CODE).toMatch(
      /\.from\("session_blocks"\)[\s\S]{0,400}\.eq\("studio_id", studio\.id\)[\s\S]{0,100}\.eq\("session_id", lastSession\.id\)[\s\S]{0,100}\.is\("deleted_at", null\)/,
    );
  });
});
