import { describe, expect, it } from "vitest";

import type { FieldGroup } from "@/lib/machines/charting";
import type { MachineProfile } from "@/lib/machines/profile-contract";
import {
  addGroup,
  groupIssues,
  assembleGroupSubmissions,
  channelChoices,
  draftKey,
  firstGroup,
  groupReadiness,
  supportsDistinctGroups,
  toggleChannel,
  type SettingGroupDraft,
} from "@/lib/machines/setting-groups";

// MPX-03 — SETTING GROUPS: probes that share one set of settings.
//
// The entry surface hard-coded `group_key: "g1"` with no channels while the
// schema, the command and both read paths had always supported several groups
// with channel associations, so a practitioner running probes at different
// settings could store only one apparently global setup (Codex, 15cc6c99).
//
// Everything here is the CONTRACT's decision, never this module's: which
// channel identities exist, whether distinct groups are offered at all, and
// whether a group must name its channels. The tests are written to fail if any
// of those starts being invented locally.
//
// No fixture corresponds to a real machine.

const FIELDS: FieldGroup = {
  key: "probe",
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
      key: "duration",
      label: "Duration",
      unit: "s",
      decimals: 1,
      optional: true,
      editable: true,
      stageKey: null,
      expectedSource: "practitioner-entered",
      advisory: [],
    },
  ],
};

const base = {
  profileId: "fixture:channels",
  version: 1,
  family: "fixture",
  manufacturer: "Fixture",
  model: "Multi",
  availability: "active",
  verification: "device-confirmed",
  frequency: { kind: "not-applicable" },
  evidence: [],
  openQuestions: [],
  modes: [],
} as unknown as MachineProfile;

/** Four channels, probes may genuinely differ. */
const MULTI: MachineProfile = {
  ...base,
  channels: {
    count: 4,
    nativeLabel: "Channel",
    associationRequired: false,
    supportsDistinctSettingGroups: true,
    verification: "device-confirmed",
    evidence: [],
  },
};

/** Channels exist, but the model does NOT support distinct groups. */
const SHARED: MachineProfile = {
  ...base,
  channels: { ...MULTI.channels!, supportsDistinctSettingGroups: false },
};

/** No channels at all — the ordinary single-probe machine. */
const SINGLE: MachineProfile = { ...base };

const withValues = (
  id: string,
  values: Record<string, string>,
  channels: number[] = [],
): SettingGroupDraft => {
  const out: Record<string, string> = {};
  for (const f of FIELDS.fields) {
    const v = values[f.key];
    if (v !== undefined) out[draftKey(FIELDS.key, f)] = v;
  }
  return { id, channels, values: out };
};

describe("the CONTRACT decides which channel identities exist", () => {
  it("offers exactly 1..count, and nothing else", () => {
    expect(channelChoices(MULTI)).toEqual([1, 2, 3, 4]);
  });

  it("offers none for a model with no channel structure", () => {
    expect(channelChoices(SINGLE)).toEqual([]);
  });

  it("refuses to associate a channel the model does not have", () => {
    // No invented identities: a number outside the contract is ignored rather
    // than stored. The database would refuse it too, and agreeing with the
    // authority beats discovering it at save time.
    const g = withValues("g1", { current: "120" });
    expect(toggleChannel(g, 9, MULTI).channels).toEqual([]);
    expect(toggleChannel(g, 0, MULTI).channels).toEqual([]);
    expect(toggleChannel(g, 1, MULTI).channels).toEqual([1]);
  });

  it("keeps an association list sorted and free of duplicates", () => {
    // The command refuses a channel named twice, so the UI cannot produce one.
    let g = withValues("g1", {});
    g = toggleChannel(g, 3, MULTI);
    g = toggleChannel(g, 1, MULTI);
    expect(g.channels).toEqual([1, 3]);
    g = toggleChannel(g, 3, MULTI);
    expect(g.channels, "a second tap removes it").toEqual([1]);
  });
});

describe("the CONTRACT decides whether distinct groups are offered", () => {
  it("permits them only when the model says its probes can differ", () => {
    expect(supportsDistinctGroups(MULTI)).toBe(true);
    expect(supportsDistinctGroups(SHARED), "channels but no distinct groups").toBe(
      false,
    );
    expect(supportsDistinctGroups(SINGLE), "no channels at all").toBe(false);
  });
});

describe("group identity is STABLE and never reused", () => {
  it("starts with exactly one group", () => {
    expect(firstGroup()).toEqual([{ id: "g1", channels: [], values: {} }]);
  });

  it("takes its ordinal from the caller, so a retired id is never reissued", () => {
    // THIS TEST FOUND A REAL FLAW in the first implementation, which derived
    // the next id from the highest one PRESENT. Removing g2 then made the next
    // group g2 again - and the database allocates revisions per (block,
    // group), so that group's capture would append revision 2 to the retired
    // g2's history and merge two different probe sets into one timeline.
    //
    // It was unreachable only because removal is offered for an empty group,
    // and an empty group was never saved. One guard away from a corrupt
    // record is not where this belongs, so the ordinal is now the caller's
    // monotonic counter.
    const two = addGroup(firstGroup(), 2);
    expect(two.map((g) => g.id)).toEqual(["g1", "g2"]);
    const afterRemoval = addGroup([two[0]!], 3);
    expect(
      afterRemoval.map((g) => g.id),
      "g2 was used and retired; the next one must not reuse it",
    ).toEqual(["g1", "g3"]);
  });

  it("adds an EMPTY group, copying nothing", () => {
    // Carrying values over would assert she ran the second set of probes at
    // the first set's settings.
    const seeded = [withValues("g1", { current: "120" }, [1])];
    const added = addGroup(seeded, 2)[1]!;
    expect(added.values).toEqual({});
    expect(added.channels).toEqual([]);
  });
});

describe("readiness has THREE states, and the middle one is the point", () => {
  it("EMPTY when nothing is entered, so it is simply not recorded", () => {
    expect(groupReadiness([FIELDS], withValues("g1", {}))).toBe("empty");
  });

  it("COMPLETE when every required field is entered", () => {
    expect(groupReadiness([FIELDS], withValues("g1", { current: "120" }))).toBe(
      "complete",
    );
  });

  it("PARTIAL when something is entered but a required field is missing", () => {
    // Neither skippable nor submittable: skipping silently discards what she
    // typed, and the command would refuse the submission.
    expect(groupReadiness([FIELDS], withValues("g1", { duration: "300.5" }))).toBe(
      "partial",
    );
  });

  it("treats a blank string as not entered, and a zero as entered", () => {
    expect(groupReadiness([FIELDS], withValues("g1", { current: "   " }))).toBe(
      "empty",
    );
    expect(groupReadiness([FIELDS], withValues("g1", { current: "0" }))).toBe(
      "complete",
    );
  });
});

describe("one submission per group, each a separate atomic capture", () => {
  it("emits two submissions with their own channels and values", () => {
    const groups = [
      withValues("g1", { current: "120" }, [1, 2]),
      withValues("g2", { current: "80" }, [3, 4]),
    ];
    const subs = assembleGroupSubmissions([FIELDS], groups);
    expect(subs).toHaveLength(2);
    expect(subs[0]!.groupKey).toBe("g1");
    expect(subs[0]!.channels).toEqual([1, 2]);
    expect(subs[0]!.readings[0]!.value).toEqual({ kind: "value", value: 120 });
    expect(subs[1]!.groupKey).toBe("g2");
    expect(subs[1]!.channels).toEqual([3, 4]);
    expect(subs[1]!.readings[0]!.value).toEqual({ kind: "value", value: 80 });
  });

  it("keeps the two groups' values INDEPENDENT", () => {
    // The defect this whole slice exists to prevent, as an assertion: one
    // group's number must never appear in the other's capture.
    const groups = [
      withValues("g1", { current: "120" }, [1]),
      withValues("g2", { current: "80" }, [2]),
    ];
    const subs = assembleGroupSubmissions([FIELDS], groups);
    const values = subs.map((s) => s.readings.map((r) => r.value));
    expect(values).toEqual([
      [{ kind: "value", value: 120 }],
      [{ kind: "value", value: 80 }],
    ]);
  });

  it("omits an empty group entirely rather than recording a blank capture", () => {
    const subs = assembleGroupSubmissions([FIELDS], [
      withValues("g1", { current: "120" }),
      withValues("g2", {}, [3]),
    ]);
    expect(subs.map((s) => s.groupKey)).toEqual(["g1"]);
  });

  it("carries an EMPTY channel list through unchanged", () => {
    // An unassociated group records NO association. It must not be turned into
    // "every channel" on the way out - that would assert a clinical fact
    // nobody entered.
    const subs = assembleGroupSubmissions([FIELDS], [
      withValues("g1", { current: "120" }, []),
    ]);
    expect(subs[0]!.channels).toEqual([]);
  });
});

describe("one channel cannot belong to TWO groups", () => {
  // The database cannot catch this: each RPC call carries its own
  // internally-duplicate-free array, so two groups claiming the same probe are
  // two individually VALID calls - and the result would permanently record one
  // channel under two different settings. The UI is the only place it can be
  // refused (Codex, f175e732).
  //
  // THE RULE ALREADY EXISTED. `settingGroupIssues` in charting.ts has treated
  // a channel claimed by another group as invalid since before this surface
  // could create two groups; this path simply did not call it. These tests
  // assert the delegation, not a reimplementation.
  it("reports the conflict, naming the group that already has it", () => {
    const issues = groupIssues(MULTI, [
      withValues("g1", { current: "120" }, [1, 2]),
      withValues("g2", { current: "80" }, [2, 3]),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.groupId).toBe("g2");
    expect(issues[0]!.problem).toMatch(/already recorded in g1/i);
  });

  it("reports nothing when the groups are disjoint", () => {
    // The positive control: without it, "reports a conflict" could be
    // satisfied by a function that always complains.
    expect(
      groupIssues(MULTI, [
        withValues("g1", { current: "120" }, [1, 2]),
        withValues("g2", { current: "80" }, [3, 4]),
      ]),
    ).toEqual([]);
  });

  it("still reports a channel the model does not have", () => {
    // The other half of the same existing rule, which this path also gets for
    // free by delegating rather than reimplementing.
    const issues = groupIssues(MULTI, [withValues("g1", {}, [9])]);
    expect(issues[0]!.problem).toMatch(/outside 1\.\.4/);
  });

  it("reports channels on a model that has none", () => {
    const issues = groupIssues(SINGLE, [withValues("g1", {}, [1])]);
    expect(issues[0]!.problem).toMatch(/no independently controlled channels/i);
  });
});

describe("a group already recorded is never resubmitted", () => {
  // Captures are append-only, so resubmitting a group that succeeded would
  // create a SECOND immutable revision of settings entered once -
  // indistinguishable in the record from a genuine mid-treatment change
  // (Codex, f175e732).
  const two = [
    withValues("g1", { current: "120" }, [1]),
    withValues("g2", { current: "80" }, [2]),
  ];

  it("excludes it from the submissions on a retry", () => {
    const retry = assembleGroupSubmissions([FIELDS], two, new Set(["g1"]));
    expect(retry.map((s) => s.groupKey)).toEqual(["g2"]);
  });

  it("CONTROL: with nothing recorded yet, both are submitted", () => {
    expect(
      assembleGroupSubmissions([FIELDS], two).map((s) => s.groupKey),
    ).toEqual(["g1", "g2"]);
  });

  it("submits nothing when every group has already been recorded", () => {
    expect(
      assembleGroupSubmissions([FIELDS], two, new Set(["g1", "g2"])),
    ).toEqual([]);
  });
});
