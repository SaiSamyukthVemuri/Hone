import { beforeEach, describe, expect, it, vi } from "vitest";

// APPOINTMENT-PREP LOADER TRUTHFULNESS: the two final-review P2 blockers.
//
// These drive the REAL `loadLastChartedTreatmentForClient` with a stubbed
// Supabase client, so what is asserted is the shipped loader's behaviour rather
// than a restatement of it. Both defects were invisible to every other lane
// because both produce a perfectly well-formed, entirely wrong answer.
//
// BLOCKER 1, a failed `session_blocks` read rendered as a clinical denial.
//   selectFromCandidates returned `null` on error, the companion hardcoded
//   `unavailable: false`, and the page printed "No previous treatment charted
//   for this client." for a client who has one. Never infer failure from an
//   absent value.
//
// BLOCKER 2, a client whose whole prior history is UNCHARTED lost their
//   next-visit plan and legacy session_notes. `newestPlanOf(candidates)` sat
//   after the `if (!selected) return null` early exit, so a consultation-only
//   visit carrying "Client started doxycycline, do not treat" was silenced.
//   `set_next_session_note` (0167) has no charting gate, so that row is
//   ordinary, not exotic.

const STUDIO = "11111111-1111-1111-1111-111111111111";
const CLIENT = "22222222-2222-2222-2222-222222222222";
const APPOINTMENT = "33333333-3333-3333-3333-333333333333";
const APPT_STARTS_AT = "2026-08-06T14:00:00.000Z";

const DOXYCYCLINE = "Client started doxycycline, do not treat";
const LEGACY_NOTES = "Consultation only.\nDiscussed spacing the next visits.";

type Row = Record<string, unknown>;

// A session row as the candidate read returns it.
function sessionRow(over: Partial<Row> = {}): Row {
  return {
    id: "s-1",
    started_at: "2026-07-10T10:00:00.000Z",
    modality: "electrolysis",
    record_status: "draft",
    deleted_at: null,
    appointment_id: null,
    session_notes: null,
    next_session_note: null,
    electrolysis_entries: [],
    laser_entries: [],
    ...over,
  };
}

function blockRow(over: Partial<Row> = {}): Row {
  return {
    id: "b-1",
    session_id: "s-1",
    sort_order: 1,
    primary_area: "Cheek",
    minutes_performed: 30,
    deleted_at: null,
    structured_areas: [],
    ...over,
  };
}

// Stubs ONLY the two reads the loader performs, keyed by table, so a failure
// can be injected into exactly one of them.
type Outcome = { data: unknown; error: unknown };
let sessionsOutcome: Outcome;
let blocksOutcome: Outcome;
const consoleErrors: string[] = [];

function makeClient() {
  const chain = (outcome: Outcome) => {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "lt", "in", "order"]) {
      self[m] = () => self;
    }
    // `limit` terminates the candidate read; `order` terminates the block read.
    self.limit = async () => outcome;
    self.order = (..._a: unknown[]) => {
      const t = { ...self } as Record<string, unknown>;
      t.then = (resolve: (v: Outcome) => unknown) => resolve(outcome);
      return t;
    };
    return self;
  };
  return {
    from: (table: string) =>
      chain(table === "sessions" ? sessionsOutcome : blocksOutcome),
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => makeClient(),
}));

const { loadLastChartedTreatmentForClient } = await import(
  "@/lib/sessions/last-treatment-loader"
);

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
  consoleErrors.length = 0;
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    consoleErrors.push(String(a[0]));
  });
});

// ---------------------------------------------------------------------------
// R1, block read failure must never read as "no treatment"
// ---------------------------------------------------------------------------

describe("R1. a failed block read is reported as UNAVAILABLE, never as absence", () => {
  it("sets unavailable=true when the batched block read errors", async () => {
    sessionsOutcome = { data: [sessionRow()], error: null };
    blocksOutcome = { data: null, error: { code: "57014", message: "timeout" } };

    const r = await load();

    expect(r.unavailable).toBe(true);
    expect(r.treatment).toBeNull();
  });

  it("POSITIVE CONTROL: successful reads with nothing charted are NOT unavailable", async () => {
    // Same null treatment, opposite meaning. If this ever flips to true the
    // page would cry wolf on every genuine first visit.
    sessionsOutcome = { data: [sessionRow()], error: null };
    blocksOutcome = { data: [], error: null };

    const r = await load();

    expect(r.unavailable).toBe(false);
    expect(r.treatment).toBeNull();
  });

  it("a candidate-read failure is also unavailable, and loads no narrative", async () => {
    sessionsOutcome = { data: null, error: { code: "42501", message: "denied" } };

    const r = await load();

    expect(r.unavailable).toBe(true);
    expect(r.narrative.plan).toBeNull();
    expect(r.narrative.legacySessionNotes).toBeNull();
  });

  it("logs classification only: no raw message, no client/session id", async () => {
    sessionsOutcome = { data: [sessionRow()], error: null };
    blocksOutcome = { data: null, error: { code: "57014", message: "SELECT ... FROM session_blocks" } };

    await load();

    expect(consoleErrors.length).toBeGreaterThan(0);
    const logged = consoleErrors.join("\n");
    expect(logged).toContain("last_charted_treatment_blocks_read_failed");
    expect(logged).toContain("57014");
    expect(logged).not.toContain("SELECT");
    expect(logged).not.toContain(CLIENT);
    expect(logged).not.toContain("s-1");
  });
});

// ---------------------------------------------------------------------------
// R2, plan-only prior history
// ---------------------------------------------------------------------------

describe("R2. an UNCHARTED prior visit still surfaces its next-visit plan", () => {
  const planOnly = () =>
    sessionRow({
      id: "s-consult",
      next_session_note: DOXYCYCLINE,
      electrolysis_entries: [],
      laser_entries: [],
    });

  it("the plan survives when no candidate qualifies as charted", async () => {
    sessionsOutcome = { data: [planOnly()], error: null };
    blocksOutcome = { data: [], error: null };

    const r = await load();

    expect(r.narrative.plan?.text).toBe(DOXYCYCLINE);
    expect(r.narrative.plan?.sessionId).toBe("s-consult");
  });

  it("and NO treatment is fabricated from it, the selector is untouched", async () => {
    sessionsOutcome = { data: [planOnly()], error: null };
    blocksOutcome = { data: [], error: null };

    const r = await load();

    expect(r.treatment).toBeNull();
    expect(r.unavailable).toBe(false);
  });

  it("the empty-state branch cannot hide it, narrative is non-empty", async () => {
    sessionsOutcome = { data: [planOnly()], error: null };
    blocksOutcome = { data: [], error: null };

    const r = await load();
    const hasNarrative =
      r.narrative.plan != null || r.narrative.legacySessionNotes != null;
    expect(hasNarrative).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R3, legacy session_notes regression
// ---------------------------------------------------------------------------

describe("R3. legacy session_notes on an uncharted newest row still has a channel", () => {
  it("surfaces the newest eligible row's session_notes", async () => {
    // Pre-Session-1D the page rendered the NEWEST prior row's session_notes.
    // sessions.session_notes has no surviving writer, so losing it is permanent.
    sessionsOutcome = {
      data: [sessionRow({ id: "s-newest", session_notes: LEGACY_NOTES })],
      error: null,
    };
    blocksOutcome = { data: [], error: null };

    const r = await load();

    expect(r.narrative.legacySessionNotes?.text).toBe(LEGACY_NOTES);
    expect(r.narrative.legacySessionNotes?.sessionId).toBe("s-newest");
    // Whole text, line breaks intact.
    expect(r.narrative.legacySessionNotes?.text).toContain("\n");
  });

  it("takes the NEWEST row, not a scan, matching the pre-1D rule", async () => {
    sessionsOutcome = {
      data: [
        sessionRow({ id: "s-newest", started_at: "2026-07-20T10:00:00.000Z" }),
        sessionRow({ id: "s-older", started_at: "2026-07-01T10:00:00.000Z", session_notes: "older" }),
      ],
      error: null,
    };
    blocksOutcome = { data: [], error: null };

    const r = await load();
    // The newest row has no notes, so, exactly as before Session 1D, nothing
    // is shown. Broadening this into a historical scan is out of scope.
    expect(r.narrative.legacySessionNotes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R4, genuine first visit
// ---------------------------------------------------------------------------

describe("R4. a genuine first visit stays a calm, truthful empty state", () => {
  it("no treatment, no narrative, not unavailable", async () => {
    sessionsOutcome = { data: [], error: null };
    blocksOutcome = { data: [], error: null };

    const r = await load();

    expect(r.treatment).toBeNull();
    expect(r.unavailable).toBe(false);
    expect(r.narrative.plan).toBeNull();
    expect(r.narrative.legacySessionNotes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R5, partial failure
// ---------------------------------------------------------------------------

describe("R5. a partial failure keeps the narrative that WAS loaded", () => {
  it("block read fails, but the safety-relevant plan survives", async () => {
    // The candidate rows loaded successfully, so their narrative is known. To
    // throw it away because the treatment-detail read failed would compound the
    // failure, this is the case where the plan matters most.
    sessionsOutcome = {
      data: [
        sessionRow({
          id: "s-charted",
          next_session_note: DOXYCYCLINE,
          session_notes: LEGACY_NOTES,
          electrolysis_entries: [{ id: "e1", block_id: "b-1", created_at: "x", deleted_at: null }],
        }),
      ],
      error: null,
    };
    blocksOutcome = { data: null, error: { code: "PGRST200", message: "schema cache" } };

    const r = await load();

    expect(r.unavailable).toBe(true);
    expect(r.treatment).toBeNull();
    expect(r.narrative.plan?.text).toBe(DOXYCYCLINE);
    expect(r.narrative.legacySessionNotes?.text).toBe(LEGACY_NOTES);
  });

  it("no partial treatment settings are presented as complete", async () => {
    sessionsOutcome = { data: [sessionRow({ next_session_note: DOXYCYCLINE })], error: null };
    blocksOutcome = { data: null, error: { code: "57014", message: "timeout" } };

    const r = await load();
    // treatment is null, so no block/area/setting can render at all.
    expect(r.treatment).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R6, no duplication
// ---------------------------------------------------------------------------

describe("R6. when a treatment IS selected the card owns the narrative", () => {
  it("returns a treatment AND the narrative, so the page can render one surface", async () => {
    sessionsOutcome = {
      data: [
        sessionRow({
          id: "s-1",
          next_session_note: DOXYCYCLINE,
          session_notes: LEGACY_NOTES,
        }),
      ],
      error: null,
    };
    blocksOutcome = { data: [blockRow()], error: null };

    const r = await load();

    expect(r.treatment).not.toBeNull();
    expect(r.unavailable).toBe(false);
    // The plan is still resolved by the ONE authority and handed to the card as
    // planSource; the page renders the fallback surface only when there is no
    // card, which is what keeps the same text from printing twice.
    expect(r.narrative.plan?.text).toBe(DOXYCYCLINE);
  });
});
