import { describe, expect, it } from "vitest";

import type { FieldGroup } from "@/lib/machines/charting";
import { assembleReadings, draftKey } from "@/lib/machines/setting-groups";

// MPX-03 — what a typed draft becomes, before it is stored.
//
// WHY THIS FILE EXISTS. This logic lived inside the entry form's `submit`
// handler, and this repository has no jsdom or testing-library in the unit
// stack, so nothing could reach it. That is exactly how a hard-coded
// "practitioner-entered" survived on EVERY field - including ones the contract
// marks machine-displayed or device-computed - with the rows immutable, so the
// wrong provenance would have been permanent (Codex, 15cc6c99).
//
// It is the third defect in this lane to ship inside an untestable handler.
// The two before it were the selection status line, which lied twice, and the
// unit-name prop, which was never forwarded. In each case every surrounding
// layer had a test and the decision itself had none.
//
// No fixture here corresponds to a real machine. The sources are the contract's
// own vocabulary.

/** A group whose three fields have three DIFFERENT contract sources. */
const GROUP: FieldGroup = {
  key: "g1",
  label: "Probe",
  fields: [
    {
      key: "current",
      label: "Current",
      unit: "µA",
      decimals: 0,
      optional: false,
      editable: true,
      stageKey: null,
      expectedSource: "practitioner-entered",
      advisory: [],
    },
    {
      key: "shown",
      label: "Displayed total",
      unit: "s",
      decimals: 1,
      optional: true,
      editable: false,
      stageKey: null,
      expectedSource: "machine-displayed",
      advisory: [],
    },
    {
      key: "computed",
      label: "Computed dose",
      unit: "mC",
      decimals: 2,
      optional: true,
      editable: false,
      stageKey: null,
      expectedSource: "device-computed",
      advisory: [],
    },
  ],
};

const draftFor = (values: Record<string, string>): Record<string, string> => {
  const draft: Record<string, string> = {};
  for (const f of GROUP.fields) {
    const v = values[f.key];
    if (v !== undefined) draft[draftKey(GROUP.key, f)] = v;
  }
  return draft;
};

describe("each reading carries the source its CONTRACT declares", () => {
  it("does not label a machine-displayed value as practitioner-entered", () => {
    // The defect in one assertion.
    const out = assembleReadings([GROUP], draftFor({ shown: "12.5" }));
    expect(out).toHaveLength(1);
    expect(out[0]!.observationSource).toBe("machine-displayed");
  });

  it("does not label a device-computed value as practitioner-entered either", () => {
    const out = assembleReadings([GROUP], draftFor({ computed: "3.25" }));
    expect(out[0]!.observationSource).toBe("device-computed");
  });

  it("still labels a practitioner-entered field as entered", () => {
    // The positive control: the old behaviour was correct for THIS field, so
    // without this case the fix could have swapped one blanket value for
    // another.
    const out = assembleReadings([GROUP], draftFor({ current: "120" }));
    expect(out[0]!.observationSource).toBe("practitioner-entered");
  });

  it("gives three different sources for three fields of one capture", () => {
    // One capture, three provenances. A blanket value cannot satisfy this.
    const out = assembleReadings(
      [GROUP],
      draftFor({ current: "120", shown: "12.5", computed: "3.25" }),
    );
    expect(out.map((r) => [r.fieldKey, r.observationSource])).toEqual([
      ["current", "practitioner-entered"],
      ["shown", "machine-displayed"],
      ["computed", "device-computed"],
    ]);
  });
});

describe("a blank field is not recorded at all", () => {
  it("omits it rather than writing a zero", () => {
    // A zero is a VALUE. Writing one for a field she left alone would invent
    // a reading, and the number would look exactly like a deliberate setting.
    const out = assembleReadings([GROUP], draftFor({ current: "" }));
    expect(out).toEqual([]);
  });

  it("omits it rather than writing an absence reason", () => {
    // "not-applicable" is a different claim - that the field does not apply -
    // and the command has its own vocabulary for it. Silence is not that.
    const out = assembleReadings([GROUP], draftFor({ shown: "   " }));
    expect(out).toEqual([]);
  });

  it("RECORDS A GENUINE ZERO, which is a value she did give", () => {
    // The other side of the same rule, and the one that would break if
    // blankness were tested with a falsy check.
    const out = assembleReadings([GROUP], draftFor({ current: "0" }));
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toEqual({ kind: "value", value: 0 });
  });

  it("omits a non-numeric entry rather than storing NaN", () => {
    const out = assembleReadings([GROUP], draftFor({ current: "abc" }));
    expect(out).toEqual([]);
  });
});

describe("the draft key keeps fields of different groups and stages apart", () => {
  it("distinguishes the same field key in two groups", () => {
    // Two probes recording the same field is the ordinary multi-group case;
    // a key that collided would silently merge them.
    const a = draftKey("g1", GROUP.fields[0]!);
    const b = draftKey("g2", GROUP.fields[0]!);
    expect(a).not.toBe(b);
  });

  it("distinguishes the same field key in two stages", () => {
    const staged = { ...GROUP.fields[0]!, stageKey: "pre" };
    expect(draftKey("g1", GROUP.fields[0]!)).not.toBe(draftKey("g1", staged));
  });
});
