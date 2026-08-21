import { describe, expect, it } from "vitest";
import {
  observeCaution,
  observeLatestSetup,
} from "@/lib/sessions/prep-observations";
import type { PointOfCareBlock } from "@/lib/sessions/point-of-care-memory";
import {
  classifyBlockReadCoverage,
  type BlockReadCoverage,
} from "@/lib/sessions/block-read-coverage";

const COMPLETE: BlockReadCoverage = { kind: "complete" };

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
    const setup = observeLatestSetup([CANDIDATE], mapOf([block()]), COMPLETE);
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
      COMPLETE,
    );
    expect(setup).toBeNull();
  });

  it("the legacy probe type/size path does not smuggle the lot either", () => {
    const setup = observeLatestSetup(
      [CANDIDATE],
      mapOf([block({ probe_label: null, probe_type: "F", probe_size: "3" } as Partial<PointOfCareBlock>)]),
      COMPLETE,
    );
    expect(setup?.line ?? "").not.toContain("SENTINELLOT-0001");
  });
});

describe("an unread block set is a SKIP, never an answer", () => {
  it("a session missing from the map yields null, not a claim", () => {
    expect(observeLatestSetup([CANDIDATE], new Map(), COMPLETE)).toBeNull();
    expect(observeCaution([CANDIDATE], new Map())).toBeNull();
  });

  it("an EMPTY block list for a session yields null too", () => {
    expect(observeLatestSetup([CANDIDATE], mapOf([]), COMPLETE)).toBeNull();
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

// ===========================================================================
// RECENCY AUTHORITY (P1 on #611).
// ===========================================================================
//
// A SUPERLATIVE is not a positive fact. "Latest setup" asserts a RANKING —
// that nothing newer and relevant exists — and positive evidence cannot carry
// that: the older setup really was recorded, and a newer one really may sit in
// a row the bounded read never returned.
//
// The defect: `observeLatestSetup` skipped a candidate whose blocks were absent
// from the map, which silently asserts "that session had no setup". Under a
// truncated read it had not been READ. Continuing to an older candidate then
// returned a setup the Dashboard labels "Latest".

const NEWER = { id: "s-newer", started_at: "2026-04-01T10:00:00Z", modality: "electrolysis" };
const OLDER = { id: "s-older", started_at: "2026-03-01T10:00:00Z", modality: "electrolysis" };

/** Newest-first, exactly as `chartedSessionCandidates` returns them. */
const WINDOW = [NEWER, OLDER];

const TRUNCATED: BlockReadCoverage = {
  kind: "possibly_truncated",
  returned: 1000,
  limit: 1000,
};

/** Only the OLDER session's blocks came back. The newer one's are unread. */
const OLDER_ONLY = new Map<string, PointOfCareBlock[]>([
  [OLDER.id, [block({ id: "b-older", machine_frequency: "13.56 MHz" })]],
]);

describe("1. COMPLETE BELOW CAP — the older setup IS the latest concrete setup", () => {
  it("returns it, because the newer session was READ and genuinely has none", () => {
    // Coverage is complete, so the newer candidate's absence from the map is
    // authoritative: it has no live blocks, therefore no recorded setup. The
    // older setup is then correctly the latest concrete one — which is exactly
    // the behaviour the retired pipeline had, and it must not regress.
    const setup = observeLatestSetup(WINDOW, OLDER_ONLY, COMPLETE);
    expect(setup?.sessionId).toBe(OLDER.id);
    expect(setup?.line).toContain("13.56 MHz");
  });
});

describe("2. CAPPED, NEWER BLOCKS OMITTED — no stale 'Latest setup'", () => {
  it("suppresses the line rather than promoting an older setup", () => {
    // THE P1. Same map, same older setup, one thing different: we can no longer
    // prove the newer session has none. The observation is withheld.
    expect(observeLatestSetup(WINDOW, OLDER_ONLY, TRUNCATED)).toBeNull();
  });

  it("suppression does NOT depend on the older setup being absent", () => {
    // The older setup is a perfectly good observation. What is unprovable is
    // the RANKING, so it is the ranking that is withheld — not the evidence.
    expect(observeLatestSetup([OLDER], OLDER_ONLY, TRUNCATED)?.line).toContain(
      "13.56 MHz",
    );
  });

  it("a newer candidate that WAS read still answers under truncation", () => {
    // Truncation is not a blanket veto. When the newest candidate came back, no
    // newer row went unread, so the superlative is provable and is made.
    const bothRead = new Map<string, PointOfCareBlock[]>([
      [NEWER.id, [block({ id: "b-newer", machine_frequency: "27.12 MHz" })]],
      ...OLDER_ONLY,
    ]);
    const setup = observeLatestSetup(WINDOW, bothRead, TRUNCATED);
    expect(setup?.sessionId).toBe(NEWER.id);
    expect(setup?.line).toContain("27.12 MHz");
  });
});

describe("3. CAPPED — the older setup survives as internal evidence", () => {
  it("the data is still reachable; only the collapsed superlative is withheld", () => {
    // The distinction the operator drew: the fact may exist internally, the
    // latest-setup SURFACE must not overclaim it. Asking about the older
    // session alone still yields it.
    const scoped = observeLatestSetup([OLDER], OLDER_ONLY, TRUNCATED);
    expect(scoped).not.toBeNull();
    expect(scoped?.sessionId).toBe(OLDER.id);
  });
});

describe("4/5. THE CAP BOUNDARY — exactly full is treated as possibly truncated", () => {
  it("returned === limit is conservative", () => {
    // A response that exactly fills its bound is indistinguishable from one cut
    // at it: PostgREST returns 200 either way with no marker. Assuming 200
    // means complete is the mistake that produced this P1.
    expect(classifyBlockReadCoverage(1000, 1000)).toEqual({
      kind: "possibly_truncated",
      returned: 1000,
      limit: 1000,
    });
  });

  it("returned < limit is complete", () => {
    expect(classifyBlockReadCoverage(999, 1000)).toEqual({ kind: "complete" });
    expect(classifyBlockReadCoverage(0, 1000)).toEqual({ kind: "complete" });
  });

  it("over-full is truncated too — never treated as an impossible case", () => {
    expect(classifyBlockReadCoverage(1001, 1000).kind).toBe("possibly_truncated");
  });

  it("the boundary drives the observation, not just the classifier", () => {
    // End to end, so the two cannot drift: the same window and map give
    // opposite answers either side of the bound.
    const atCap = classifyBlockReadCoverage(1000, 1000);
    const belowCap = classifyBlockReadCoverage(999, 1000);
    expect(observeLatestSetup(WINDOW, OLDER_ONLY, atCap)).toBeNull();
    expect(observeLatestSetup(WINDOW, OLDER_ONLY, belowCap)).not.toBeNull();
  });
});

describe("6. the CAUTION is not gated — and that is a contract, not an oversight", () => {
  it("an older caution still surfaces under truncation", () => {
    // lib/sessions/clinical-summary.ts, pickPreClientWatchPlanSource:
    //   "a newer charted session WITHOUT notes no longer hides the previous
    //    session's still-relevant guidance."
    // Surfacing older guidance is the INTENDED behaviour, and "Caution: <text>"
    // claims only that this caution was recorded. It is a bare positive fact.
    const withCaution = new Map<string, PointOfCareBlock[]>([
      [OLDER.id, [block({ id: "b-older", caution_note: "Avoid the jawline" })]],
    ]);
    expect(observeCaution(WINDOW, withCaution)?.text).toContain(
      "Avoid the jawline",
    );
  });

  it("the caution observer takes no coverage argument at all", () => {
    // Structural, not conventional: there is no parameter through which a
    // future edit could accidentally gate it, and no parameter a reader has to
    // wonder about. The asymmetry with observeLatestSetup is the point.
    expect(observeCaution.length).toBe(2);
    expect(observeLatestSetup.length).toBe(3);
  });
});

describe("2b. CAPPED, NEWER BLOCKS PARTIALLY read — still no stale 'Latest setup'", () => {
  it("a newer candidate read WITHOUT setup cannot be walked past under truncation", () => {
    // The subtler half of the same defect, and the one a wholly-absent check
    // misses. A session's rows are cut by a GLOBAL sort_order bound, so we can
    // hold its low-numbered blocks and be missing exactly the ones that
    // recorded the settings. The blocks we did get carry no setup — that is not
    // evidence the session has none.
    const partiallyRead = new Map<string, PointOfCareBlock[]>([
      [
        NEWER.id,
        [
          block({
            id: "b-newer-1",
            machine_frequency: null,
            probe_label: null,
            mode: null,
            energy_level: null,
          }),
        ],
      ],
      ...OLDER_ONLY,
    ]);
    expect(observeLatestSetup(WINDOW, partiallyRead, TRUNCATED)).toBeNull();
  });

  it("…but under COMPLETE coverage the same shape answers normally", () => {
    // Complete coverage makes "these blocks carry no setup" authoritative, so
    // the walk moves on and the older setup IS the latest concrete one.
    const fullyRead = new Map<string, PointOfCareBlock[]>([
      [
        NEWER.id,
        [
          block({
            id: "b-newer-1",
            machine_frequency: null,
            probe_label: null,
            mode: null,
            energy_level: null,
          }),
        ],
      ],
      ...OLDER_ONLY,
    ]);
    expect(observeLatestSetup(WINDOW, fullyRead, COMPLETE)?.sessionId).toBe(
      OLDER.id,
    );
  });

  it("the gate is NOT blanket — a readable newest candidate still answers", () => {
    // Truncation must not silently empty the surface for a whole busy day. The
    // walk suppresses only when it would have to move PAST something it could
    // not read; when the newest candidate answers, nothing was skipped.
    const newestAnswers = new Map<string, PointOfCareBlock[]>([
      [NEWER.id, [block({ id: "b-newer", machine_frequency: "27.12 MHz" })]],
    ]);
    expect(observeLatestSetup(WINDOW, newestAnswers, TRUNCATED)?.sessionId).toBe(
      NEWER.id,
    );
  });
});
