import { describe, expect, it } from "vitest";
import {
  buildAppointmentPrepMemory,
  buildPrepFallbackNarrative,
  buildLastSessionNoteSections,
  NARRATIVE_SOURCE_LABELS,
  NO_LAST_SESSION_NOTES_COPY,
  type AppointmentPrepMemoryInput,
  type PrepLaserEntry,
} from "@/lib/sessions/appointment-prep-memory";
import {
  chartedSessionCandidates,
  pickNewestChartedSession,
  type ChartedSessionCandidate,
} from "@/lib/sessions/charted-session";
import type {
  PointOfCareBlock,
  PointOfCareEntry,
} from "@/lib/sessions/point-of-care-memory";

// APPOINTMENT PREPARATION MEMORY — behavioural contract.
//
// Two halves are proved here:
//   * SELECTION — that the appointment page asks the shared selector the right
//     question. The selector's own rules are proved in charted-session.test.ts;
//     what is new for 1D is the appointment BOUNDARY (strictly before
//     starts_at) and the linked-session exclusion.
//   * THE MODEL — that every recorded setting and outcome survives into the
//     view model, that the narrative is complete, whole, deduplicated and
//     attributable, and that an absent value is never fabricated into a normal
//     result.
//
// The wiring (which page calls which loader, and what the card renders) is
// pinned in tests/source-guards/appointment-prep-guards.test.ts. The real
// database behaviour is proved in tests/db/appointment-prep-memory.db.test.ts.

const APPT_STARTS_AT = "2026-08-06T14:00:00.000Z";
const APPOINTMENT_ID = "appt-1111";

function entry(over: Partial<PointOfCareEntry> = {}): PointOfCareEntry {
  return {
    id: "e1",
    created_at: "2026-07-10T10:05:00.000Z",
    deleted_at: null,
    mode: "blend",
    hairs_treated: 40,
    observation_chips: [],
    thermolysis_intensity_percent: 40,
    thermolysis_duration_seconds: 0.733,
    galvanic_ma: 1.2,
    galvanic_duration_seconds: 8,
    units_of_lye: 30,
    pulse_count: 1,
    ...over,
  };
}

function block(over: Partial<PointOfCareBlock> = {}): PointOfCareBlock {
  return {
    id: "b1",
    sort_order: 1,
    mode: "blend",
    apilus_modality: "picoblend",
    energy_level: 14,
    minutes_performed: 30,
    machine_frequency: "13.56 MHz",
    probe_label: "Ballet F3",
    probe_lot_number: "LOT-A12",
    probe_lot_confirmed: true,
    numbing_status: "used",
    numbing_notes: "Emla 30 min before",
    tolerance_rating: 3,
    reaction_type: "mild_redness",
    reaction_notes: "Settled within the hour",
    caution_for_next_session: true,
    caution_note: "Watch the sideburn",
    structured_areas: [
      { area: "Cheek", laterality: "left" },
      { area: "Sideburn", laterality: "right" },
    ],
    entries: [entry()],
    ...over,
  };
}

function memoryOf(
  over: Partial<AppointmentPrepMemoryInput> = {},
): ReturnType<typeof buildAppointmentPrepMemory> {
  return buildAppointmentPrepMemory({
    session: {
      id: "s-charted",
      started_at: "2026-07-10T10:00:00.000Z",
      modality: "electrolysis",
      session_notes: "Client tolerated the session well.",
      next_session_note: "Start lower on the sideburn",
    },
    blocks: [block()],
    ...over,
  });
}

// ---------------------------------------------------------------------------
// SELECTION — the appointment boundary
// ---------------------------------------------------------------------------

type Candidate = ChartedSessionCandidate & { appointment_id?: string | null };

function candidate(
  id: string,
  startedAt: string,
  over: Partial<Candidate> = {},
): Candidate {
  return { id, started_at: startedAt, ...over };
}

const CHARTED = candidate("s-charted", "2026-07-10T10:00:00.000Z");
const BLOCKS = new Map([["s-charted", [{ deleted_at: null }]]]);

function pick(sessions: Candidate[], blocks = BLOCKS) {
  return pickNewestChartedSession(sessions, blocks, {
    before: APPT_STARTS_AT,
    excludeAppointmentId: APPOINTMENT_ID,
  });
}

describe("selection — the newest CHARTED treatment before this appointment", () => {
  it("1. selects the newest charted block session", () => {
    const older = candidate("s-older", "2026-05-01T10:00:00.000Z");
    const blocks = new Map([
      ["s-charted", [{ deleted_at: null }]],
      ["s-older", [{ deleted_at: null }]],
    ]);
    expect(pick([older, CHARTED], blocks)?.id).toBe("s-charted");
  });

  it("2. ignores a NEWER empty session — the defect this replaces", () => {
    const empty = candidate("s-empty", "2026-08-01T10:00:00.000Z");
    expect(pick([empty, CHARTED])?.id).toBe("s-charted");
  });

  it("3. ignores a newer uncharted administrative row even when it is the very newest", () => {
    const admin = candidate("s-admin", "2026-08-05T23:59:00.000Z");
    const picked = pick([admin, CHARTED]);
    expect(picked?.id).toBe("s-charted");
    expect(picked?.id).not.toBe("s-admin");
  });

  it("4. ignores a deleted session", () => {
    const deleted = candidate("s-del", "2026-08-01T10:00:00.000Z", {
      deleted_at: "2026-08-02T00:00:00.000Z",
    });
    const blocks = new Map([
      ["s-charted", [{ deleted_at: null }]],
      ["s-del", [{ deleted_at: null }]],
    ]);
    expect(pick([deleted, CHARTED], blocks)?.id).toBe("s-charted");
  });

  it("5. ignores a void session", () => {
    const voided = candidate("s-void", "2026-08-01T10:00:00.000Z", {
      record_status: "void",
    });
    const blocks = new Map([
      ["s-charted", [{ deleted_at: null }]],
      ["s-void", [{ deleted_at: null }]],
    ]);
    expect(pick([voided, CHARTED], blocks)?.id).toBe("s-charted");
  });

  it("6. ignores a FUTURE session booked after this appointment", () => {
    const future = candidate("s-future", "2026-09-01T10:00:00.000Z");
    const blocks = new Map([
      ["s-charted", [{ deleted_at: null }]],
      ["s-future", [{ deleted_at: null }]],
    ]);
    expect(pick([future, CHARTED], blocks)?.id).toBe("s-charted");
  });

  it("7. ignores a session starting exactly AT the appointment start — the bound is strict", () => {
    const atStart = candidate("s-at", APPT_STARTS_AT);
    const blocks = new Map([
      ["s-charted", [{ deleted_at: null }]],
      ["s-at", [{ deleted_at: null }]],
    ]);
    expect(pick([atStart, CHARTED], blocks)?.id).toBe("s-charted");
  });

  it("8. ignores THIS appointment's linked session, even when it started earlier", () => {
    // Reachable: the practitioner starts charting a few minutes before the
    // booked time, so the current visit's started_at is < starts_at.
    const linked = candidate("s-linked", "2026-08-06T13:55:00.000Z", {
      appointment_id: APPOINTMENT_ID,
    });
    const blocks = new Map([
      ["s-charted", [{ deleted_at: null }]],
      ["s-linked", [{ deleted_at: null }]],
    ]);
    const picked = pick([linked, CHARTED], blocks);
    expect(picked?.id).toBe("s-charted");
    expect(picked?.id).not.toBe("s-linked");
  });

  it("8b. excludes EVERY session linked to this appointment, not just one", () => {
    // sessions.appointment_id carries no unique constraint (0068), so excluding
    // the single row a limit(1) lookup returned would leave a sibling behind.
    const a = candidate("s-linked-a", "2026-08-06T13:55:00.000Z", {
      appointment_id: APPOINTMENT_ID,
    });
    const b = candidate("s-linked-b", "2026-08-06T13:50:00.000Z", {
      appointment_id: APPOINTMENT_ID,
    });
    const blocks = new Map([
      ["s-charted", [{ deleted_at: null }]],
      ["s-linked-a", [{ deleted_at: null }]],
      ["s-linked-b", [{ deleted_at: null }]],
    ]);
    expect(pick([a, b, CHARTED], blocks)?.id).toBe("s-charted");
  });

  it("8c. a session linked to a DIFFERENT appointment is still eligible", () => {
    const other = candidate("s-other-appt", "2026-08-01T10:00:00.000Z", {
      appointment_id: "appt-9999",
    });
    const blocks = new Map([
      ["s-charted", [{ deleted_at: null }]],
      ["s-other-appt", [{ deleted_at: null }]],
    ]);
    expect(pick([other, CHARTED], blocks)?.id).toBe("s-other-appt");
  });

  it("9. selects a laser-only session — it IS the last treatment mid-transition", () => {
    const laser = candidate("s-laser", "2026-08-01T10:00:00.000Z", {
      laser_entries: [{ deleted_at: null }],
    });
    expect(pick([laser, CHARTED])?.id).toBe("s-laser");
  });

  it("10. selects a legacy entry-only session with no settings blocks", () => {
    const legacy = candidate("s-legacy", "2026-08-01T10:00:00.000Z", {
      electrolysis_entries: [{ deleted_at: null }],
    });
    expect(pick([legacy, CHARTED])?.id).toBe("s-legacy");
  });

  it("10b. a session whose only entries are soft-deleted is NOT charted", () => {
    const ghost = candidate("s-ghost", "2026-08-01T10:00:00.000Z", {
      electrolysis_entries: [{ deleted_at: "2026-08-01T11:00:00.000Z" }],
      laser_entries: [{ deleted_at: "2026-08-01T11:00:00.000Z" }],
    });
    expect(pick([ghost, CHARTED])?.id).toBe("s-charted");
  });

  it("11. a first-visit client yields no prior treatment at all", () => {
    expect(pick([], new Map())).toBeNull();
    // And a client whose ONLY session is this appointment's own.
    const linkedOnly = candidate("s-linked", "2026-08-06T13:55:00.000Z", {
      appointment_id: APPOINTMENT_ID,
    });
    expect(
      pick([linkedOnly], new Map([["s-linked", [{ deleted_at: null }]]])),
    ).toBeNull();
  });

  it("12. the candidate window is bounded and deterministic", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      candidate(`s-${String(i).padStart(2, "0")}`, `2026-0${(i % 7) + 1}-01T10:00:00.000Z`),
    );
    const first = chartedSessionCandidates(many, { before: APPT_STARTS_AT });
    const second = chartedSessionCandidates(many, { before: APPT_STARTS_AT });
    expect(first).toHaveLength(25);
    expect(first.map((s) => s.id)).toEqual(second.map((s) => s.id));
  });
});

// ---------------------------------------------------------------------------
// SETTINGS + OUTCOMES
// ---------------------------------------------------------------------------

describe("settings and outcomes — complete, per area, mode-valid", () => {
  it("13. every structured treatment area appears — never only the first", () => {
    const m = memoryOf();
    expect(m.areas[0].areaParts).toEqual(["Left Cheek", "Right Sideburn"]);
    expect(m.areas[0].areaLabel).toBe("Left Cheek · Right Sideburn");
    expect(m.areaHeadline).toBe("Left Cheek · Right Sideburn");
  });

  it("14. laterality appears on every area, including the legacy fallback", () => {
    const legacy = memoryOf({
      blocks: [
        block({
          structured_areas: null,
          primary_area: "Upper lip",
          side: "left",
        }),
      ],
    });
    expect(legacy.areas[0].areaParts).toEqual(["Left Upper lip"]);
  });

  it("15. block order is preserved and each block keeps its OWN settings", () => {
    const m = memoryOf({
      blocks: [
        block({
          id: "b2",
          sort_order: 2,
          mode: "thermo",
          machine_frequency: "27.12 MHz",
          minutes_performed: 12,
          probe_label: "Ballet F2",
          structured_areas: [{ area: "Chin", laterality: "midline" }],
          entries: [entry({ id: "e2", hairs_treated: 5 })],
        }),
        block(),
      ],
    });
    expect(m.areas.map((a) => a.key)).toEqual(["b1", "b2"]);
    expect(m.areas[0].setup.frequency).toBe("13.56 MHz");
    expect(m.areas[1].setup.frequency).toBe("27.12 MHz");
    // The first block's setup is never attributed to the second.
    expect(m.areas[0].setup.probeLine).toContain("Ballet F3");
    expect(m.areas[1].setup.probeLine).toContain("Ballet F2");
    expect(m.areas[1].setup.probeLine).not.toContain("Ballet F3");
    expect(m.areas[1].setup.modeLabel).toBe("Thermolysis");
    expect(m.areas[0].setup.modeLabel).toBe("Blend");
    expect(m.areas[0].outcome.minutes).toBe(30);
    expect(m.areas[1].outcome.minutes).toBe(12);
    // Minutes are credited to each block once, never split across its areas.
    expect(m.totalMinutes).toBe(42);
  });

  it("15b. the same block is never rendered twice", () => {
    const m = memoryOf({ blocks: [block(), block({ id: "b2", sort_order: 2 })] });
    expect(new Set(m.areas.map((a) => a.key)).size).toBe(m.areas.length);
  });

  it("16. readings are MODE-VALID — thermolysis never shows stale galvanic values", () => {
    const thermo = memoryOf({
      blocks: [
        block({
          mode: "thermo",
          // Stale galvanic values left behind by an earlier mode.
          entries: [entry({ mode: "thermo", galvanic_ma: 1.2, units_of_lye: 30 })],
        }),
      ],
    });
    const fields = thermo.areas[0].setup.readings.map((r) => r.field);
    expect(fields).not.toContain("galvanicMa");
    expect(fields).not.toContain("galvanicDurationSeconds");
    expect(fields).not.toContain("unitsOfLye");
    expect(fields).toContain("thermolysisDurationSeconds");

    const galv = memoryOf({
      blocks: [
        block({
          mode: "galv",
          entries: [entry({ mode: "galv", thermolysis_intensity_percent: 40 })],
        }),
      ],
    });
    const galvFields = galv.areas[0].setup.readings.map((r) => r.field);
    expect(galvFields).not.toContain("thermolysisIntensityPercent");
    expect(galvFields).not.toContain("thermolysisDurationSeconds");
    expect(galvFields).toContain("galvanicMa");
    expect(galvFields).not.toContain("energyLevel");

    // Blend may show both.
    const blendFields = memoryOf().areas[0].setup.readings.map((r) => r.field);
    expect(blendFields).toContain("galvanicMa");
    expect(blendFields).toContain("thermolysisDurationSeconds");
  });

  it("16b. the complete Phase-2 setup inventory is present for a blend block", () => {
    const a = memoryOf().areas[0];
    expect(a.setup.modeLabel).toBe("Blend");
    expect(a.setup.modalityLabel).toBeTruthy();
    expect(a.setup.frequency).toBe("13.56 MHz");
    expect(a.setup.energyLevel).toBe(14);
    const byField = Object.fromEntries(
      a.setup.readings.map((r) => [r.field, r.value]),
    );
    expect(byField.energyLevel).toBe("EL 14");
    expect(byField.unitsOfLye).toBe("30 UL");
    expect(byField.galvanicDurationSeconds).toBe("8s");
    expect(byField.galvanicMa).toBe("1.2 mA");
    // 3dp exact — a stored 0.733 must never render as 0.73 or 0.
    expect(byField.thermolysisDurationSeconds).toBe("0.733 seconds");
    expect(byField.thermolysisIntensityPercent).toBe("40%");
    expect(byField.pulseCount).toBe("1 pulse");
    expect(a.setupRecorded).toBe(true);
  });

  it("16c. a single-pulse treatment shows no pulse delay", () => {
    const one = memoryOf({
      blocks: [block({ entries: [entry({ pulse_count: 1, pulse_delay_seconds: 0.25 })] })],
    });
    expect(
      one.areas[0].setup.readings.find((r) => r.field === "pulseDelay"),
    ).toBeUndefined();
    const two = memoryOf({
      blocks: [block({ entries: [entry({ pulse_count: 3, pulse_delay_seconds: 0.25 })] })],
    });
    expect(
      two.areas[0].setup.readings.find((r) => r.field === "pulseDelay")?.value,
    ).toBe("0.25s delay");
  });

  it("16d. divergent readings between passes are FLAGGED, not silently dropped", () => {
    // The readings shown are the canonical (first) pass's — Session 1B's shared
    // rule. When a later pass differs, the card must say so; preparing to 40%
    // for a session that ended at 55% is exactly the miss this card exists to
    // prevent.
    const diverged = memoryOf({
      blocks: [
        block({
          entries: [
            entry({
              id: "e1",
              created_at: "2026-07-10T10:05:00.000Z",
              thermolysis_intensity_percent: 40,
            }),
            entry({
              id: "e2",
              created_at: "2026-07-10T10:20:00.000Z",
              thermolysis_intensity_percent: 55,
            }),
          ],
        }),
      ],
    });
    expect(diverged.areas[0].settingsChangedDuringSession).toBe(true);
    // The canonical pass is still what is shown.
    expect(
      diverged.areas[0].setup.readings.find(
        (r) => r.field === "thermolysisIntensityPercent",
      )?.value,
    ).toBe("40%");
  });

  it("16e. identical passes raise no false alarm", () => {
    const same = memoryOf({
      blocks: [
        block({
          entries: [
            entry({ id: "e1", created_at: "2026-07-10T10:05:00.000Z" }),
            entry({ id: "e2", created_at: "2026-07-10T10:20:00.000Z" }),
          ],
        }),
      ],
    });
    expect(same.areas[0].passCount).toBe(2);
    expect(same.areas[0].settingsChangedDuringSession).toBe(false);
    // And a single pass never flags.
    expect(memoryOf().areas[0].settingsChangedDuringSession).toBe(false);
  });

  it("16f. a soft-deleted divergent pass raises no alarm", () => {
    const m = memoryOf({
      blocks: [
        block({
          entries: [
            entry({ id: "e1", created_at: "2026-07-10T10:05:00.000Z" }),
            entry({
              id: "gone",
              created_at: "2026-07-10T10:20:00.000Z",
              deleted_at: "2026-07-10T11:00:00.000Z",
              thermolysis_intensity_percent: 99,
            }),
          ],
        }),
      ],
    });
    expect(m.areas[0].settingsChangedDuringSession).toBe(false);
  });

  it("17. the probe, its lot and the lot confirmation are shown", () => {
    expect(memoryOf().areas[0].setup.probeLine).toBe(
      "Ballet F3 · Lot #LOT-A12 (confirmed)",
    );
    const unconfirmed = memoryOf({
      blocks: [block({ probe_lot_confirmed: false })],
    });
    expect(unconfirmed.areas[0].setup.probeLine).toBe("Ballet F3 · Lot #LOT-A12");
  });

  it("18. multiple passes aggregate hairs and surface the pass count", () => {
    const m = memoryOf({
      blocks: [
        block({
          entries: [
            entry({ id: "e1", hairs_treated: 40, created_at: "2026-07-10T10:05:00.000Z" }),
            entry({ id: "e2", hairs_treated: 25, created_at: "2026-07-10T10:20:00.000Z" }),
          ],
        }),
      ],
    });
    expect(m.areas[0].outcome.hairs).toBe(65);
    expect(m.areas[0].passCount).toBe(2);
    expect(m.totalHairs).toBe(65);
  });

  it("19. soft-deleted passes contribute nothing — no hairs, no count, no note", () => {
    const m = memoryOf({
      blocks: [
        block({
          entries: [
            entry({ id: "e1", hairs_treated: 40 }),
            entry({
              id: "gone",
              hairs_treated: 9999,
              deleted_at: "2026-07-10T11:00:00.000Z",
              comments: "REMOVED PASS NOTE",
            }),
          ],
        }),
      ],
    });
    expect(m.areas[0].outcome.hairs).toBe(40);
    expect(m.areas[0].passCount).toBe(1);
    expect(JSON.stringify(m)).not.toMatch(/9999|REMOVED PASS NOTE/);
  });

  it("20. an absent value reads as absent — minutes, hairs and response are never fabricated", () => {
    const bare = memoryOf({
      blocks: [
        block({
          minutes_performed: null,
          tolerance_rating: null,
          reaction_type: null,
          reaction_notes: null,
          numbing_status: null,
          numbing_notes: null,
          caution_for_next_session: false,
          caution_note: null,
          // No passes at all: a pass COUNT and a pass NOTE are themselves
          // recorded outcomes, so a block with entries is not "nothing".
          entries: [],
        }),
      ],
    });
    const o = bare.areas[0].outcome;
    expect(o.minutes).toBeNull();
    expect(o.hairs).toBeNull();
    expect(o.toleranceLine).toBeNull();
    expect(o.responseLine).toBeNull();
    expect(o.cautionFlag).toBe(false);
    expect(bare.totalMinutes).toBeNull();
    expect(bare.totalHairs).toBeNull();
    // Not 0, not "none", not "no reaction".
    expect(o.minutes).not.toBe(0);
    expect(o.hairs).not.toBe(0);
    expect(bare.areas[0].outcomeRecorded).toBe(false);
  });

  // KNOWN, INHERITED LIMITATION (adversarial review). Session 1B's buildArea
  // sums hairs with `if (h != null && h > 0)`, so a pass that genuinely
  // recorded ZERO hairs reads as "not recorded" rather than as zero. That rule
  // is shared with the live charting card and changing it is a 1B contract
  // change, out of scope here. It is asserted rather than left implicit so the
  // next reader is not misled by test 20b's name.
  it("20a-note. zero HAIRS still read as absent — an inherited 1B rule, stated not hidden", () => {
    const zeroHairs = memoryOf({
      blocks: [block({ entries: [entry({ hairs_treated: 0 })] })],
    });
    expect(zeroHairs.areas[0].outcome.hairs).toBeNull();
  });

  it("20b. a genuinely recorded ZERO minute count is kept, not reported as absent", () => {
    const zero = memoryOf({
      blocks: [
        block({
          minutes_performed: 0,
          caution_for_next_session: false,
          caution_note: null,
          reaction_type: null,
          reaction_notes: null,
          tolerance_rating: null,
          numbing_status: null,
        }),
      ],
    });
    expect(zero.areas[0].outcome.minutes).toBe(0);
    expect(zero.areas[0].outcomeRecorded).toBe(true);
  });

  it("21. setup and outcome are separate groups on the model", () => {
    const a = memoryOf().areas[0];
    const setupKeys = Object.keys(a.setup);
    const outcomeKeys = Object.keys(a.outcome);
    // No field appears in both halves.
    expect(setupKeys.filter((k) => outcomeKeys.includes(k))).toEqual([]);
    // The reproducible recipe.
    expect(setupKeys.sort()).toEqual(
      ["energyLevel", "frequency", "modalityLabel", "modeLabel", "probeLine", "readings"].sort(),
    );
    // What actually happened.
    expect(outcomeKeys.sort()).toEqual(
      [
        "cautionFlag",
        "cautionNote",
        "hairs",
        "minutes",
        "notes",
        "numbing",
        "responseLine",
        "responseNote",
        "toleranceLine",
      ].sort(),
    );
  });

  it("21b. the complete Phase-2 outcome inventory is present", () => {
    const o = memoryOf().areas[0].outcome;
    expect(o.minutes).toBe(30);
    expect(o.hairs).toBe(40);
    expect(o.numbing).toEqual({
      label: "Numbing used",
      note: "Emla 30 min before",
    });
    expect(o.toleranceLine).toBe("3/5 - Moderate discomfort");
    expect(o.responseLine).toBe("Mild redness");
    expect(o.responseNote).toBe("Settled within the hour");
    expect(o.cautionFlag).toBe(true);
    expect(o.cautionNote).toBe("Watch the sideburn");
    expect(memoryOf().areas[0].passCount).toBe(1);
  });

  it("21c. a caution FLAG with no note keeps its WARNING, not just a model field", () => {
    // REGRESSION (adversarial review, P1). The compact summary has always
    // rendered a note-less flag as "<area>: flagged to watch." inside the
    // warning band. Collecting only caution_note demoted a safety flag to an
    // unstyled chip in the same wrap row as "30 min" — below the fold.
    const flagged = memoryOf({
      blocks: [block({ caution_for_next_session: true, caution_note: null })],
    });
    expect(flagged.areas[0].outcome.cautionFlag).toBe(true);
    expect(flagged.areas[0].outcome.cautionNote).toBeNull();
    // It reaches the warning band.
    expect(flagged.notes.cautions).toHaveLength(1);
    expect(flagged.notes.cautions[0].text).toBe("Flagged to watch.");
    expect(flagged.notes.cautions[0].areaLabel).toBe(
      "Left Cheek · Right Sideburn",
    );
    expect(flagged.notes.hasAny).toBe(true);
  });

  it("21c-i. an area with only a pass note is NOT reported as 'Not recorded'", () => {
    // REGRESSION (adversarial review, P2). outcomeRecorded ignored both the
    // pass count and the pass notes, so the card printed "Not recorded" under
    // an area whose own narrative sat further down the same card.
    const m = memoryOf({
      blocks: [
        block({
          minutes_performed: null,
          tolerance_rating: null,
          reaction_type: null,
          reaction_notes: null,
          numbing_status: null,
          numbing_notes: null,
          caution_for_next_session: false,
          caution_note: null,
          entries: [
            entry({
              hairs_treated: null,
              comments: "Client asked to stop early, felt faint",
            }),
          ],
        }),
      ],
    });
    expect(m.areas[0].outcome.notes).toEqual([
      "Client asked to stop early, felt faint",
    ]);
    expect(m.areas[0].outcomeRecorded).toBe(true);
  });

  it("21d. a flag WITH a note shows the note, not the placeholder", () => {
    const m = memoryOf();
    expect(m.notes.cautions[0].text).toBe("Watch the sideburn");
    expect(m.notes.cautions.map((c) => c.text)).not.toContain(
      "Flagged to watch.",
    );
  });

  it("21e. an unflagged area with no caution note produces no warning at all", () => {
    const calm = memoryOf({
      blocks: [block({ caution_for_next_session: false, caution_note: null })],
    });
    expect(calm.notes.cautions).toEqual([]);
  });

  it("22. the retired galvanic intensity is never present anywhere in the model", () => {
    const m = memoryOf({
      blocks: [
        block({
          entries: [
            {
              ...entry(),
              // Forged: a caller handing us the retired column must not surface it.
              galvanic_intensity_percent: 88,
            } as PointOfCareEntry,
          ],
        }),
      ],
    });
    expect(JSON.stringify(m)).not.toMatch(/galvanic_intensity|galvanicIntensity/i);
    expect(JSON.stringify(m)).not.toMatch(/88/);
  });
});

// ---------------------------------------------------------------------------
// NARRATIVE
// ---------------------------------------------------------------------------

const MULTILINE =
  "First paragraph about the treatment.\n\nSecond paragraph.\nThird line follows immediately.";

describe("narrative — complete, whole, grouped, deduplicated", () => {
  it("23. the prior session's general notes are shown in full", () => {
    const m = memoryOf({
      session: {
        id: "s",
        started_at: "2026-07-10T10:00:00.000Z",
        modality: "electrolysis",
        session_notes: MULTILINE,
        next_session_note: null,
      },
    });
    expect(m.notes.general).toHaveLength(1);
    expect(m.notes.general[0].text).toBe(MULTILINE);
    expect(m.notes.general[0].label).toBe("Legacy session notes");
  });

  it("24. line breaks and blank lines are preserved exactly", () => {
    const m = memoryOf({
      session: {
        id: "s",
        started_at: "2026-07-10T10:00:00.000Z",
        modality: "electrolysis",
        session_notes: MULTILINE,
        next_session_note: null,
      },
    });
    const text = m.notes.general[0].text;
    expect(text.split("\n")).toHaveLength(4);
    expect(text).toContain("\n\n");
    // Never collapsed into one line.
    expect(text).not.toBe(MULTILINE.replace(/\s+/g, " "));
  });

  it("25. the next-visit note is its own labelled item, not part of the general blob", () => {
    const m = memoryOf();
    expect(m.notes.forNextVisit?.text).toBe("Start lower on the sideburn");
    expect(m.notes.forNextVisit?.label).toBe("For next visit");
    expect(m.notes.forNextVisit?.source).toBe("next_session_note");
    expect(m.notes.general.map((g) => g.text)).not.toContain(
      "Start lower on the sideburn",
    );
  });

  it("25b. a plan written on a LATER visit wins, and says where it came from", () => {
    // REGRESSION (adversarial review, P1). A plan can be written on a session
    // that never got charted — "client started doxycycline, do not treat" —
    // and reading only the selected treatment's own note silenced it. Three
    // other pre-visit surfaces already decouple the plan source (PR #203).
    const m = memoryOf({
      planSource: {
        sessionId: "s-newer-empty",
        startedAt: "2026-08-03T10:00:00.000Z",
        text: "Client started doxycycline, do not treat",
      },
    });
    expect(m.notes.forNextVisit?.text).toBe(
      "Client started doxycycline, do not treat",
    );
    expect(m.notes.forNextVisitFromLaterVisit).toBe("2026-08-03T10:00:00.000Z");
    // The selected treatment's own, now-stale, plan is not shown instead.
    expect(JSON.stringify(m.notes)).not.toContain("Start lower on the sideburn");
  });

  it("25b-i. an OLDER plan is shown but never claimed to be 'after' the treatment", () => {
    // REGRESSION (adversarial review, P1 introduced by the 25b fix). The
    // newest note-bearing session can be OLDER than the selected treatment —
    // "the last charted visit left no plan, an earlier one did" is the primary
    // case this decoupling exists to serve. Gating the provenance line on
    // session IDENTITY rather than chronology printed "Written Jun 1, after the
    // treatment above" beneath a Jul 10 header.
    const m = memoryOf({
      planSource: {
        sessionId: "s-older",
        startedAt: "2026-06-01T10:00:00.000Z",
        text: "Start lower on the sideburn",
      },
    });
    expect(m.notes.forNextVisit?.text).toBe("Start lower on the sideburn");
    expect(m.notes.forNextVisitFromLaterVisit).toBeNull();
  });

  it("25c. a plan belonging to the selected treatment is NOT labelled as later", () => {
    const m = memoryOf({
      planSource: {
        sessionId: "s-charted",
        startedAt: "2026-07-10T10:00:00.000Z",
        text: "Start lower on the sideburn",
      },
    });
    expect(m.notes.forNextVisit?.text).toBe("Start lower on the sideburn");
    expect(m.notes.forNextVisitFromLaterVisit).toBeNull();
  });

  it("25d. with no plan anywhere, the selected session's own note is still used", () => {
    expect(memoryOf({ planSource: null }).notes.forNextVisit?.text).toBe(
      "Start lower on the sideburn",
    );
  });

  it("26. a caution is grouped to its own area", () => {
    const m = memoryOf({
      blocks: [
        block({ caution_note: "Sideburn was tender" }),
        block({
          id: "b2",
          sort_order: 2,
          structured_areas: [{ area: "Chin", laterality: "midline" }],
          caution_note: "Chin needs a lower EL",
        }),
      ],
    });
    expect(m.notes.cautions).toHaveLength(2);
    expect(m.notes.cautions[0]).toMatchObject({
      areaLabel: "Left Cheek · Right Sideburn",
      text: "Sideburn was tender",
    });
    expect(m.notes.cautions[1]).toMatchObject({
      areaLabel: "Midline Chin",
      text: "Chin needs a lower EL",
    });
  });

  it("27. a response note is grouped to its own area, and never repeated under every area", () => {
    const m = memoryOf({
      blocks: [
        block({ reaction_notes: "Redness settled in an hour" }),
        block({
          id: "b2",
          sort_order: 2,
          structured_areas: [{ area: "Chin", laterality: "midline" }],
          reaction_notes: null,
        }),
      ],
    });
    expect(m.notes.responses).toHaveLength(1);
    expect(m.notes.responses[0].areaKey).toBe("b1");
    expect(m.notes.responses[0].areaLabel).toBe("Left Cheek · Right Sideburn");
  });

  it("28. entry-level Additional notes are grouped under the correct area, oldest first", () => {
    const m = memoryOf({
      blocks: [
        block({
          entries: [
            entry({
              id: "e2",
              created_at: "2026-07-10T10:20:00.000Z",
              comments: "Second pass felt easier",
            }),
            entry({
              id: "e1",
              created_at: "2026-07-10T10:05:00.000Z",
              comments: "First pass was slow going",
            }),
          ],
        }),
        block({
          id: "b2",
          sort_order: 2,
          structured_areas: [{ area: "Chin", laterality: "midline" }],
          numbing_status: null,
          numbing_notes: null,
          entries: [entry({ id: "e3", comments: "Chin note" })],
        }),
      ],
    });
    const comments = m.notes.additional.filter(
      (n) => n.source === "entry_comments",
    );
    expect(comments.map((n) => n.text)).toEqual([
      "First pass was slow going",
      "Second pass felt easier",
      "Chin note",
    ]);
    expect(comments[0].areaKey).toBe("b1");
    expect(comments[2].areaKey).toBe("b2");
    expect(comments[0].label).toBe("Additional notes");
  });

  it("28b. numbing notes are carried as area narrative", () => {
    const numbing = memoryOf().notes.additional.find(
      (n) => n.source === "numbing_notes",
    );
    expect(numbing?.text).toBe("Emla 30 min before");
    expect(numbing?.areaLabel).toBe("Left Cheek · Right Sideburn");
  });

  it("29. no narrative is truncated at any length", () => {
    const long = "A".repeat(4000);
    const m = memoryOf({
      blocks: [block({ reaction_notes: long, caution_note: long })],
      session: {
        id: "s",
        started_at: "2026-07-10T10:00:00.000Z",
        modality: "electrolysis",
        session_notes: long,
        next_session_note: null,
      },
    });
    expect(m.notes.general[0].text).toHaveLength(4000);
    expect(m.notes.responses[0].text).toHaveLength(4000);
    expect(m.notes.cautions[0].text).toHaveLength(4000);
    // No ellipsis anywhere — the compact summary's 140-char drop and the
    // point-of-care card's 180-char excerpt are both absent here.
    expect(JSON.stringify(m)).not.toContain("…");
  });

  it("30. the SAME sentence on two different areas keeps both, with provenance", () => {
    const shared = "Skin felt thin here.";
    const m = memoryOf({
      blocks: [
        block({ reaction_notes: shared }),
        block({
          id: "b2",
          sort_order: 2,
          structured_areas: [{ area: "Chin", laterality: "midline" }],
          reaction_notes: shared,
        }),
      ],
    });
    expect(m.notes.responses).toHaveLength(2);
    expect(m.notes.responses.map((r) => r.areaLabel)).toEqual([
      "Left Cheek · Right Sideburn",
      "Midline Chin",
    ]);
    expect(new Set(m.notes.responses.map((r) => r.key)).size).toBe(2);
  });

  it("31. the same source, area and text is never emitted twice", () => {
    const dup = "Identical pass note";
    const m = memoryOf({
      blocks: [
        block({
          entries: [
            entry({ id: "e1", created_at: "2026-07-10T10:05:00.000Z", comments: dup }),
            entry({ id: "e2", created_at: "2026-07-10T10:20:00.000Z", comments: dup }),
          ],
        }),
      ],
    });
    expect(
      m.notes.additional.filter((n) => n.text === dup),
    ).toHaveLength(1);
  });

  it("31b. next_session_note is never ALSO printed as a general note", () => {
    const same = "Start lower next time";
    const m = memoryOf({
      session: {
        id: "s",
        started_at: "2026-07-10T10:00:00.000Z",
        modality: "electrolysis",
        session_notes: same,
        next_session_note: same,
      },
    });
    expect(m.notes.forNextVisit?.text).toBe(same);
    expect(m.notes.general).toHaveLength(0);
    const all = [
      ...m.notes.general,
      ...(m.notes.forNextVisit ? [m.notes.forNextVisit] : []),
      ...m.notes.cautions,
      ...m.notes.responses,
      ...m.notes.additional,
    ];
    expect(all.filter((n) => n.text === same)).toHaveLength(1);
  });

  it("31c. notes differing only by case or line break are two different notes", () => {
    const m = buildLastSessionNoteSections({
      session: { session_notes: null, next_session_note: null },
      areas: [],
      laserEntries: [
        { id: "l1", deleted_at: null, zone: "Chin", observation_notes: "Some redness" },
        { id: "l2", deleted_at: null, zone: "Chin", observation_notes: "some redness" },
      ],
    });
    // A clinical note is not normalised into a lookalike's duplicate.
    expect(m.additional).toHaveLength(2);
  });

  it("32. structured observation chips never become free-text notes", () => {
    const m = memoryOf({
      blocks: [
        block({
          reaction_type: null,
          reaction_notes: null,
          numbing_status: null,
          numbing_notes: null,
          caution_for_next_session: false,
          caution_note: null,
          entries: [
            entry({
              observation_chips: ["Redness (erythema)", "Slight swelling (edema)"],
              comments: null,
            }),
          ],
        }),
      ],
      session: {
        id: "s",
        started_at: "2026-07-10T10:00:00.000Z",
        modality: "electrolysis",
        session_notes: null,
        next_session_note: null,
      },
    });
    // The chips are the structured response line...
    expect(m.areas[0].outcome.responseLine).toContain("Redness (erythema)");
    // ...and no narrative item was manufactured from them.
    expect(m.notes.hasAny).toBe(false);
    expect(m.areas[0].outcome.notes).toEqual([]);
  });

  it("32b. a LEGACY pass's comments survive WHOLE — chip hydration must not eat them", () => {
    // REGRESSION (adversarial review, P1). resolveDisplayChips promotes
    // canonical tokens out of `comments` into a chip list — but ONLY when
    // observation_chips is empty, which is exactly when the response line
    // (built from that same raw column) is empty too. Taking the hydration
    // REMAINDER therefore deleted text that nothing else on this card renders.
    const m = memoryOf({
      blocks: [
        block({
          entries: [
            entry({
              observation_chips: [],
              comments: "Redness (erythema), client mentioned a new medication",
            }),
          ],
        }),
      ],
    });
    expect(m.areas[0].outcome.notes).toEqual([
      "Redness (erythema), client mentioned a new medication",
    ]);
    const note = m.notes.additional.find((n) => n.source === "entry_comments");
    expect(note?.text).toBe(
      "Redness (erythema), client mentioned a new medication",
    );
  });

  it("32c. a pass whose comments are ENTIRELY canonical tokens is not silently erased", () => {
    // The worst form of the same bug: every comma token hydrates to a chip, the
    // remainder is "", hasAny goes false, and the card affirmatively printed
    // "No notes recorded at the last session." over text that plainly existed.
    const m = memoryOf({
      blocks: [
        block({
          reaction_notes: null,
          caution_for_next_session: false,
          caution_note: null,
          numbing_status: null,
          numbing_notes: null,
          entries: [
            entry({
              observation_chips: [],
              comments: "Coarse hair, Deep follicles, Client tolerated well",
            }),
          ],
        }),
      ],
      session: {
        id: "s",
        started_at: "2026-07-10T10:00:00.000Z",
        modality: "electrolysis",
        session_notes: null,
        next_session_note: null,
      },
    });
    expect(m.notes.hasAny).toBe(true);
    expect(m.areas[0].outcome.notes).toEqual([
      "Coarse hair, Deep follicles, Client tolerated well",
    ]);
  });

  it("32d. a STRUCTURED pass keeps its chips as response labels AND its note whole", () => {
    // The anti-double-render intent still holds where it actually applies.
    const m = memoryOf({
      blocks: [
        block({
          reaction_type: null,
          entries: [
            entry({
              observation_chips: ["Redness (erythema)"],
              comments: "settled within the hour",
            }),
          ],
        }),
      ],
    });
    expect(m.areas[0].outcome.responseLine).toContain("Redness (erythema)");
    expect(m.areas[0].outcome.notes).toEqual(["settled within the hour"]);
    // The chip label is not ALSO printed as prose.
    expect(m.areas[0].outcome.notes.join()).not.toContain("Redness (erythema)");
  });

  it("33. no narrative at all produces the exact empty-state copy contract", () => {
    const m = memoryOf({
      blocks: [
        block({
          reaction_notes: null,
          caution_for_next_session: false,
          caution_note: null,
          numbing_status: null,
          numbing_notes: null,
          entries: [entry({ comments: null })],
        }),
      ],
      session: {
        id: "s",
        started_at: "2026-07-10T10:00:00.000Z",
        modality: "electrolysis",
        session_notes: null,
        next_session_note: null,
      },
    });
    expect(m.notes.hasAny).toBe(false);
    expect(m.notes.general).toEqual([]);
    expect(m.notes.forNextVisit).toBeNull();
    expect(m.notes.cautions).toEqual([]);
    expect(m.notes.responses).toEqual([]);
    expect(m.notes.additional).toEqual([]);
    expect(NO_LAST_SESSION_NOTES_COPY).toBe(
      "No notes recorded at the last session.",
    );
  });

  it("33b. whitespace-only narrative is absent, not an empty bullet", () => {
    const m = memoryOf({
      blocks: [
        block({
          reaction_notes: "   ",
          caution_for_next_session: false,
          caution_note: "\n\n",
          numbing_notes: "  ",
          entries: [entry({ comments: "   " })],
        }),
      ],
      session: {
        id: "s",
        started_at: "2026-07-10T10:00:00.000Z",
        modality: "electrolysis",
        session_notes: " \n ",
        next_session_note: "",
      },
    });
    expect(m.notes.hasAny).toBe(false);
  });

  it("33c. every narrative label comes from the shared source vocabulary", () => {
    const m = memoryOf();
    const items = [
      ...m.notes.general,
      ...(m.notes.forNextVisit ? [m.notes.forNextVisit] : []),
      ...m.notes.cautions,
      ...m.notes.responses,
      ...m.notes.additional,
    ];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.label).toBe(NARRATIVE_SOURCE_LABELS[item.source]);
    }
    // Keys are unique, so React and a browser locator can both rely on them.
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });

  it("33d. non-treatment records are structurally impossible to include", () => {
    // The builder's ONLY narrative inputs are the session's two note columns,
    // the blocks it was handed, and the laser entries. There is no path for
    // intake, consent, payment, cancellation, audit or relationship notes.
    const m = memoryOf();
    expect(JSON.stringify(m)).not.toMatch(
      /intake|consent|refund|cancellation|audit|pinned/i,
    );
  });
});

// ---------------------------------------------------------------------------
// BLOCKLESS TREATMENTS
// ---------------------------------------------------------------------------

describe("blockless treatments — truthful, never 'not recorded'", () => {
  const laserEntries: PrepLaserEntry[] = [
    {
      id: "l1",
      deleted_at: null,
      zone: "Chin",
      observation_notes: "Zone cleared well.\nNo adverse response.",
    },
    { id: "l2", deleted_at: "2026-07-11T00:00:00.000Z", zone: "Neck", observation_notes: "GONE" },
  ];

  it("34. a laser-only treatment says what it IS, with no empty electrolysis shell", () => {
    const m = memoryOf({
      session: {
        id: "s-laser",
        started_at: "2026-07-10T10:00:00.000Z",
        modality: "laser",
        session_notes: "Full-face laser pass.",
        next_session_note: null,
      },
      blocks: [],
      laserEntries,
      hasLiveElectrolysisEntries: false,
    });
    expect(m.areas).toEqual([]);
    expect(m.blocklessNote).toBe(
      "This previous visit was charted as laser passes. Open the full chart to review what was recorded.",
    );
    expect(m.blocklessNote).not.toMatch(/not recorded/i);
    expect(m.areaHeadline).toBeNull();
  });

  it("35. a legacy entry-only treatment says what it IS", () => {
    const m = memoryOf({
      session: {
        id: "s-legacy",
        started_at: "2026-07-10T10:00:00.000Z",
        modality: "electrolysis",
        session_notes: null,
        next_session_note: null,
      },
      blocks: [],
      hasLiveElectrolysisEntries: true,
    });
    expect(m.blocklessNote).toBe(
      "This previous visit contains legacy treatment entries without settings blocks. Open the full chart to review what was recorded.",
    );
    expect(m.blocklessNote).not.toMatch(/Area not recorded|Setup not recorded/i);
  });

  it("35b. a BLOCKLESS legacy pass's notes reach the card — they have no other channel", () => {
    // REGRESSION (adversarial review, P1). Pre-0019 electrolysis charted
    // straight into entries with block_id NULL. Narrative was harvested only
    // from areas, and a blockless visit has none — so the card printed the
    // blockless copy AND "No notes recorded at the last session." while the
    // text sat in the record.
    const m = memoryOf({
      session: {
        id: "s-legacy",
        started_at: "2026-07-10T10:00:00.000Z",
        modality: "electrolysis",
        session_notes: null,
        next_session_note: null,
      },
      blocks: [],
      hasLiveElectrolysisEntries: true,
      electrolysisEntries: [
        {
          id: "e1",
          block_id: null,
          deleted_at: null,
          area: "Chin",
          comments: "Legacy pass, no settings block.",
          created_at: "2026-07-10T10:05:00.000Z",
        },
        {
          id: "e2",
          block_id: null,
          deleted_at: "2026-07-11T00:00:00.000Z",
          area: "Neck",
          comments: "GONE",
          created_at: "2026-07-10T10:10:00.000Z",
        },
      ],
    });
    expect(m.notes.hasAny).toBe(true);
    const note = m.notes.additional.find((n) => n.source === "entry_comments");
    expect(note?.text).toBe("Legacy pass, no settings block.");
    expect(note?.areaLabel).toBe("Chin");
    // A soft-deleted orphan contributes nothing.
    expect(JSON.stringify(m)).not.toContain("GONE");
  });

  it("35b-i. a pass whose BLOCK was soft-deleted still reaches the notes", () => {
    // REGRESSION (adversarial review, P2). soft_delete_session_block (0166)
    // does not cascade to its entries, and the block read filters deleted
    // blocks out — so a live entry pointing at a dead block reached neither the
    // area channel nor the orphan channel, and the card said there were none.
    const m = memoryOf({
      session: {
        id: "s",
        started_at: "2026-07-10T10:00:00.000Z",
        modality: "electrolysis",
        session_notes: null,
        next_session_note: null,
      },
      blocks: [],
      hasLiveElectrolysisEntries: true,
      electrolysisEntries: [
        {
          id: "e1",
          // Points at a block that no longer survives the deleted_at filter.
          block_id: "b-soft-deleted",
          deleted_at: null,
          area: "Chin",
          comments: "Reacted strongly on the chin — start lower",
        },
      ],
    });
    expect(m.notes.hasAny).toBe(true);
    expect(m.notes.additional[0].text).toBe(
      "Reacted strongly on the chin — start lower",
    );
  });

  it("35c. a pass that DOES belong to a block is not emitted twice", () => {
    // The page hands the whole entry list to the builder, so the orphan channel
    // must skip anything a block already carried.
    const m = memoryOf({
      blocks: [
        block({
          entries: [entry({ id: "e1", comments: "Pass note on the block" })],
        }),
      ],
      electrolysisEntries: [
        {
          id: "e1",
          block_id: "b1",
          deleted_at: null,
          area: "Cheek",
          comments: "Pass note on the block",
          created_at: "2026-07-10T10:05:00.000Z",
        },
      ],
    });
    expect(
      m.notes.additional.filter((n) => n.text === "Pass note on the block"),
    ).toHaveLength(1);
  });

  it("35d. an orphan pass with no area is still shown, labelled honestly", () => {
    const m = memoryOf({
      session: {
        id: "s",
        started_at: "2026-07-10T10:00:00.000Z",
        modality: "electrolysis",
        session_notes: null,
        next_session_note: null,
      },
      blocks: [],
      hasLiveElectrolysisEntries: true,
      electrolysisEntries: [
        { id: "e1", block_id: null, deleted_at: null, area: null, comments: "Orphan" },
      ],
    });
    expect(m.notes.additional[0].text).toBe("Orphan");
    expect(m.notes.additional[0].areaLabel).toBe(
      "Recorded without a treatment area",
    );
  });

  it("36. notes stay visible for a blockless treatment", () => {
    const m = memoryOf({
      session: {
        id: "s-laser",
        started_at: "2026-07-10T10:00:00.000Z",
        modality: "laser",
        session_notes: "Full-face laser pass.",
        next_session_note: "Reduce fluence next time",
      },
      blocks: [],
      laserEntries,
      hasLiveElectrolysisEntries: false,
    });
    expect(m.notes.hasAny).toBe(true);
    expect(m.notes.general[0].text).toBe("Full-face laser pass.");
    expect(m.notes.forNextVisit?.text).toBe("Reduce fluence next time");
    const laserNote = m.notes.additional.find(
      (n) => n.source === "laser_observation_notes",
    );
    expect(laserNote?.text).toBe("Zone cleared well.\nNo adverse response.");
    expect(laserNote?.areaLabel).toBe("Chin");
    // The soft-deleted laser pass contributes nothing.
    expect(JSON.stringify(m)).not.toContain("GONE");
  });
});

// ---------------------------------------------------------------------------
// SAFETY
// ---------------------------------------------------------------------------

describe("safety", () => {
  it("37. a malformed candidate never produces a broken full-chart link", () => {
    // A session id is the only thing the link is built from; the model must
    // always carry the real one it selected.
    const m = memoryOf();
    expect(m.sessionId).toBe("s-charted");
    expect(m.sessionId).toBeTruthy();
    // A block with no area at all still gets a stable, non-empty key + label.
    const bare = memoryOf({
      blocks: [
        block({
          id: "b-bare",
          structured_areas: null,
          primary_area: null,
          side: null,
          block_name: null,
        }),
      ],
    });
    expect(bare.areas[0].key).toBe("b-bare");
    expect(bare.areas[0].areaLabel).toBe("Treatment area 1");
    expect(bare.areas[0].areaParts).toEqual([]);
  });

  it("38. the builder is pure — it mutates nothing it was handed", () => {
    const blocks = [block()];
    const snapshot = JSON.stringify(blocks);
    buildAppointmentPrepMemory({
      session: {
        id: "s",
        started_at: "2026-07-10T10:00:00.000Z",
        modality: "electrolysis",
        session_notes: "x",
        next_session_note: "y",
      },
      blocks,
    });
    expect(JSON.stringify(blocks)).toBe(snapshot);
  });

  it("39. a superseding empty session is reported, not silently hidden", () => {
    expect(memoryOf({ supersededByEmptySession: true }).supersededByEmptySession).toBe(
      true,
    );
    expect(memoryOf().supersededByEmptySession).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FALLBACK NARRATIVE OWNERSHIP MATRIX (final-review P2)
//
// A prep screen can hold narrative from two different visits at once: an older
// CHARTED treatment, and a newer visit never charted but carrying practitioner
// text. Before Session 1D the page rendered the newer row's session_notes
// unconditionally; a first repair surfaced it only when there was NO treatment
// card, so the newer text vanished behind an older treatment. These pin who
// owns which line, and that nothing is hidden or printed twice.
// ---------------------------------------------------------------------------

const NEWER = {
  sessionId: "s-aug5",
  startedAt: "2026-08-05T10:00:00.000Z",
  text: "Client reported new medication — review before treatment",
};
const OWN = {
  sessionId: "s-jul20",
  startedAt: "2026-07-20T10:00:00.000Z",
  text: "Tolerated well",
};

describe("fallback narrative ownership", () => {
  it("F1. a NEWER uncharted visit's legacy notes survive an older charted treatment", () => {
    const items = buildPrepFallbackNarrative({
      plan: null,
      legacySessionNotes: NEWER,
      cardSessionId: OWN.sessionId,
    });
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("session_notes");
    expect(items[0].text).toBe(NEWER.text);
    // Provenance: its OWN visit date, not the treatment's.
    expect(items[0].startedAt).toBe(NEWER.startedAt);
    expect(items[0].sessionId).toBe(NEWER.sessionId);
    expect(items[0].label).toBe("Legacy session notes");
  });

  it("F2. legacy notes belonging to the CARD's own session are not repeated", () => {
    const items = buildPrepFallbackNarrative({
      plan: null,
      legacySessionNotes: OWN,
      cardSessionId: OWN.sessionId,
    });
    expect(items).toEqual([]);
  });

  it("F3. identical plan + legacy note from the SAME visit is one fact, printed once", () => {
    const same = { sessionId: "s-1", startedAt: "2026-08-01T10:00:00.000Z", text: "Do not treat" };
    const items = buildPrepFallbackNarrative({
      plan: same,
      legacySessionNotes: same,
      cardSessionId: null,
    });
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("next_session_note");
  });

  it("F4. the SAME sentence on DIFFERENT visits keeps both, with provenance", () => {
    const shared = "Do not treat";
    const items = buildPrepFallbackNarrative({
      plan: { sessionId: "s-a", startedAt: "2026-08-05T10:00:00.000Z", text: shared },
      legacySessionNotes: { sessionId: "s-b", startedAt: "2026-07-01T10:00:00.000Z", text: shared },
      cardSessionId: null,
    });
    // Global text dedupe would erase one of two real facts.
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.sessionId)).size).toBe(2);
    expect(new Set(items.map((i) => i.startedAt)).size).toBe(2);
  });

  it("F5. a plan from one visit and legacy notes from another each keep their own date", () => {
    const items = buildPrepFallbackNarrative({
      plan: { sessionId: "s-a", startedAt: "2026-08-05T10:00:00.000Z", text: "Reduce fluence" },
      legacySessionNotes: { sessionId: "s-b", startedAt: "2026-07-01T10:00:00.000Z", text: "Legacy" },
      cardSessionId: null,
    });
    expect(items).toHaveLength(2);
    const bySource = Object.fromEntries(items.map((i) => [i.source, i]));
    expect(bySource.next_session_note.startedAt).toBe("2026-08-05T10:00:00.000Z");
    expect(bySource.session_notes.startedAt).toBe("2026-07-01T10:00:00.000Z");
    // Every item carries provenance, so neither is attributable to a treatment.
    expect(items.every((i) => Boolean(i.startedAt) && Boolean(i.sessionId))).toBe(true);
  });

  it("F6. an ordinary treatment with no external narrative renders no fallback", () => {
    expect(
      buildPrepFallbackNarrative({
        plan: { sessionId: OWN.sessionId, startedAt: OWN.startedAt, text: "plan" },
        legacySessionNotes: OWN,
        cardSessionId: OWN.sessionId,
      }),
    ).toEqual([]);
    expect(
      buildPrepFallbackNarrative({ plan: null, legacySessionNotes: null, cardSessionId: null }),
    ).toEqual([]);
  });

  it("F1b. with NO card, the plan is owned here and rendered", () => {
    const items = buildPrepFallbackNarrative({
      plan: NEWER,
      legacySessionNotes: null,
      cardSessionId: null,
    });
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("next_session_note");
    expect(items[0].label).toBe("For next visit");
  });

  it("F1c. with a card, the plan is NOT repeated — the card owns it via planSource", () => {
    const items = buildPrepFallbackNarrative({
      plan: NEWER,
      legacySessionNotes: null,
      cardSessionId: OWN.sessionId,
    });
    expect(items).toEqual([]);
  });

  it("keys are unique and carry no client-identifying data beyond the session id", () => {
    const items = buildPrepFallbackNarrative({
      plan: { sessionId: "s-a", startedAt: "2026-08-05T10:00:00.000Z", text: "a" },
      legacySessionNotes: { sessionId: "s-b", startedAt: "2026-07-01T10:00:00.000Z", text: "b" },
      cardSessionId: null,
    });
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });
});
