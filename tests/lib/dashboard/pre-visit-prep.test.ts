import { describe, expect, it } from "vitest";

// THE LOAD-BEARING MATRIX for selected-day preparation.
//
// WHY THESE ASSERT RENDERED HTML
// ------------------------------
// PR #608's failure history is, repeatedly, the same testing mistake: the
// changed LAYER was proved correct and the practitioner's final surface was
// not. A loader returning the right field is not evidence that Chloe sees the
// right line, and four of the five defects lived in the gap between them.
//
// So every case below builds the real projection with the real builder and
// renders the real component through react-dom/server, then asserts on the
// MARKUP. `renderToStaticMarkup` is already the harness's idiom for exactly
// this reason (tests/app/reliability/authenticated-error-boundary.test.ts).
//
// THE ONE RULE THEY ALL TEST
// --------------------------
// A fact we observed may be rendered. A row we did not read renders NOTHING.
// Not a hedge, not "Not recorded", not "New client" — nothing.

const { renderToStaticMarkup } = await import("react-dom/server");
import { createElement } from "react";
import { buildPreVisitPrep } from "@/lib/dashboard/prep/build-pre-visit-prep";
import { PreVisitPrepBlock } from "@/app/(app)/dashboard/pre-visit-prep-block";
import type { AppointmentPrepLoad } from "@/lib/sessions/last-treatment-loader";

// ---------------------------------------------------------------------------
// Fixtures. Deliberately built from the loader's real return shape so a change
// to that contract breaks these rather than sliding past them.
// ---------------------------------------------------------------------------

const SESSION_ID = "sess-prior";
const STARTED = "2026-03-12T14:00:00.000Z";

function block(over: Record<string, unknown> = {}) {
  return {
    id: "blk-1",
    sort_order: 1,
    primary_area: "Chin",
    probe_lot_number: "LOT-42",
    machine_frequency: "27.12 MHz",
    probe_label: "Ballet F3",
    mode: "therm",
    energy_level: 14,
    caution_for_next_session: false,
    caution_note: null,
    structured_areas: [],
    entries: [],
    ...over,
  };
}

function session(over: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    started_at: STARTED,
    modality: "electrolysis",
    record_status: "active",
    deleted_at: null,
    appointment_id: null,
    session_notes: null,
    next_session_note: null,
    aftercare_and_risks_explained_at: "2026-03-12T15:00:00.000Z",
    electrolysis_entries: [],
    laser_entries: [],
    ...over,
  };
}

function load(over: Partial<AppointmentPrepLoad> = {}): AppointmentPrepLoad {
  return {
    treatment: null,
    unavailable: false,
    narrative: { plan: null, legacySessionNotes: null },
    observed: { caution: null, latestSetup: null },
    ...over,
  } as AppointmentPrepLoad;
}

const CLIENT = {
  id: "client-1",
  date_of_birth: "1990-01-01",
  phone: "+15550100",
  address: "1 Main St",
};

/** Render BOTH days from one projection. Parity is the point, so it is not optional. */
function render(args: Parameters<typeof buildPreVisitPrep>[0]) {
  const prep = buildPreVisitPrep(args);
  // createElement, not JSX: the unit lane includes only `*.test.ts`, and moving
  // this file to .tsx would mean editing vitest.config.ts — a FULL-MATRIX path.
  // Same idiom as tests/app/reliability/authenticated-error-boundary.test.ts.
  const today = renderToStaticMarkup(
    createElement(PreVisitPrepBlock, { prep, viewingToday: true }),
  );
  const otherDay = renderToStaticMarkup(
    createElement(PreVisitPrepBlock, { prep, viewingToday: false }),
  );
  return { prep, today, otherDay, both: [today, otherDay] as const };
}

/** Every sentence this surface is forbidden to produce from an unread collection. */
const FORBIDDEN = [
  /No watch\/plan note/i,
  /Not recorded/i,
  /New client/i,
  /No charted history/i,
  /Treatment area not recorded/i,
  /No prior charted treatment/i,
  /no history/i,
] as const;

function expectNoAbsenceClaim(markup: string) {
  for (const pattern of FORBIDDEN) {
    expect(markup, `forbidden absence claim: ${pattern}`).not.toMatch(pattern);
  }
}

const PLAN = { sessionId: SESSION_ID, startedAt: STARTED, text: "Started doxycycline, do not treat" };
const CAUTION = { sessionId: SESSION_ID, startedAt: STARTED, text: "Chin: watch for hyperpigmentation" };
const SETUP = { sessionId: SESSION_ID, startedAt: STARTED, line: "27.12 MHz · Ballet F3 · Thermolysis · EL 14", areaLabel: "Chin" };

// ---------------------------------------------------------------------------

describe("1. NOTE-ONLY VISIT — a plan with no charting still reaches her", () => {
  // The prior visit was a consultation, or was abandoned after a modality tap.
  // `start_session` creates the row immediately and `set_next_session_note` has
  // no charting gate, so this row legitimately carries a safety instruction and
  // zero blocks. The retired model made that instruction structurally
  // unreachable, because its `hasHistory: false` branch bypassed the renderer.
  const args = {
    load: load({ narrative: { plan: PLAN, legacySessionNotes: null } }),
    client: CLIENT,
    compactSummary: null,
  };

  it("Remember is visible on Today AND on a selected day", () => {
    const { both } = render(args);
    for (const markup of both) {
      expect(markup).toContain("Started doxycycline, do not treat");
      expect(markup).toContain("Remember:");
    }
  });

  it("it renders EXACTLY ONCE on each — never twice under two labels", () => {
    const { today, otherDay } = render(args);
    for (const markup of [today, otherDay]) {
      // ONE rendered line. The note also appears in the `title` attribute —
      // the desktop hover affordance production already had — so the count is
      // taken on the visible text node, not on raw occurrences.
      expect((markup.match(/Remember:/g) ?? []).length).toBe(1);
      expect(
        (markup.match(/Remember: Started doxycycline, do not treat/g) ?? [])
          .length,
      ).toBe(1);
      expect(
        (markup.match(/title="Started doxycycline, do not treat"/g) ?? []).length,
      ).toBe(1);
    }
  });

  it("no treatment is fabricated, and no absence is claimed", () => {
    const { prep, both } = render(args);
    expect(prep.lastTreatment).toBeUndefined();
    for (const markup of both) {
      expect(markup).not.toContain("Last treatment");
      expectNoAbsenceClaim(markup);
    }
  });

  it("only the temporal label differs between the two days", () => {
    const { today, otherDay } = render(args);
    expect(today).toContain("Before today");
    expect(otherDay).toContain("Before this visit");
    // Same evidence, same facts: the markup differs ONLY in that label.
    expect(today.replace("Before today", "X")).toBe(
      otherDay.replace("Before this visit", "X"),
    );
  });
});

describe("2. POSITIVE CAUTION — a caution we read is shown", () => {
  it("renders on both days, in the rose convention, distinct from Remember", () => {
    const { both } = render({
      load: load({ observed: { caution: CAUTION, latestSetup: null } }),
      client: CLIENT,
      compactSummary: null,
    });
    for (const markup of both) {
      expect(markup).toContain("Caution:");
      expect(markup).toContain("Chin: watch for hyperpigmentation");
      expect(markup).toContain("text-rose-900");
      expectNoAbsenceClaim(markup);
    }
  });

  it("a caution WITHOUT a plan note still renders — they are independent", () => {
    const { prep, both } = render({
      load: load({ observed: { caution: CAUTION, latestSetup: null } }),
      client: CLIENT,
      compactSummary: null,
    });
    expect(prep.remember).toBeUndefined();
    for (const markup of both) {
      expect(markup).toContain("Caution:");
      expect(markup).not.toContain("Remember:");
      // …and the absence of a plan note is NOT narrated.
      expect(markup).not.toMatch(/No watch\/plan note/i);
    }
  });
});

describe("3. POSITIVE SETUP — a concrete setup we read is shown", () => {
  it("renders the recorded setup on both days", () => {
    const { both } = render({
      load: load({ observed: { caution: null, latestSetup: SETUP } }),
      client: CLIENT,
      compactSummary: null,
    });
    for (const markup of both) {
      expect(markup).toContain("Latest setup:");
      expect(markup).toContain("27.12 MHz · Ballet F3 · Thermolysis · EL 14");
      expectNoAbsenceClaim(markup);
    }
  });
});

describe("4. SELECTED TREATMENT — a safe previous treatment is shown", () => {
  it("renders the compact identity on both days", () => {
    const { prep, both } = render({
      load: load({
        treatment: {
          session: session(),
          blocks: [block()],
          supersededByEmptySession: false,
        },
      } as Partial<AppointmentPrepLoad>),
      client: CLIENT,
      compactSummary: "12 Mar 2026 · electrolysis · Chin · 25 min",
    });
    expect(prep.lastTreatment?.compactSummary).toBe(
      "12 Mar 2026 · electrolysis · Chin · 25 min",
    );
    for (const markup of both) expectNoAbsenceClaim(markup);
  });
});

describe("5. GLOBAL HISTORY CAP — dropped older rows create no negative claim", () => {
  // The batched candidate read shares one row budget across every client of the
  // day, so a client with a long history can crowd out a quieter one. The
  // loader reports that as `unavailable`; what must NOT happen is a sentence.
  it("retained positive facts still render, and nothing denies the rest", () => {
    const { both } = render({
      load: load({
        unavailable: true,
        narrative: { plan: PLAN, legacySessionNotes: null },
        observed: { caution: CAUTION, latestSetup: null },
      }),
      client: CLIENT,
      compactSummary: null,
    });
    for (const markup of both) {
      expect(markup).toContain("Started doxycycline, do not treat");
      expect(markup).toContain("Chin: watch for hyperpigmentation");
      expectNoAbsenceClaim(markup);
    }
  });
});

describe("6. PER-CLIENT SLICE — the 26th row falling outside the window says nothing", () => {
  // `chartedSessionCandidates` slices each client to the newest 25 AFTER
  // filtering, and that slice has no truncation channel of its own. Under the
  // old model an all-uncharted prefix produced "New client".
  it("a window that found nothing produces NO claim at all", () => {
    const { prep, both } = render({
      load: load(),
      client: CLIENT,
      compactSummary: null,
    });
    expect(prep.lastTreatment).toBeUndefined();
    expect(prep.remember).toBeUndefined();
    for (const markup of both) expectNoAbsenceClaim(markup);
  });
});

describe("7. BLOCK COLLECTION CAP — the exact defect that closed PR #608", () => {
  // The session was selected from its EMBEDDED live entries, and its
  // `session_blocks` rows were not returned by the bounded batch read. The old
  // model derived "Treatment area not recorded" from `blockLots.length === 0`
  // and "Latest setup: Not recorded" from an empty intelligence fold.
  const args = {
    load: load({
      treatment: {
        // Charted on its entries; ZERO blocks came back.
        session: session({
          electrolysis_entries: [
            { id: "e1", block_id: null, deleted_at: null, created_at: STARTED },
          ],
        }),
        blocks: [],
        supersededByEmptySession: false,
      },
      // No caution and no setup were OBSERVED, because no block was read.
      observed: { caution: null, latestSetup: null },
    } as Partial<AppointmentPrepLoad>),
    client: CLIENT,
    compactSummary: "12 Mar 2026 · electrolysis",
  };

  it("does NOT say 'Treatment area not recorded'", () => {
    const { both } = render(args);
    for (const markup of both) {
      expect(markup).not.toMatch(/Treatment area not recorded/i);
    }
  });

  it("does NOT say 'Latest setup: Not recorded'", () => {
    const { both } = render(args);
    for (const markup of both) {
      expect(markup).not.toMatch(/Latest setup/);
      expect(markup).not.toMatch(/Not recorded/i);
    }
  });

  it("concrete SESSION-ROW facts still survive", () => {
    // The aftercare scalar lives on the session row we DID read, so it is
    // unaffected by the block set being short. This is the case-(A)/case-(B)
    // split made visible: one survives, the other simply is not spoken.
    const { prep } = render({
      ...args,
      load: load({
        ...args.load,
        treatment: {
          ...args.load.treatment!,
          session: session({ aftercare_and_risks_explained_at: null }),
        },
      } as Partial<AppointmentPrepLoad>),
    });
    const sources = prep.directRecordReminders.map((r) => r.sourceField);
    expect(sources).toContain("sessions.aftercare_and_risks_explained_at");
  });

  it("no probe-lot chip is invented from the absent blocks", () => {
    // A block that was not returned cannot manufacture a null lot. The chip is
    // SUPPRESSED (an omission), never fabricated.
    const { prep } = render(args);
    expect(prep.directRecordReminders.map((r) => r.sourceField)).not.toContain(
      "session_blocks.probe_lot_number",
    );
  });
});

describe("8. DIRECT SCALAR NULL — a licensed reminder MAY render", () => {
  it("a returned BLOCK with a null probe lot licenses the chip", () => {
    const { prep, both } = render({
      load: load({
        treatment: {
          session: session(),
          blocks: [block({ probe_lot_number: null })],
          supersededByEmptySession: false,
        },
      } as Partial<AppointmentPrepLoad>),
      client: CLIENT,
      compactSummary: "12 Mar 2026",
    });
    const chip = prep.directRecordReminders.find(
      (r) => r.sourceField === "session_blocks.probe_lot_number",
    );
    expect(chip?.text).toBe("Probe lot missing");
    for (const markup of both) expect(markup).toContain("Probe lot missing");
  });

  it("PROOF it is field-nullness and not collection membership", () => {
    // THE DISTINCTION, asserted rather than asserted-about. With the SAME
    // absent value the two shapes give opposite answers:
    //   a returned row whose column is null -> a chip
    //   no row at all                       -> nothing
    const withRow = buildPreVisitPrep({
      load: load({
        treatment: {
          session: session(),
          blocks: [block({ probe_lot_number: null })],
          supersededByEmptySession: false,
        },
      } as Partial<AppointmentPrepLoad>),
      client: CLIENT,
      compactSummary: null,
    });
    const withoutRow = buildPreVisitPrep({
      load: load({
        treatment: {
          session: session(),
          blocks: [], // the collection is empty — same "no lot" in effect
          supersededByEmptySession: false,
        },
      } as Partial<AppointmentPrepLoad>),
      client: CLIENT,
      compactSummary: null,
    });
    expect(withRow.directRecordReminders.map((r) => r.sourceField)).toContain(
      "session_blocks.probe_lot_number",
    );
    expect(
      withoutRow.directRecordReminders.map((r) => r.sourceField),
    ).not.toContain("session_blocks.probe_lot_number");
    // And every chip names the exact scalar that licensed it.
    for (const r of withRow.directRecordReminders) {
      expect(r.sourceField).toMatch(/^(sessions|session_blocks|clients)\.\w+$/);
    }
  });

  it("the client record chips need the appointment's OWN client row", () => {
    const missingDob = buildPreVisitPrep({
      load: load(),
      client: { ...CLIENT, date_of_birth: null },
      compactSummary: null,
    });
    expect(missingDob.directRecordReminders.map((r) => r.text)).toContain(
      "Date of birth missing from record",
    );
    // …and an UNREAD client row claims nothing about the client's record. One
    // missing parent row used to fire all three chips at once.
    const unread = buildPreVisitPrep({
      load: load(),
      client: null,
      compactSummary: null,
    });
    expect(unread.directRecordReminders).toEqual([]);
  });

  it("a recorded ZERO is not treated as missing", () => {
    const zero = buildPreVisitPrep({
      load: load({
        treatment: {
          session: session(),
          blocks: [block({ probe_lot_number: "0" })],
          supersededByEmptySession: false,
        },
      } as Partial<AppointmentPrepLoad>),
      client: CLIENT,
      compactSummary: null,
    });
    expect(zero.directRecordReminders.map((r) => r.sourceField)).not.toContain(
      "session_blocks.probe_lot_number",
    );
  });
});

describe("9. BLOCK READ FAILURE — the narrative survives, nothing is denied", () => {
  const args = {
    load: load({
      unavailable: true,
      narrative: { plan: PLAN, legacySessionNotes: null },
      observed: { caution: null, latestSetup: null },
    }),
    client: CLIENT,
    compactSummary: null,
  };

  it("Remember survives a failed block read", () => {
    // `newestPlanOf` runs on the candidate rows BEFORE the block read, which is
    // exactly why this is recoverable.
    const { both } = render(args);
    for (const markup of both) {
      expect(markup).toContain("Started doxycycline, do not treat");
    }
  });

  it("no fake absence statement accompanies the failure", () => {
    const { both } = render(args);
    for (const markup of both) expectNoAbsenceClaim(markup);
  });

  it("the failure is recorded as an OBSERVED operational fact", () => {
    const { prep } = render(args);
    expect(prep.loadFailure).toEqual({ reason: "read_error" });
  });

  it("the Dashboard remains usable — the block still renders", () => {
    const { both } = render(args);
    for (const markup of both) expect(markup.length).toBeGreaterThan(0);
  });
});

describe("14. NO POSITIVE FACT — quiet omission, not a sentence", () => {
  it("renders NOTHING AT ALL when nothing was observed", () => {
    const { prep, today, otherDay } = render({
      load: load(),
      client: null,
      compactSummary: null,
    });
    expect(prep.directRecordReminders).toEqual([]);
    // The whole block is absent. Not a hedge, not an empty shell, not a label
    // with nothing under it — the old model printed a relationship line here.
    expect(today).toBe("");
    expect(otherDay).toBe("");
  });

  it("a load failure alone is enough to render (it is an observation)", () => {
    const { today } = render({
      load: load({ unavailable: true }),
      client: null,
      compactSummary: null,
    });
    expect(today).not.toBe("");
    expect(today).toContain("Before today");
    expectNoAbsenceClaim(today);
  });
});
