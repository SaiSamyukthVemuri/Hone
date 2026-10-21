import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildLastSessionSummary,
  pickPreClientWatchPlanSource,
} from "@/lib/sessions/clinical-summary";
import { FromLastVisitForToday } from "@/components/last-session-summary";

// HON-10 ("previous-note correctness"), the two cleared rows.
//
// ROW 7 (appointment page). The candidate read is `LIMIT 25` in SQL, and the
//   content half (void, this visit's own sessions, charted-ness) runs after it.
//   A full window with nothing charted in it proves nothing about the history
//   the LIMIT cut off, but the single-client path reported it as "none", which
//   the page renders as "No previous treatment charted for this client." The
//   batched path already reports the same shape as unavailable.
//
// ROW 3 (client overview, Sessions tab). The From-last-visit band rendered only
//   inside the charted "Last treatment" card, so a plan written on a visit that
//   was never charted vanished exactly when nothing was charted. The appointment
//   page already shows it in that case.

const STUDIO = "11111111-1111-1111-1111-111111111111";
const CLIENT = "22222222-2222-2222-2222-222222222222";
const APPOINTMENT = "33333333-3333-3333-3333-333333333333";
const APPT_STARTS_AT = "2026-08-06T14:00:00.000Z";
const DOXYCYCLINE = "Client started doxycycline, do not treat";

type Row = Record<string, unknown>;

// `n` sessions, newest first, one day apart, all before the appointment.
function sessionRows(n: number, over: (i: number) => Partial<Row> = () => ({})): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s-${String(i).padStart(3, "0")}`,
    started_at: new Date(Date.parse("2026-08-01T10:00:00.000Z") - i * 86_400_000).toISOString(),
    modality: "electrolysis",
    record_status: "draft",
    deleted_at: null,
    appointment_id: null,
    session_notes: null,
    next_session_note: null,
    electrolysis_entries: [],
    laser_entries: [],
    ...over(i),
  }));
}

type Outcome = { data: unknown; error: unknown };
let sessionsOutcome: Outcome;
let blocksOutcome: Outcome;

// Same stub shape as appointment-prep-loader-truthfulness: `limit` ends the
// candidate read, `order` ends the block read.
function makeClient() {
  const chain = (outcome: Outcome) => {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "lt", "in"]) self[m] = () => self;
    self.limit = async () => outcome;
    self.order = () => {
      const t = { ...self } as Record<string, unknown>;
      t.then = (resolve: (v: Outcome) => unknown) => resolve(outcome);
      return t;
    };
    return self;
  };
  return {
    from: (table: string) => chain(table === "sessions" ? sessionsOutcome : blocksOutcome),
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => makeClient(),
}));

const { loadLastChartedTreatmentForClient } = await import(
  "@/lib/sessions/last-treatment-loader"
);
const { DEFAULT_CHARTED_SESSION_LIMIT } = await import("@/lib/sessions/charted-session");

function load() {
  return loadLastChartedTreatmentForClient({
    studioId: STUDIO,
    clientId: CLIENT,
    before: APPT_STARTS_AT,
    excludeAppointmentId: APPOINTMENT,
  });
}

beforeEach(() => {
  sessionsOutcome = { data: [], error: null };
  blocksOutcome = { data: [], error: null };
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("HON-10 row 7: a full candidate window with nothing charted is not proof of absence", () => {
  it("25 uncharted sessions (the window is full) report UNAVAILABLE, not 'no previous treatment'", async () => {
    sessionsOutcome = { data: sessionRows(DEFAULT_CHARTED_SESSION_LIMIT), error: null };
    const r = await load();
    expect(r.treatment).toBeNull();
    expect(r.unavailable).toBe(true);
  });

  it("a full window spent on THIS visit's own sessions is unavailable too", async () => {
    sessionsOutcome = {
      data: sessionRows(DEFAULT_CHARTED_SESSION_LIMIT, () => ({ appointment_id: APPOINTMENT })),
      error: null,
    };
    const r = await load();
    expect(r.treatment).toBeNull();
    expect(r.unavailable).toBe(true);
  });

  it("the narrative already loaded survives the unavailable answer", async () => {
    sessionsOutcome = {
      data: sessionRows(DEFAULT_CHARTED_SESSION_LIMIT, (i) => (i === 3 ? { next_session_note: DOXYCYCLINE } : {})),
      error: null,
    };
    const r = await load();
    expect(r.unavailable).toBe(true);
    expect(r.narrative.plan?.text).toBe(DOXYCYCLINE);
  });

  it("control: a window that is NOT full is a genuine 'none' (unchanged)", async () => {
    sessionsOutcome = { data: sessionRows(DEFAULT_CHARTED_SESSION_LIMIT - 1), error: null };
    const r = await load();
    expect(r.treatment).toBeNull();
    expect(r.unavailable).toBe(false);
  });

  it("control: a first-visit client is a genuine 'none' (unchanged)", async () => {
    const r = await load();
    expect(r.treatment).toBeNull();
    expect(r.unavailable).toBe(false);
  });

  it("control: a full window that DOES hold a charted session still selects it", async () => {
    sessionsOutcome = {
      data: sessionRows(DEFAULT_CHARTED_SESSION_LIMIT, (i) =>
        i === 24 ? { electrolysis_entries: [{ id: "e-1", deleted_at: null, block_id: null }] } : {},
      ),
      error: null,
    };
    const r = await load();
    expect(r.unavailable).toBe(false);
    expect(r.treatment?.session.id).toBe("s-024");
  });
});

describe("HON-10 row 3: the client overview shows an uncharted visit's plan", () => {
  // The source half: the band's source does not require charting, so for a
  // client whose only visit is uncharted it is that visit.
  it("the watch/plan source is found when no session is charted", () => {
    const only = { id: "s-only", record_status: "draft", started_at: "2026-08-01T10:00:00.000Z", next_session_note: DOXYCYCLINE };
    const source = pickPreClientWatchPlanSource([only], new Map());
    expect(source?.id).toBe("s-only");
    const summary = buildLastSessionSummary({ blocks: [], nextSessionNote: source!.next_session_note ?? null });
    const html = renderToStaticMarkup(createElement(FromLastVisitForToday, { summary }));
    expect(html).toContain(DOXYCYCLINE);
  });

  // The render half: the page cannot be rendered in the node lane, so the
  // branch is pinned in source. The card (whose footer is the ONE band render
  // on the Sessions tab) now opens when there is a plan to show even if
  // nothing is charted, and says "No charted treatments yet." inside it.
  const page = readFileSync(path.resolve(__dirname, "../../../app/(app)/clients/[id]/page.tsx"), "utf8");
  const tab = page.slice(page.indexOf('{activeTab === "sessions"'), page.indexOf('{activeTab === "treatment"'));
  const unavailable = tab.indexOf('testId="sessions-last-treatment-unavailable"');
  const cardGuard = tab.search(
    /\) : lastTreatment \|\|\s*\(preClientWatchPlan &&\s*hasFromLastVisitContent\(preClientWatchPlan\)\) \? \(/,
  );
  const innerElse = tab.search(/\) : \(\s*<p[^>]*>No charted treatments yet\.<\/p>\s*\)\}/);
  const band = tab.indexOf("<FromLastVisitForToday");

  it("the card opens for a plan-only history, not only for a charted treatment", () => {
    expect(cardGuard).toBeGreaterThan(0);
  });

  it("inside it, an uncharted history still says 'No charted treatments yet.' (true) before the band", () => {
    expect(innerElse).toBeGreaterThan(cardGuard);
    expect(band).toBeGreaterThan(innerElse);
  });

  it("the band is still rendered exactly once on the Sessions tab", () => {
    expect(tab.match(/<FromLastVisitForToday/g)?.length).toBe(1);
  });

  it("the unavailable check still comes first (a failed read is never 'nothing charted')", () => {
    expect(unavailable).toBeGreaterThan(0);
    expect(unavailable).toBeLessThan(cardGuard);
  });
});
