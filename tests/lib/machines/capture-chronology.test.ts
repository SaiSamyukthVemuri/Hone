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
