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

  it("appointment detail card surfaces the note via the shared prep model", () => {
    // Session 1D: the appointment page moved from the COMPACT summary
    // (buildLastSessionSummary → FromLastVisitForToday) to the full appointment
    // prep model, which carries the same note as its own labelled section
    // rather than folded into a combined watch/plan band. The loop this file
    // pins — written while charting, read before the next visit — is unchanged;
    // only the surface that reads it is richer.
    // The mapping moved once more, into the historical authority's own adapter
    // (lib/sessions/history/visit-summary.ts), where every evidence channel is a
    // REQUIRED parameter. The page must no longer build the model at all: the
    // builder's input marks four channels optional, so a page-side build can
    // drop a laser visit's narrative or a legacy visit's passes silently.
    //
    // The LOOP this file pins — written while charting, read before the next
    // visit — is unchanged; the note now reaches the page through the same
    // authority that chose the visit.
    expect(codeOnly(APPOINTMENT_PAGE)).not.toMatch(/buildAppointmentPrepMemory\(/);
    expect(codeOnly(APPOINTMENT_PAGE)).toMatch(/prepNarrative = visitPrep\.narrative/);
    const ADAPTER = readFileSync(
      path.join(ROOT, "lib/sessions/history/visit-summary.ts"),
      "utf8",
    );
    expect(ADAPTER).toMatch(/next_session_note: args\.session\.next_session_note/);
    // ...and the plan passthrough is pinned where it now lives — the shared
    // mapper — so it protects the dashboard's copy of this surface too.
    expect(
      readFileSync(path.join(ROOT, "lib/sessions/appointment-prep-memory.ts"), "utf8"),
    ).toMatch(/next_session_note: selected\.session\.next_session_note \?\? null/);
    const CARD = readFileSync(
      path.join(ROOT, "components/appointment-prep-memory-card.tsx"),
      "utf8",
    );
    expect(CARD).toMatch(/notes\.forNextVisit/);
    // And the label is the shared one, not a new literal on the card.
    const MODEL = readFileSync(
      path.join(ROOT, "lib/sessions/appointment-prep-memory.ts"),
      "utf8",
    );
    expect(MODEL).toMatch(/next_session_note: "For next visit"/);
  });
});

describe("shared helper usage (both context surfaces)", () => {
  // Session 1D split these two surfaces on PURPOSE. /sessions/new is the
  // five-second recap immediately before charting and keeps the compact
  // summary; the appointment page is the full pre-visit read and uses the prep
  // model. What must stay true of BOTH is that neither re-derives the clinical
  // vocabulary or the "which session was the last treatment" rule.
  it("the new-session page still uses the compact shared summary", () => {
    expect(NEW_SESSION_PAGE).toMatch(/from "@\/lib\/sessions\/clinical-summary"/);
    expect(NEW_SESSION_PAGE).toMatch(/from "@\/components\/last-session-summary"/);
    expect(NEW_SESSION_PAGE).toMatch(/<AreaSummaries summary=\{/);
  });

  it("the appointment page uses the shared prep model and card", () => {
    expect(APPOINTMENT_PAGE).toMatch(
      /from "@\/lib\/sessions\/appointment-prep-memory"/,
    );
    expect(APPOINTMENT_PAGE).toMatch(
      /from "@\/components\/appointment-prep-memory-card"/,
    );
    expect(APPOINTMENT_PAGE).toMatch(/<AppointmentPrepMemoryCard/);
  });

  it("BOTH surfaces select the last treatment through the ONE shared authority", () => {
    // This is the invariant that actually matters, and it is stronger than the
    // pin it replaces: neither page decides for itself what a prior treatment
    // is, and neither can drift from the live charting screen.
    // The appointment page is migrated to the historical authority; the
    // new-session page follows in its own commit, with its own browser proof.
    // Until then this pins BOTH halves honestly rather than pretending.
    expect(APPOINTMENT_PAGE).toMatch(/loadVisitPreparation\(\{/);
    expect(APPOINTMENT_PAGE).toMatch(/from "@\/lib\/sessions\/history\/prepare-visit"/);
    expect(NEW_SESSION_PAGE).toMatch(/loadLastChartedTreatment\(\{/);
    expect(NEW_SESSION_PAGE).toMatch(/from "@\/lib\/sessions\/last-treatment-loader"/);
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
