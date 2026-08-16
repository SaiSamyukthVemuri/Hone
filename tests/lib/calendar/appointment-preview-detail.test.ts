import { beforeEach, describe, expect, it, vi } from "vitest";

// The calendar preview drawer's lazy prep load.
//
// The mock RECORDS every filter call rather than accepting anything, so a
// tenancy assertion here is behavioural and not vacuous: the widely-copied
// `q.eq = chain` harness in this repo passes even when `.eq("studio_id", …)`
// is deleted, which is exactly the trap NC2 targets.

type Res = { data: unknown; error: { code?: string } | null };

const STUDIO = "11111111-1111-4111-8111-111111111111";
const OTHER_STUDIO = "22222222-2222-4222-8222-222222222222";
const APPT = "33333333-3333-4333-8333-333333333333";
const CLIENT = "44444444-4444-4444-8444-444444444444";

// Per-table scripted responses + a per-table record of the filters applied.
const responses: Record<string, Res> = {};
const filters: Array<{ table: string; method: string; args: unknown[] }> = [];

function builder(table: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {};
  for (const m of ["select", "eq", "in", "is", "lt", "order", "limit"]) {
    b[m] = (...args: unknown[]) => {
      filters.push({ table, method: m, args });
      return b;
    };
  }
  const settle = () => responses[table] ?? { data: null, error: null };
  b.maybeSingle = () => Promise.resolve(settle());
  b.then = (onF: (v: Res) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(settle()).then(onF, onR);
  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (table: string) => builder(table) }),
}));

import { loadAppointmentPreviewDetail } from "@/lib/calendar/appointment-preview-detail";

const APPT_ROW = {
  id: APPT,
  status: "confirmed",
  starts_at: "2026-08-20T15:00:00.000Z",
  ends_at: "2026-08-20T16:00:00.000Z",
  notes: "Parking round the back",
  client_id: CLIENT,
  client: { id: CLIENT, name: "Ada", allergies: "Lidocaine" },
};

function reset() {
  filters.length = 0;
  for (const k of Object.keys(responses)) delete responses[k];
  responses.appointments = { data: APPT_ROW, error: null };
  responses.client_intake_forms = { data: null, error: null };
  responses.sessions = { data: [], error: null };
  responses.session_blocks = { data: [], error: null };
}

function eqArgs(table: string): Array<unknown[]> {
  return filters.filter((f) => f.table === table && f.method === "eq").map((f) => f.args);
}

beforeEach(reset);

describe("tenancy — the appointment id is a pointer, never authority", () => {
  it("scopes the appointment read by BOTH studio_id and id", async () => {
    await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    const eqs = eqArgs("appointments");
    // NC2 (remove studio scoping from the lazy preview loader) turns this red.
    expect(eqs).toContainEqual(["studio_id", STUDIO]);
    expect(eqs).toContainEqual(["id", APPT]);
  });

  it("a row that does not resolve in THIS studio is 'not found', never a leak", async () => {
    // What PostgREST returns when the studio predicate excludes the row.
    responses.appointments = { data: null, error: null };
    const r = await loadAppointmentPreviewDetail({
      studioId: OTHER_STUDIO,
      appointmentId: APPT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not be found in this studio/i);
  });

  it("the downstream prep + intake reads carry the SAME studio id", async () => {
    await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    expect(eqArgs("client_intake_forms")).toContainEqual(["studio_id", STUDIO]);
    expect(eqArgs("sessions")).toContainEqual(["studio_id", STUDIO]);
  });

  it("an empty appointment id is refused before any query runs", async () => {
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: "  " });
    expect(r.ok).toBe(false);
    expect(filters).toHaveLength(0);
  });
});

describe("the last-treatment boundary is delegated, not restated", () => {
  it("bounds the candidate window strictly before THIS appointment's starts_at", async () => {
    await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    const lt = filters.filter((f) => f.table === "sessions" && f.method === "lt");
    // NC1 (swap the canonical loader for a naive newest-session lookup) drops
    // this bound and turns the case red.
    expect(lt).toContainEqual({
      table: "sessions",
      method: "lt",
      args: ["started_at", APPT_ROW.starts_at],
    });
  });

  it("scopes the candidate window to the appointment's client", async () => {
    await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    expect(eqArgs("sessions")).toContainEqual(["client_id", CLIENT]);
  });

  it("does NOT push the appointment exclusion into SQL", async () => {
    // sessions.appointment_id is nullable, and `NULL <> 'x'` is NULL, so a SQL
    // neq would silently discard every UNLINKED session — nearly all of them.
    // The exclusion is a JS-side filter inside the shared authority.
    await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    expect(eqArgs("sessions")).not.toContainEqual(["appointment_id", APPT]);
    expect(filters.some((f) => f.method === "neq")).toBe(false);
  });
});

describe("three states, never two — absence is not failure", () => {
  it("a successful EMPTY intake read reports 'none', not 'unavailable' (positive control)", async () => {
    responses.client_intake_forms = { data: null, error: null };
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.detail.intakeStatus).toBeNull();
      expect(r.detail.intakeUnavailable).toBe(false);
    }
  });

  it("a FAILED intake read reports unavailable and never a false 'no intake on file'", async () => {
    responses.client_intake_forms = { data: null, error: { code: "57014" } };
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.detail.intakeStatus).toBeNull();
      expect(r.detail.intakeUnavailable).toBe(true);
    }
  });

  it("a successful intake read reports its status", async () => {
    responses.client_intake_forms = {
      data: { id: "i1", client_id: CLIENT, status: "submitted" },
      error: null,
    };
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    if (r.ok) expect(r.detail.intakeStatus).toBe("submitted");
  });

  it("a successful EMPTY session read is 'nothing charted', not unavailable (positive control)", async () => {
    responses.sessions = { data: [], error: null };
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.detail.prepMemory).toBeNull();
      expect(r.detail.lastTreatmentUnavailable).toBe(false);
    }
  });

  it("a FAILED session read reports unavailable rather than 'no history'", async () => {
    responses.sessions = { data: null, error: { code: "57014" } };
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.detail.prepMemory).toBeNull();
      expect(r.detail.lastTreatmentUnavailable).toBe(true);
    }
  });

  it("a failed appointment read never degrades to a partial drawer", async () => {
    responses.appointments = { data: null, error: { code: "57014" } };
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not load/i);
  });
});

describe("payload shape", () => {
  it("echoes the appointment id so a stale response can be detected", async () => {
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    if (r.ok) expect(r.detail.appointmentId).toBe(APPT);
  });

  it("returns the row's own status/starts_at so action gating is not left to a stale grid payload", async () => {
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    if (r.ok) {
      expect(r.detail.status).toBe("confirmed");
      expect(r.detail.startsAt).toBe(APPT_ROW.starts_at);
    }
  });

  it("carries notes and allergies", async () => {
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    if (r.ok) {
      expect(r.detail.notes).toBe("Parking round the back");
      expect(r.detail.allergies).toBe("Lidocaine");
    }
  });

  it("never carries the intake RESPONSES (the medical answers)", async () => {
    responses.client_intake_forms = {
      data: {
        id: "i1",
        client_id: CLIENT,
        status: "submitted",
        responses: { secret_condition: "should never cross the wire" },
      },
      error: null,
    };
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    expect(JSON.stringify(r)).not.toContain("secret_condition");
    expect(JSON.stringify(r)).not.toContain("should never cross the wire");
  });

  it("a deleted client yields a readable appointment with no prep, not a crash", async () => {
    responses.appointments = {
      data: { ...APPT_ROW, client_id: null, client: null },
      error: null,
    };
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.detail.clientId).toBeNull();
      expect(r.detail.prepMemory).toBeNull();
      expect(r.detail.lastTreatmentUnavailable).toBe(false);
    }
  });

  it("normalizes an embedded client returned as an array", async () => {
    responses.appointments = {
      data: { ...APPT_ROW, client: [{ id: CLIENT, name: "Ada", allergies: "Latex" }] },
      error: null,
    };
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    if (r.ok) expect(r.detail.allergies).toBe("Latex");
  });
});

// NARRATIVE IS A SECOND, INDEPENDENT OUTPUT — AND WAS BEING DROPPED.
//
// loadLastChartedTreatmentForClient returns `treatment` (the newest CHARTED
// visit) and `narrative` (the newest next-visit instruction / legacy session
// note in the candidate window). They deliberately need not come from the same
// visit: a note-only visit is not a treatment and must never be promoted to
// one, but the instruction attached to it is exactly what a practitioner needs
// before walking into the room.
//
// This projection consumed only `treatment`, so the drawer could state "no
// previous treatment charted for this client" while silently withholding a
// known next-visit instruction. These prove the pass-through, not a second
// selector: which item is owned vs external is decided downstream by the shared
// buildPrepProvenanceModel.
describe("prior-visit narrative survives the projection", () => {
  const NOTE_ONLY = {
    id: "55555555-5555-4555-8555-555555555555",
    client_id: CLIENT,
    started_at: "2026-06-01T15:00:00.000Z",
    modality: "electrolysis",
    record_status: "active",
    deleted_at: null,
    appointment_id: null,
    session_notes: null,
    next_session_note: "Numb 20 min earlier next time — client found it sharp.",
    electrolysis_entries: [],
    laser_entries: [],
  };

  it("CASE D — narrative survives when there is NO charted treatment", async () => {
    // The headline case. Nothing is charted, so the treatment card correctly
    // says so; the instruction must not vanish with it.
    responses.sessions = { data: [NOTE_ONLY], error: null };
    responses.session_blocks = { data: [], error: null };
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.detail.prepMemory).toBeNull();
      expect(r.detail.lastTreatmentUnavailable).toBe(false);
      expect(r.detail.narrative.plan?.text).toBe(NOTE_ONLY.next_session_note);
      // Provenance is carried, not invented: the item keeps its own session and
      // date so a downstream surface can attribute it truthfully.
      expect(r.detail.narrative.plan?.sessionId).toBe(NOTE_ONLY.id);
      expect(r.detail.narrative.plan?.startedAt).toBe(NOTE_ONLY.started_at);
    }
  });

  it("carries the legacy session note as its own item, not merged into the plan", async () => {
    responses.sessions = {
      data: [{ ...NOTE_ONLY, next_session_note: null, session_notes: "Reacted to lidocaine." }],
      error: null,
    };
    responses.session_blocks = { data: [], error: null };
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    if (r.ok) {
      expect(r.detail.narrative.plan).toBeNull();
      expect(r.detail.narrative.legacySessionNotes?.text).toBe("Reacted to lidocaine.");
    }
  });

  it("CASE E — a FAILED candidate read carries no narrative and still says unavailable", async () => {
    // The loader's own failure path returns empty narrative because nothing was
    // read. The truthful state is "unavailable", never "nothing recorded".
    responses.sessions = { data: null, error: { code: "57014" } };
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.detail.lastTreatmentUnavailable).toBe(true);
      expect(r.detail.narrative.plan).toBeNull();
      expect(r.detail.narrative.legacySessionNotes).toBeNull();
    }
  });

  it("a genuinely empty history carries empty narrative (positive control)", async () => {
    responses.sessions = { data: [], error: null };
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    if (r.ok) {
      expect(r.detail.narrative.plan).toBeNull();
      expect(r.detail.lastTreatmentUnavailable).toBe(false);
    }
  });

  it("a deleted client yields empty narrative rather than an undefined field", async () => {
    responses.appointments = {
      data: { ...APPT_ROW, client_id: null, client: null },
      error: null,
    };
    const r = await loadAppointmentPreviewDetail({ studioId: STUDIO, appointmentId: APPT });
    if (r.ok) {
      expect(r.detail.narrative).toEqual({ plan: null, legacySessionNotes: null });
    }
  });
});
