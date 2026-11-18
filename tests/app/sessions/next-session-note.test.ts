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

  it("writes sessions.next_session_note through the studio-scoped command", () => {
    // L18 Phase 3: the studio is no longer supplied by the caller at all — the
    // command DERIVES it from the session, which is strictly stronger than the
    // old .eq("studio_id", studio.id) scoping it replaces.
    expect(CODE).toMatch(/rpc\("set_next_session_note"/);
    expect(CODE).toMatch(/p_session_id: sessionId/);
    expect(CODE).toMatch(/p_client_id: clientId/);
    expect(CODE).toMatch(/p_note: note/);
    const MIGRATION = readFileSync(
      "supabase/migrations/0167_session_write_commands.sql",
      "utf8",
    );
    expect(MIGRATION).toMatch(/set next_session_note = p_note/);
    expect(MIGRATION).toMatch(/and s\.studio_id = v_studio_id/);
  });

  it("verifies session visibility before writing", () => {
    const body = CODE.slice(
      CODE.indexOf("export async function updateNextSessionNoteAction"),
      CODE.indexOf("export async function updateSessionPerformerAction"),
    );
    const visIdx = body.indexOf("assertSessionVisible(studio.id, clientId, sessionId)");
    const writeIdx = body.indexOf('rpc("set_next_session_note"');
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
    // HON-10: the query moved into the loader the page calls, and gained the
    // id tie-break.
    expect(codeOnly(SESSION_PAGE)).toMatch(/loadPreviousVisitNote\(\{[\s\S]*?before: session\.started_at/);
    const CODE = codeOnly(readFileSync(path.join(process.cwd(), "lib/sessions/previous-visit-note.ts"), "utf8"));
    expect(CODE).toMatch(
      /\.not\("next_session_note", "is", null\)\s*\n?\s*\.lt\("started_at", input\.before\)\s*\n?\s*\.order\("started_at", \{ ascending: false \}\)\s*\n?\s*\.order\("id", \{ ascending: false \}\)\s*\n?\s*\.limit\(/,
    );
  });
});

describe("shared helper usage (both context surfaces)", () => {
  // Session 1D split these two surfaces on PURPOSE. /sessions/new is the
  // five-second recap immediately before charting and keeps the compact
  // summary; the appointment page is the full pre-visit read and uses the prep
  // model. What must stay true of BOTH is that neither re-derives the clinical
  // vocabulary or the "which session was the last treatment" rule.

  it("BOTH surfaces select the last treatment through the ONE shared authority", () => {
    // This is the invariant that actually matters, and it is stronger than the
    // pin it replaces: neither page decides for itself what a prior treatment
    // is, and neither can drift from the live charting screen.
    expect(NEW_SESSION_PAGE).toMatch(/loadLastChartedTreatment\(\{/);
    expect(APPOINTMENT_PAGE).toMatch(/loadLastChartedTreatmentForClient\(\{/);
    for (const page of [NEW_SESSION_PAGE, APPOINTMENT_PAGE]) {
      expect(page).toMatch(/from "@\/lib\/sessions\/last-treatment-loader"/);
    }
  });

  it("blocks are read with a narrow select scoped to studio, batched, deleted excluded", () => {
    // The read moved OFF the page and into the shared loader, where it became
    // one batched `.in("session_id", …)` over the whole candidate window
    // instead of one `.eq("session_id", …)` for a single guessed row.
    const CODE = codeOnly(APPOINTMENT_PAGE);
    expect(CODE).not.toMatch(/\.from\("session_blocks"\)/);
    const LOADER = readFileSync(
      path.join(ROOT, "lib/sessions/last-treatment-loader.ts"),
      "utf8",
    );
    expect(LOADER).toMatch(
      /\.from\("session_blocks"\)[\s\S]{0,400}\.eq\("studio_id", studioId\)[\s\S]{0,120}\.in\(\s*"session_id",[\s\S]{0,160}\.is\("deleted_at", null\)/,
    );
  });
});
