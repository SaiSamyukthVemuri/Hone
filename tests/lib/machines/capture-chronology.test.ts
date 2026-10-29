import { describe, expect, it } from "vitest";

import { changesWithin, chronology } from "@/lib/machines/capture-chronology";
import type { RecordedReading } from "@/lib/machines/machine-queries";

// ===========================================================================
// THE CHRONOLOGY OF ONE TREATMENT'S MACHINE SETTINGS.
//
// THE DEFECT BEHIND IT, because this file is otherwise just shape-shuffling:
// a recorded capture is PERMANENT AND INVISIBLE. Nothing in the application
// reads what has already been recorded against the block being charted.
// `setup_capture_history_for_block` is granted to `authenticated` and called
// only by DB tests; `readingsForBlockAction` is exported and no component
// calls it. The only thing a practitioner sees is the entry form's own
// confirmation, which lives in component state and dies on the next load.
//
// She records 120 µA, the page reloads, the chart shows her nothing, and her
// options are to record it again - appending a second immutable capture
// indistinguishable from a genuine mid-treatment change - or to guess.
//
// THE RETRY KEY DOES NOT COVER THIS. It makes a retry safe within one mount.
// A fresh mount mints a new key, so re-entering the same numbers after a
// reload is a new save by every measure the database has. Only showing her
// what is already there prevents it.
// ===========================================================================

const base = {
  blockId: "block-1",
  deviceId: "dev-1",
  profileId: "fixture:panel",
  profileVersion: 2,
  modeKey: "galvanic",
  stageKey: null,
  nativeUnit: "µA",
  decimals: 0,
} satisfies Partial<RecordedReading>;

function reading(o: {
  captureId?: string | null;
  groupKey?: string;
  revision?: number;
  recordedAt: string;
  fieldKey?: string;
  value?: number;
  absent?: "not-recorded" | "not-applicable" | "not-legible";
  channels?: number[];
  modeKey?: string;
  profileVersion?: number;
  decimals?: number;
  deviceId?: string;
}): RecordedReading {
  return {
    ...base,
    captureId: o.captureId === undefined ? "cap-1" : o.captureId,
    groupKey: o.groupKey ?? "g1",
    revision: o.revision ?? 1,
    recordedAt: o.recordedAt,
    fieldKey: o.fieldKey ?? "current",
    channels: o.channels ?? [],
    modeKey: o.modeKey ?? base.modeKey,
    deviceId: o.deviceId ?? base.deviceId,
    profileVersion: o.profileVersion ?? base.profileVersion,
    decimals: o.decimals ?? base.decimals,
    value:
      o.absent !== undefined
        ? { kind: "absent", reason: o.absent }
        : { kind: "value", value: o.value ?? 120 },
  } as RecordedReading;
}

describe("grouping readings into the captures they belong to", () => {
  it("returns nothing for nothing", () => {
    expect(chronology([])).toEqual([]);
  });

  it("puts every reading of one capture in ONE entry", () => {
    // GROUPED BY CAPTURE because that is the unit that was recorded. A
    // per-field view can pair a current from one capture with a duration from
    // another and show a setup that never existed - the defect
    // latest_setup_for_client was repaired for.
    const out = chronology([
      reading({ recordedAt: "2026-10-14T10:00:00Z", fieldKey: "duration", value: 300 }),
      reading({ recordedAt: "2026-10-14T10:00:00Z", fieldKey: "current", value: 120 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.captureId).toBe("cap-1");
    // Fields in a stable order, so two loads render the same thing.
    expect(out[0]!.readings.map((r) => r.fieldKey)).toEqual(["current", "duration"]);
  });

  it("orders captures OLDEST FIRST", () => {
    const out = chronology([
      reading({ captureId: "cap-2", revision: 2, recordedAt: "2026-10-14T10:30:00Z", value: 150 }),
      reading({ captureId: "cap-1", revision: 1, recordedAt: "2026-10-14T10:00:00Z", value: 120 }),
    ]);
    expect(out.map((e) => e.captureId)).toEqual(["cap-1", "cap-2"]);
  });

  it("breaks a TIE by group then revision, so the order is stable", () => {
    // Two groups of one save often share a timestamp to the precision stored.
    // An unstable order would render the same data differently on two loads.
    const at = "2026-10-14T10:00:00Z";
    const out = chronology([
      reading({ captureId: "cap-b", groupKey: "g2", recordedAt: at }),
      reading({ captureId: "cap-a", groupKey: "g1", recordedAt: at }),
    ]);
    expect(out.map((e) => e.groupKey)).toEqual(["g1", "g2"]);
  });

  it("keeps two groups of ONE save as two entries", () => {
    // They are two facts. Merging them would assert she ran both probes at
    // one setting, and nothing may present them as observed together.
    const at = "2026-10-14T10:00:00Z";
    const out = chronology([
      reading({ captureId: "cap-a", groupKey: "g1", channels: [1], recordedAt: at, value: 120 }),
      reading({ captureId: "cap-b", groupKey: "g2", channels: [2], recordedAt: at, value: 80 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.channels)).toEqual([[1], [2]]);
  });

  it("does NOT merge separate LEGACY captures that have no capture id", () => {
    // A null capture id is a real case - a reading recorded before captures
    // existed. Keying every null under "null" would merge separate legacy
    // captures into one entry and invent a setup from their union, which is
    // the per-field composite this grouping exists to prevent.
    const out = chronology([
      reading({ captureId: null, revision: 1, recordedAt: "2026-10-14T09:00:00Z", value: 100 }),
      reading({ captureId: null, revision: 2, recordedAt: "2026-10-14T09:30:00Z", value: 110 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.captureId)).toEqual([null, null]);
    expect(out.map((e) => e.revision)).toEqual([1, 2]);
  });
});

describe("what counts as a CHANGE of setting", () => {
  const twoCaptures = (a: number, b: number) =>
    chronology([
      reading({ captureId: "cap-1", revision: 1, recordedAt: "2026-10-14T10:00:00Z", value: a }),
      reading({ captureId: "cap-2", revision: 2, recordedAt: "2026-10-14T10:30:00Z", value: b }),
    ]);

  it("reports a field recorded again at a different value", () => {
    const changes = changesWithin(twoCaptures(120, 150));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.fieldKey).toBe("current");
    expect(changes[0]!.from.value).toEqual({ kind: "value", value: 120 });
    expect(changes[0]!.to.value).toEqual({ kind: "value", value: 150 });
  });

  it("refuses to call the SAME value a change", () => {
    // She re-read the machine and it still said 120. That is another capture,
    // and calling it a change invents an adjustment she did not make.
    expect(changesWithin(twoCaptures(120, 120))).toEqual([]);
  });

  it("compares the VALUE alone, not how it is displayed", () => {
    // THIS TEST WAS VACUOUS IN ITS FIRST FORM and a negative control caught
    // it. It asserted that "120 and 120.0 are the same setting, where
    // comparing the stored strings would announce a change" - but `value` is
    // a number by type, so the literal 120.0 IS 120 and String(120.0) IS
    // "120". No mutation could make it fail, and the comment it carried
    // overclaimed a hazard that does not exist at this layer.
    //
    // The real claim, which IS testable: `decimals` and `nativeUnit` travel
    // with every reading and are properties of the CONTRACT it was recorded
    // under, not of the setting. The same number at a different declared
    // precision is the same setting, so folding that into the comparison
    // would announce an adjustment she never made.
    const out = chronology([
      reading({ captureId: "cap-1", recordedAt: "2026-10-14T10:00:00Z", value: 120 }),
      reading({
        captureId: "cap-2",
        revision: 2,
        recordedAt: "2026-10-14T10:30:00Z",
        value: 120,
        decimals: 2,
      }),
    ]);
    // The fixture really does differ in precision, or this is vacuous again.
    expect(out[0]!.readings[0]!.decimals).not.toBe(out[1]!.readings[0]!.decimals);
    expect(changesWithin(out)).toEqual([]);
  });

  it("never pairs the same field across DIFFERENT GROUPS", () => {
    // Two probes at different settings are not one setting that changed.
    const out = chronology([
      reading({ captureId: "cap-1", groupKey: "g1", recordedAt: "2026-10-14T10:00:00Z", value: 120 }),
      reading({ captureId: "cap-2", groupKey: "g2", recordedAt: "2026-10-14T10:30:00Z", value: 80 }),
    ]);
    expect(changesWithin(out)).toEqual([]);
  });

  it("never pairs across MODES", () => {
    // The same field key can mean something else under another mode - the
    // fixtures in this feature include that case deliberately - so the two
    // numbers are not comparable at all.
    const out = chronology([
      reading({ captureId: "cap-1", recordedAt: "2026-10-14T10:00:00Z", value: 120 }),
      reading({
        captureId: "cap-2",
        recordedAt: "2026-10-14T10:30:00Z",
        value: 8,
        modeKey: "blend",
      }),
    ]);
    expect(changesWithin(out)).toEqual([]);
  });

  it("never pairs across PROFILE VERSIONS", () => {
    // A re-registration can change the field's unit or precision, so the
    // older number is not comparable with the newer one.
    const out = chronology([
      reading({ captureId: "cap-1", recordedAt: "2026-10-14T10:00:00Z", value: 120 }),
      reading({
        captureId: "cap-2",
        recordedAt: "2026-10-14T10:30:00Z",
        value: 150,
        profileVersion: 3,
      }),
    ]);
    expect(changesWithin(out)).toEqual([]);
  });

  it("reports nothing when a field was recorded only once", () => {
    expect(
      changesWithin(chronology([reading({ recordedAt: "2026-10-14T10:00:00Z" })])),
    ).toEqual([]);
  });

  it("reports a value becoming an ABSENCE, and the reason", () => {
    // Honest: she recorded 120, then recorded that it was not legible. That
    // IS a change in the record and hiding it would lose it.
    const out = chronology([
      reading({ captureId: "cap-1", recordedAt: "2026-10-14T10:00:00Z", value: 120 }),
      reading({
        captureId: "cap-2",
        recordedAt: "2026-10-14T10:30:00Z",
        absent: "not-legible",
      }),
    ]);
    const changes = changesWithin(out);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.to.value).toEqual({ kind: "absent", reason: "not-legible" });
  });

  it("does NOT call two identical absences a change", () => {
    const out = chronology([
      reading({ captureId: "cap-1", recordedAt: "2026-10-14T10:00:00Z", absent: "not-recorded" }),
      reading({ captureId: "cap-2", recordedAt: "2026-10-14T10:30:00Z", absent: "not-recorded" }),
    ]);
    expect(changesWithin(out)).toEqual([]);
  });

  it("DOES call two DIFFERENT absence reasons a change", () => {
    const out = chronology([
      reading({ captureId: "cap-1", recordedAt: "2026-10-14T10:00:00Z", absent: "not-recorded" }),
      reading({ captureId: "cap-2", recordedAt: "2026-10-14T10:30:00Z", absent: "not-legible" }),
    ]);
    expect(changesWithin(out)).toHaveLength(1);
  });

  it("walks a THREE-capture series as two steps, not one", () => {
    const out = chronology([
      reading({ captureId: "cap-1", revision: 1, recordedAt: "2026-10-14T10:00:00Z", value: 100 }),
      reading({ captureId: "cap-2", revision: 2, recordedAt: "2026-10-14T10:20:00Z", value: 120 }),
      reading({ captureId: "cap-3", revision: 3, recordedAt: "2026-10-14T10:40:00Z", value: 150 }),
    ]);
    const changes = changesWithin(out);
    expect(changes).toHaveLength(2);
    expect(changes.map((c) => [c.from.value, c.to.value])).toEqual([
      [{ kind: "value", value: 100 }, { kind: "value", value: 120 }],
      [{ kind: "value", value: 120 }, { kind: "value", value: 150 }],
    ]);
  });

  it("skips an unchanged middle capture rather than reporting a non-change", () => {
    // 100 -> 100 -> 150 is ONE change. Reporting the middle step would say she
    // adjusted something when she re-read the same number.
    const out = chronology([
      reading({ captureId: "cap-1", revision: 1, recordedAt: "2026-10-14T10:00:00Z", value: 100 }),
      reading({ captureId: "cap-2", revision: 2, recordedAt: "2026-10-14T10:20:00Z", value: 100 }),
      reading({ captureId: "cap-3", revision: 3, recordedAt: "2026-10-14T10:40:00Z", value: 150 }),
    ]);
    const changes = changesWithin(out);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.from.value).toEqual({ kind: "value", value: 100 });
    expect(changes[0]!.to.value).toEqual({ kind: "value", value: 150 });
  });

  it("tracks each FIELD separately within one group", () => {
    const out = chronology([
      reading({ captureId: "cap-1", recordedAt: "2026-10-14T10:00:00Z", fieldKey: "current", value: 120 }),
      reading({ captureId: "cap-1", recordedAt: "2026-10-14T10:00:00Z", fieldKey: "duration", value: 300 }),
      reading({ captureId: "cap-2", revision: 2, recordedAt: "2026-10-14T10:30:00Z", fieldKey: "current", value: 150 }),
      reading({ captureId: "cap-2", revision: 2, recordedAt: "2026-10-14T10:30:00Z", fieldKey: "duration", value: 300 }),
    ]);
    const changes = changesWithin(out);
    // The current changed; the duration did not.
    expect(changes.map((c) => c.fieldKey)).toEqual(["current"]);
  });

  it("orders changes OLDEST FIRST, matching the chronology", () => {
    const out = chronology([
      reading({ captureId: "cap-1", groupKey: "g1", recordedAt: "2026-10-14T10:00:00Z", value: 100 }),
      reading({ captureId: "cap-2", groupKey: "g1", revision: 2, recordedAt: "2026-10-14T10:40:00Z", value: 150 }),
      reading({ captureId: "cap-3", groupKey: "g2", recordedAt: "2026-10-14T10:10:00Z", value: 80 }),
      reading({ captureId: "cap-4", groupKey: "g2", revision: 2, recordedAt: "2026-10-14T10:20:00Z", value: 90 }),
    ]);
    const changes = changesWithin(out);
    expect(changes.map((c) => c.to.recordedAt)).toEqual([
      "2026-10-14T10:20:00Z",
      "2026-10-14T10:40:00Z",
    ]);
  });
});

describe("an INVERTED timestamp cannot reorder the CHRONOLOGY either", () => {
  // THE SAME FAULT ON THE SURFACE SHE READS (Codex, #860 4307914915).
  // `chronology` led on `recordedAt`, the transaction-start `now()`, so two
  // captures of one group could be listed opposite to their revisions -
  // "Recorded this treatment" showing capture 2 above capture 1. The change
  // series was fixed at 4307735447; this is the primary list.

  it("lists a series in REVISION order even when the timestamps invert", () => {
    const out = chronology([
      reading({ captureId: "cap-2", revision: 2, recordedAt: "2026-10-15T10:00:00Z", value: 130 }),
      reading({ captureId: "cap-1", revision: 1, recordedAt: "2026-10-15T10:05:00Z", value: 120 }),
    ]);
    expect(
      out.map((e) => e.revision),
      "the chronology listed capture 2 before capture 1",
    ).toEqual([1, 2]);
  });

  it("CONTROL: ordinary ascending timestamps are unchanged", () => {
    const out = chronology([
      reading({ captureId: "cap-1", revision: 1, recordedAt: "2026-10-15T10:00:00Z", value: 120 }),
      reading({ captureId: "cap-2", revision: 2, recordedAt: "2026-10-15T10:05:00Z", value: 130 }),
    ]);
    expect(out.map((e) => e.revision)).toEqual([1, 2]);
  });

  it("and two series that do NOT overlap stay in their own order", () => {
    // RE-NAMED, because the rule it used to state was the defect (Codex, #860
    // 4308767071). It said "each series is placed by its own earliest
    // capture", which is exactly what grouped whole series together. This
    // fixture has no overlap - every g1 capture precedes the g2 one - so the
    // expectation is the same under either rule, and it is the INTERLEAVED
    // case below that tells them apart.
    //
    // Revision still cannot lead globally: revisions are allocated per group,
    // so revision 1 of one series and revision 1 of another are not
    // comparable.
    const out = chronology([
      reading({ captureId: "b1", groupKey: "g2", revision: 1, recordedAt: "2026-10-15T11:00:00Z", value: 80 }),
      reading({ captureId: "a1", groupKey: "g1", revision: 1, recordedAt: "2026-10-15T10:00:00Z", value: 120 }),
      reading({ captureId: "a2", groupKey: "g1", revision: 2, recordedAt: "2026-10-15T10:30:00Z", value: 130 }),
    ]);
    expect(out.map((e) => `${e.groupKey}:${e.revision}`)).toEqual([
      "g1:1",
      "g1:2",
      "g2:1",
    ]);
  });

  it("and the order is STABLE when two captures share a timestamp", () => {
    // The same save's groups often share an instant to the precision stored,
    // and an unstable order would render the same data two ways on two loads.
    const rows = [
      reading({ captureId: "x", groupKey: "g2", revision: 1, recordedAt: "2026-10-15T10:00:00Z", value: 80 }),
      reading({ captureId: "y", groupKey: "g1", revision: 1, recordedAt: "2026-10-15T10:00:00Z", value: 120 }),
    ];
    const first = chronology(rows).map((e) => e.groupKey);
    const again = chronology([...rows].reverse()).map((e) => e.groupKey);
    expect(first).toEqual(again);
  });
});

describe("an INVERTED timestamp cannot reverse a change", () => {
  // THE DEFECT (Codex, #860 4307735447). `recorded_at` is the TRANSACTION-START
  // `now()`, so a long transaction can start first and commit second - leaving
  // two captures whose timestamps run opposite to their revisions. The series
  // took its order from `recordedAt`, so an inversion swapped a change's FROM
  // and TO and the line reported the adjustment backwards: a clinical record
  // asserting the opposite of what happened.
  //
  // REVISION IS THE AUTHORITY WITHIN A SERIES, because every reading in one
  // shares a single identity and 0223 allocates the revision per capture under
  // a lock. `recordedAt` is left to display.

  it("pairs by REVISION, so 120 -> 130 reads that way even inverted", () => {
    // Revision 2 carries the EARLIER timestamp: the inversion this closes.
    const changes = changesWithin(
      chronology([
        reading({ captureId: "cap-1", revision: 1, recordedAt: "2026-10-15T10:05:00Z", value: 120 }),
        reading({ captureId: "cap-2", revision: 2, recordedAt: "2026-10-15T10:00:00Z", value: 130 }),
      ]),
    );
    expect(changes).toHaveLength(1);
    expect(
      [changes[0]!.from.value, changes[0]!.to.value],
      "the change was reported backwards, which is the defect",
    ).toEqual([
      { kind: "value", value: 120 },
      { kind: "value", value: 130 },
    ]);
  });

  it("CONTROL: an ordinary ascending pair is unchanged", () => {
    // Without this the fix would also pass if it reversed everything.
    const changes = changesWithin(
      chronology([
        reading({ captureId: "cap-1", revision: 1, recordedAt: "2026-10-15T10:00:00Z", value: 120 }),
        reading({ captureId: "cap-2", revision: 2, recordedAt: "2026-10-15T10:05:00Z", value: 130 }),
      ]),
    );
    expect(changes).toHaveLength(1);
    expect([changes[0]!.from.value, changes[0]!.to.value]).toEqual([
      { kind: "value", value: 120 },
      { kind: "value", value: 130 },
    ]);
  });

  it("and ADJACENCY still follows what was handed in, not revision arithmetic", () => {
    // The docblock promises this and the fix must not quietly change it: a
    // missing revision 2 leaves 1 and 3 adjacent, which is honest about what
    // is known rather than asserting a step nobody read.
    const changes = changesWithin(
      chronology([
        reading({ captureId: "cap-1", revision: 1, recordedAt: "2026-10-15T10:00:00Z", value: 120 }),
        reading({ captureId: "cap-3", revision: 3, recordedAt: "2026-10-15T10:10:00Z", value: 140 }),
      ]),
    );
    expect(changes).toHaveLength(1);
    expect([changes[0]!.from.revision, changes[0]!.to.revision]).toEqual([1, 3]);
  });
});

describe("a change series never crosses physical units", () => {
  it("does NOT pair Room 1's value with Room 2's", () => {
    // THE DEFECT (Codex, #860 4294673734). Two rooms holding the same model
    // both mint `g1` from a freshly mounted collector, and the series key was
    // group + mode + profile + version + stage + field — every term equal
    // across the two units. A value read on Room 1 then one on Room 2 rendered
    // under "Changed during this treatment" as one setting's before/after,
    // asserting an adjustment that nobody made, about a machine the line does
    // not even name.
    const out = changesWithin(
      chronology([
        reading({
          recordedAt: "2026-10-14T10:00:00Z",
          value: 120,
          deviceId: "dev-1",
          captureId: "cap-1",
        }),
        reading({
          recordedAt: "2026-10-14T10:30:00Z",
          value: 150,
          deviceId: "dev-2",
          captureId: "cap-2",
        }),
      ]),
    );
    expect(out).toEqual([]);
  });

  it("CONTROL: the SAME unit still pairs, so the guard is not blanket", () => {
    // Without this the test above passes on a changesWithin that returns
    // nothing at all.
    const out = changesWithin(
      chronology([
        reading({
          recordedAt: "2026-10-14T10:00:00Z",
          value: 120,
          deviceId: "dev-1",
          captureId: "cap-1",
        }),
        reading({
          recordedAt: "2026-10-14T10:30:00Z",
          value: 150,
          deviceId: "dev-1",
          captureId: "cap-2",
        }),
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.from.value).toEqual({ kind: "value", value: 120 });
    expect(out[0]!.to.value).toEqual({ kind: "value", value: 150 });
  });

  it("each unit keeps its OWN series across a switch and back", () => {
    // Room 1 → Room 2 → Room 1. One change, on Room 1, and the Room 2 reading
    // in the middle must neither break that pair nor create one of its own.
    const out = changesWithin(
      chronology([
        reading({
          recordedAt: "2026-10-14T10:00:00Z",
          value: 120,
          deviceId: "dev-1",
          captureId: "cap-1",
        }),
        reading({
          recordedAt: "2026-10-14T10:15:00Z",
          value: 90,
          deviceId: "dev-2",
          captureId: "cap-2",
        }),
        reading({
          recordedAt: "2026-10-14T10:30:00Z",
          value: 150,
          deviceId: "dev-1",
          captureId: "cap-3",
        }),
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.from.deviceId).toBe("dev-1");
    expect(out[0]!.to.deviceId).toBe("dev-1");
    expect(out[0]!.from.value).toEqual({ kind: "value", value: 120 });
    expect(out[0]!.to.value).toEqual({ kind: "value", value: 150 });
  });
});

describe("THE CHRONOLOGY IS A MERGE, not a grouping", () => {
  // THE DEFECT, AND IT WAS MINE (Codex, #860 4308767071). Round 4 fixed a real
  // problem - a transaction-start `recordedAt` can invert against `revision`,
  // so sorting on the event's own time could report an adjustment backwards -
  // and fixed it by sorting every entry by its SERIES' START time. That groups
  // whole series together, so interleaved captures render out of order. One
  // true property traded for another.
  //
  // THE TWO PROPERTIES ARE NOT IN CONFLICT, and these cases hold them
  // TOGETHER, which is the point: each is satisfiable alone by the rule that
  // breaks the other.

  it("CODEX'S EXAMPLE: interleaved captures render interleaved", () => {
    // g1 r1 10:00 · g2 r1 10:10 · g1 r2 10:20
    // was rendered g1:1, g1:2, g2:1 - the 10:20 adjustment placed BEFORE the
    // 10:10 capture it followed.
    const out = chronology([
      reading({ captureId: "a1", groupKey: "g1", revision: 1, recordedAt: "2026-10-15T10:00:00Z", value: 120 }),
      reading({ captureId: "b1", groupKey: "g2", revision: 1, recordedAt: "2026-10-15T10:10:00Z", value: 80 }),
      reading({ captureId: "a2", groupKey: "g1", revision: 2, recordedAt: "2026-10-15T10:20:00Z", value: 130 }),
    ]);
    expect(
      out.map((e) => `${e.groupKey}:${e.revision}`),
      "the series were grouped instead of merged, so an adjustment is shown before the capture it followed",
    ).toEqual(["g1:1", "g2:1", "g1:2"]);
  });

  it("and the ORDER OF THE INPUT does not change the answer", () => {
    // A merge driven by the instant must not inherit the bucket map's order.
    const rows = [
      reading({ captureId: "a2", groupKey: "g1", revision: 2, recordedAt: "2026-10-15T10:20:00Z", value: 130 }),
      reading({ captureId: "b1", groupKey: "g2", revision: 1, recordedAt: "2026-10-15T10:10:00Z", value: 80 }),
      reading({ captureId: "a1", groupKey: "g1", revision: 1, recordedAt: "2026-10-15T10:00:00Z", value: 120 }),
    ];
    expect(chronology(rows).map((e) => `${e.groupKey}:${e.revision}`)).toEqual([
      "g1:1",
      "g2:1",
      "g1:2",
    ]);
    expect(
      chronology([...rows].reverse()).map((e) => `${e.groupKey}:${e.revision}`),
    ).toEqual(["g1:1", "g2:1", "g1:2"]);
  });

  it("BOTH PROPERTIES AT ONCE: an inverted series, interleaved with another", () => {
    // THE CASE THAT TELLS THE TWO RULES APART, and the one neither earlier fix
    // could pass:
    //
    //   g1 r1 @ 10:20   <- a long transaction: started first, committed second
    //   g1 r2 @ 10:00
    //   g2 r1 @ 10:10
    //
    // Sorting on the raw instant gives g1:2 before g1:1 - a series reported
    // BACKWARDS, which is a clinical record asserting the opposite of what
    // happened. Sorting by series start gives g1:1, g1:2, g2:1 - the grouping
    // defect. The clamp gives g2 at its own 10:10, and the inverted pair tied
    // at 10:20 where revision settles them.
    const out = chronology([
      reading({ captureId: "a1", groupKey: "g1", revision: 1, recordedAt: "2026-10-15T10:20:00Z", value: 120 }),
      reading({ captureId: "a2", groupKey: "g1", revision: 2, recordedAt: "2026-10-15T10:00:00Z", value: 130 }),
      reading({ captureId: "b1", groupKey: "g2", revision: 1, recordedAt: "2026-10-15T10:10:00Z", value: 80 }),
    ]);
    expect(out.map((e) => `${e.groupKey}:${e.revision}`)).toEqual([
      "g2:1",
      "g1:1",
      "g1:2",
    ]);
  });

  it("a series is never backwards even when another capture falls between the inverted pair", () => {
    const out = chronology([
      reading({ captureId: "a1", groupKey: "g1", revision: 1, recordedAt: "2026-10-15T10:30:00Z", value: 120 }),
      reading({ captureId: "a2", groupKey: "g1", revision: 2, recordedAt: "2026-10-15T10:00:00Z", value: 130 }),
      reading({ captureId: "b1", groupKey: "g2", revision: 1, recordedAt: "2026-10-15T10:15:00Z", value: 80 }),
    ]);
    const order = out.map((e) => `${e.groupKey}:${e.revision}`);
    expect(order.indexOf("g1:1")).toBeLessThan(order.indexOf("g1:2"));
    expect(order).toEqual(["g2:1", "g1:1", "g1:2"]);
  });

  it("three series interleaving, none of them grouped", () => {
    const out = chronology([
      reading({ captureId: "c1", groupKey: "g3", revision: 1, recordedAt: "2026-10-15T10:05:00Z", value: 60 }),
      reading({ captureId: "a1", groupKey: "g1", revision: 1, recordedAt: "2026-10-15T10:00:00Z", value: 120 }),
      reading({ captureId: "b1", groupKey: "g2", revision: 1, recordedAt: "2026-10-15T10:10:00Z", value: 80 }),
      reading({ captureId: "a2", groupKey: "g1", revision: 2, recordedAt: "2026-10-15T10:15:00Z", value: 130 }),
      reading({ captureId: "c2", groupKey: "g3", revision: 2, recordedAt: "2026-10-15T10:20:00Z", value: 65 }),
    ]);
    expect(out.map((e) => `${e.groupKey}:${e.revision}`)).toEqual([
      "g1:1",
      "g3:1",
      "g2:1",
      "g1:2",
      "g3:2",
    ]);
  });

  it("and a DIFFERENT UNIT's identical group key is still its own series", () => {
    // Two rooms holding one model both mint `g1`, so the clamp must run per
    // SERIES - (device, profile, version, mode) plus the key - and not per
    // group key, or one room's capture floats on the other's instants.
    //
    // THE FIXTURE IS BUILT TO MAKE THE WRONG KEYING VISIBLE, and an earlier
    // version of it was not: with timestamps that happened to ascend, clamping
    // by group key changed nothing and the negative control reported NOT
    // CAUGHT. Here dev-2's only capture is EARLIER than dev-1's first, so a
    // shared bucket would floor it forward onto dev-1's instant.
    //
    // ASSERTED IN BOTH INPUT ORDERS, because the wrong keying is order
    // dependent: the clamp walks a bucket in revision order, two revision-1
    // captures tie, and which one sets the floor then decides whether the
    // wrong answer appears at all. One order would pass by luck.
    const rows = [
      reading({ captureId: "r1a", deviceId: "dev-1", groupKey: "g1", revision: 1, recordedAt: "2026-10-15T10:20:00Z", value: 120 }),
      reading({ captureId: "r1b", deviceId: "dev-1", groupKey: "g1", revision: 2, recordedAt: "2026-10-15T10:30:00Z", value: 130 }),
      reading({ captureId: "r2a", deviceId: "dev-2", groupKey: "g1", revision: 1, recordedAt: "2026-10-15T10:00:00Z", value: 90 }),
    ];
    const expected = ["dev-2:1", "dev-1:1", "dev-1:2"];
    expect(
      chronology(rows).map((e) => `${e.deviceId}:${e.revision}`),
      "one unit's capture was floated onto the other unit's instants",
    ).toEqual(expected);
    expect(
      chronology([...rows].reverse()).map((e) => `${e.deviceId}:${e.revision}`),
      "the answer depends on the input order, so the series keying is wrong",
    ).toEqual(expected);
  });
});

describe("the CHANGE SUMMARY is merged by the same rule", () => {
  // NOT NAMED BY 4308767071, and fixed with it because it is the same defect
  // for the same reason: the list led on `to.recordedAt` with revision as a
  // TIEBREAK, and an inverted transaction-start timestamp is not a tie. Fixing
  // the captures and leaving the changes would ship half the property.

  it("interleaved changes render interleaved", () => {
    const out = changesWithin(
      chronology([
        reading({ captureId: "a1", groupKey: "g1", revision: 1, recordedAt: "2026-10-15T10:00:00Z", value: 120 }),
        reading({ captureId: "b1", groupKey: "g2", revision: 1, recordedAt: "2026-10-15T10:05:00Z", value: 80 }),
        reading({ captureId: "a2", groupKey: "g1", revision: 2, recordedAt: "2026-10-15T10:10:00Z", value: 130 }),
        reading({ captureId: "b2", groupKey: "g2", revision: 2, recordedAt: "2026-10-15T10:15:00Z", value: 85 }),
      ]),
    );
    expect(out.map((c) => `${c.groupKey}:${c.to.revision}`)).toEqual([
      "g1:2",
      "g2:2",
    ]);
  });

  it("and two changes in ONE series are never reported out of order when the times invert", () => {
    // r1 @ 10:30, r2 @ 10:00, r3 @ 10:10 - the pairing is by revision, so the
    // changes are 1->2 and 2->3; their `to` instants are 10:00 and 10:10, so
    // a raw sort would read them 1->2 then 2->3 by luck. Make r3 the inverted
    // one so the raw order is WRONG.
    const out = changesWithin(
      chronology([
        reading({ captureId: "a1", groupKey: "g1", revision: 1, recordedAt: "2026-10-15T10:00:00Z", value: 120 }),
        reading({ captureId: "a2", groupKey: "g1", revision: 2, recordedAt: "2026-10-15T10:30:00Z", value: 130 }),
        reading({ captureId: "a3", groupKey: "g1", revision: 3, recordedAt: "2026-10-15T10:10:00Z", value: 140 }),
      ]),
    );
    expect(
      out.map((c) => `${c.from.value.kind === "value" ? c.from.value.value : "?"}->${c.to.value.kind === "value" ? c.to.value.value : "?"}`),
      "the later adjustment was listed before the earlier one",
    ).toEqual(["120->130", "130->140"]);
  });
});
