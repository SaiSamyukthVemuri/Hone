import { describe, expect, it } from "vitest";
import {
  observeCaution,
  observeLatestSetup,
} from "@/lib/sessions/prep-observations";
import type { PointOfCareBlock } from "@/lib/sessions/point-of-care-memory";

// POSITIVE PREP OBSERVATIONS.
//
// Two properties, and the second was a REAL regression caught by the browser
// lane rather than by any unit test — which is the whole argument for testing
// the practitioner's final surface:
//
//   1. absence of a block set is never an answer, only a skip;
//   2. the setup line paints the probe LABEL and never the probe LOT NUMBER.
//
// (2) matters because this line is on the COLLAPSED row. The lot is part of the
// full treatment record, which must not cross to the browser until the
// practitioner opens the disclosure and the server re-checks the appointment is
// hers. Building the line from the point-of-care card's `probeLine` string
// silently transported it for every row on the day.

const CANDIDATE = { id: "s1", started_at: "2026-03-12T14:00:00Z", modality: "electrolysis" };

function block(over: Partial<PointOfCareBlock> = {}): PointOfCareBlock {
  return {
    id: "b1",
    sort_order: 1,
    primary_area: "Chin",
    machine_frequency: "27.12 MHz",
    probe_label: "Ballet F3",
    probe_lot_number: "SENTINELLOT-0001",
    probe_lot_confirmed: true,
    mode: "thermo",
    energy_level: 14,
    caution_for_next_session: false,
    caution_note: null,
    structured_areas: [],
    entries: [],
    ...over,
  } as PointOfCareBlock;
}

const mapOf = (blocks: PointOfCareBlock[]) =>
  new Map<string, PointOfCareBlock[]>([[CANDIDATE.id, blocks]]);

describe("the setup line never transports a probe lot", () => {
  it("paints the probe LABEL and omits the lot entirely", () => {
    const setup = observeLatestSetup([CANDIDATE], mapOf([block()]));
    expect(setup?.line).toBe("27.12 MHz · Ballet F3 · Thermolysis · EL 14");
    expect(setup?.line).not.toContain("SENTINELLOT-0001");
    expect(setup?.line).not.toMatch(/Lot #/);
    expect(setup?.line).not.toMatch(/confirmed/i);
  });

  it("a block with ONLY a lot recorded contributes no setup at all", () => {
    // It must not fall back to the lot as "some setup". There is nothing
    // reproducible here, and the lot still may not cross.
    const setup = observeLatestSetup(
      [CANDIDATE],
      mapOf([
        block({
          machine_frequency: null,
          probe_label: null,
          mode: null,
          energy_level: null,
        }),
      ]),
    );
    expect(setup).toBeNull();
  });

  it("the legacy probe type/size path does not smuggle the lot either", () => {
    const setup = observeLatestSetup(
      [CANDIDATE],
      mapOf([block({ probe_label: null, probe_type: "F", probe_size: "3" } as Partial<PointOfCareBlock>)]),
    );
    expect(setup?.line ?? "").not.toContain("SENTINELLOT-0001");
  });
});

describe("an unread block set is a SKIP, never an answer", () => {
  it("a session missing from the map yields null, not a claim", () => {
    expect(observeLatestSetup([CANDIDATE], new Map())).toBeNull();
    expect(observeCaution([CANDIDATE], new Map())).toBeNull();
  });

  it("an EMPTY block list for a session yields null too", () => {
    expect(observeLatestSetup([CANDIDATE], mapOf([]))).toBeNull();
    expect(observeCaution([CANDIDATE], mapOf([]))).toBeNull();
  });

  it("the walk CONTINUES past a session whose blocks were not returned", () => {
    // The load-bearing behaviour: an unread session must not stop the search
    // and must not answer for the ones behind it.
    const newer = { id: "s-newer", started_at: "2026-04-01T10:00:00Z", modality: "electrolysis" };
    const older = CANDIDATE;
    const blocks = new Map<string, PointOfCareBlock[]>([
      [older.id, [block({ caution_note: "watch the jawline" })]],
      // `s-newer` is absent from the map entirely.
    ]);
    expect(observeCaution([newer, older], blocks)?.text).toContain(
      "watch the jawline",
    );
    expect(observeCaution([newer, older], blocks)?.sessionId).toBe(older.id);
  });
});

describe("the caution is the practitioner's own words", () => {
  it("passes the recorded note through in the shared area grammar", () => {
    const caution = observeCaution(
      [CANDIDATE],
      mapOf([block({ caution_note: "Avoid the jawline" })]),
    );
    expect(caution?.text).toBe("Chin: Avoid the jawline");
  });

  it("a bare caution FLAG with no note still speaks", () => {
    const caution = observeCaution(
      [CANDIDATE],
      mapOf([block({ caution_for_next_session: true, caution_note: null })]),
    );
    expect(caution?.text).toBe("Chin: flagged to watch.");
  });

  it("a block with no caution at all yields null, and says nothing", () => {
    expect(observeCaution([CANDIDATE], mapOf([block()]))).toBeNull();
  });
});
