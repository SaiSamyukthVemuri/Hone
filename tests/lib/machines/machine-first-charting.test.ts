import { beforeEach, describe, expect, it } from "vitest";

import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import type { MachineProfile } from "@/lib/machines/profile-contract";
import {
  clearSelection,
  resolveSelection,
  selectDevice,
  selectableDevices,
  selectionKey,
  type SelectionScope,
  type SelectionStore,
  type StoredSelection,
  type StudioDevice,
} from "@/lib/machines/selection";
import {
  addSettingGroup,
  blocksSubmission,
  defaultSettingGroups,
  nativeFieldGroups,
  priorSetupView,
  proposeSetup,
  recordedUnitLabel,
  settingGroupIssues,
  unitLabel,
  type RecordedSetup,
} from "@/lib/machines/charting";
import { validateReading } from "@/lib/machines/validate-reading";

// ===========================================================================
// MPX-03 — machine-first selection, native field display, next-visit retrieval.
//
// The real catalogue currently offers NO profile, by design: evidence for every
// exact model is still incomplete and `catalogueIntegrity()` gates activation.
// So the "ready" paths are exercised against a clearly synthetic ACTIVE profile
// shaped like the GEMM-16 — independently controlled channels, a current in
// microamps and a duration — while the real catalogue is used for the honest
// empty state, the not-verified path and the model-identity assertions.
// ===========================================================================

/** Synthetic, active, GEMM-shaped. Not a real machine. */
const FIXTURE: MachineProfile = {
  profileId: "fixture:multineedle",
  version: 2,
  family: "Permanence/GEMM-16",
  manufacturer: "Fixture",
  model: "Multineedle",
  availability: "active",
  verification: "device-confirmed",
  frequency: { kind: "not-applicable" },
  evidence: [
    {
      id: "fx",
      kind: "studio-device-photo",
      consultedOn: "2026-10-12",
      establishes: "A synthetic multi-needle unit used to exercise the ready paths.",
    },
  ],
  openQuestions: [],
  channels: {
    count: 16,
    nativeLabel: "Channel",
    associationRequired: false,
    supportsDistinctSettingGroups: true,
    verification: "device-confirmed",
    evidence: ["fx"],
  },
  modes: [
    {
      key: "galvanic",
      nativeLabel: "Galvanic",
      family: "galvanic",
      availability: "active",
      verification: "device-confirmed",
      evidence: ["fx"],
      stages: [],
      fields: [
        {
          key: "current",
          nativeLabel: "Current",
          quantity: "current",
          unit: "µA",
          decimals: 0,
          optional: false,
          expectedSource: "practitioner-entered",
          editable: true,
          verification: "device-confirmed",
          evidence: ["fx"],
          // A DISPUTED bound: must surface as advisory and never refuse.
          ranges: [
            {
              max: 400,
              class: "hardware-enforced",
              evidence: "fx",
              discrepancy: "the brochure and the manual disagree",
            },
          ],
        },
        {
          key: "duration",
          nativeLabel: "Time",
          quantity: "duration",
          unit: "s",
          decimals: 0,
          optional: false,
          expectedSource: "practitioner-entered",
          editable: true,
          verification: "device-confirmed",
          evidence: ["fx"],
        },
      ],
    },
    {
      key: "adjunct",
      nativeLabel: "Cataphoresis",
      family: "adjunct",
      availability: "active",
      verification: "device-confirmed",
      evidence: ["fx"],
      stages: [],
      requiresInstalledOption: "cataphoresis-head",
      fields: [
        {
          key: "current",
          nativeLabel: "Current",
          quantity: "current",
          unit: "µA",
          decimals: 0,
          optional: false,
          expectedSource: "practitioner-entered",
          editable: true,
          verification: "device-confirmed",
          evidence: ["fx"],
        },
      ],
    },
  ],
};

const CAT = [FIXTURE, ...MACHINE_CATALOGUE];

const ALICE: SelectionScope = { studioId: "studio-A", practitionerId: "alice" };
const BOB: SelectionScope = { studioId: "studio-A", practitionerId: "bob" };
const ALICE_AT_B: SelectionScope = { studioId: "studio-B", practitionerId: "alice" };

const DEV = (over: Partial<StudioDevice> = {}): StudioDevice => ({
  deviceId: "room-1",
  studioId: "studio-A",
  profileId: "fixture:multineedle",
  profileVersion: 2,
  displayName: "Room 1 Multineedle",
  installedOptions: [],
  retiredAt: null,
  ...over,
});

const DEVICES = [
  DEV(),
  DEV({ deviceId: "room-2", displayName: "Room 2 Multineedle" }),
  DEV({ deviceId: "b-room-1", studioId: "studio-B", displayName: "Studio B unit" }),
  DEV({
    deviceId: "retired-1",
    displayName: "Old unit",
    retiredAt: "2026-09-01T00:00:00Z",
  }),
  DEV({
    deviceId: "unverified-1",
    displayName: "Studio ST 350",
    profileId: "silhouettone:evolution-st-350",
    profileVersion: 1,
  }),
];

/**
 * An in-memory store that keys through the REAL `selectionKey`, so isolation is
 * proved by the production key function rather than by the double's own habits.
 */
function memoryStore() {
  const rows = new Map<string, StoredSelection>();
  const store: SelectionStore & { keys: () => string[] } = {
    async read(scope) {
      return rows.get(selectionKey(scope)) ?? null;
    },
    async write(scope, selection) {
      if (selection === null) rows.delete(selectionKey(scope));
      else rows.set(selectionKey(scope), selection);
    },
    keys: () => [...rows.keys()],
  };
  return store;
}

let store: ReturnType<typeof memoryStore>;
beforeEach(() => {
  store = memoryStore();
});

// ---------------------------------------------------------------------------

describe("the remembered choice is keyed by practitioner AND studio", () => {
  it("encodes both halves in the key", () => {
    // Pins the storage shape for the follow-up migration: the sticky column
    // lives on `practitioners`, which is unique (studio_id, user_id), so the
    // pair is already the row identity. Keying by practitioner alone would let
    // one person's two studios share a machine.
    expect(selectionKey(ALICE)).toBe("studio-A:alice");
    expect(selectionKey(BOB)).not.toBe(selectionKey(ALICE));
    expect(selectionKey(ALICE_AT_B)).not.toBe(selectionKey(ALICE));
  });
});

describe("machine first, and remembered", () => {
  it("starts with nothing selected", async () => {
    expect(await resolveSelection(ALICE, DEVICES, store, CAT)).toEqual({ state: "none" });
  });

  it("remembers an explicit choice", async () => {
    const picked = await selectDevice(ALICE, "room-1", "galvanic", DEVICES, store, CAT);
    expect(picked.ok).toBe(true);

    const r = await resolveSelection(ALICE, DEVICES, store, CAT);
    expect(r.state).toBe("ready");
    if (r.state !== "ready") return;
    expect(r.device.deviceId).toBe("room-1");
    expect(r.profile.profileId).toBe("fixture:multineedle");
    expect(r.mode?.key).toBe("galvanic");
  });

  it("SURVIVES RELOAD — a fresh resolve against the same store is unchanged", async () => {
    await selectDevice(ALICE, "room-2", "galvanic", DEVICES, store, CAT);

    // Three independent resolutions, as three page loads would be. Resolution
    // keeps no instance state, so each one re-reads the store.
    for (let i = 0; i < 3; i++) {
      const r = await resolveSelection(ALICE, DEVICES, store, CAT);
      expect(r.state).toBe("ready");
      if (r.state === "ready") expect(r.device.deviceId).toBe("room-2");
    }
  });

  it("SURVIVES A NEW CHART — resolution cannot see a client or session", async () => {
    await selectDevice(ALICE, "room-2", "galvanic", DEVICES, store, CAT);

    // The structural guarantee is in the signature: `resolveSelection` takes a
    // scope, the studio's devices, the store and the catalogue — no client, no
    // session, no chart. TypeScript enforces that at compile time, so what is
    // worth proving here is the consequence: resolution is a pure function of
    // (scope, store), unaffected by whatever else the surrounding page passes.
    const asFirstChartRendered = await resolveSelection(ALICE, DEVICES, store, CAT);

    // A different chart renders with its own props: more devices loaded, in a
    // different order. The remembered machine must not move.
    const reordered = [...DEVICES].reverse();
    const asSecondChartRendered = await resolveSelection(ALICE, reordered, store, CAT);

    expect(asSecondChartRendered).toEqual(asFirstChartRendered);
    expect(asSecondChartRendered.state).toBe("ready");
    if (asSecondChartRendered.state === "ready") {
      expect(asSecondChartRendered.device.deviceId).toBe("room-2");
    }
  });

  it("ISOLATES practitioners within one studio", async () => {
    await selectDevice(ALICE, "room-1", "galvanic", DEVICES, store, CAT);

    expect(await resolveSelection(BOB, DEVICES, store, CAT)).toEqual({ state: "none" });

    await selectDevice(BOB, "room-2", "galvanic", DEVICES, store, CAT);
    const a = await resolveSelection(ALICE, DEVICES, store, CAT);
    const b = await resolveSelection(BOB, DEVICES, store, CAT);
    if (a.state === "ready" && b.state === "ready") {
      expect(a.device.deviceId).toBe("room-1");
      expect(b.device.deviceId).toBe("room-2");
    } else {
      throw new Error("both should resolve");
    }
  });

  it("ISOLATES one practitioner across two studios", async () => {
    await selectDevice(ALICE, "room-1", "galvanic", DEVICES, store, CAT);
    expect(await resolveSelection(ALICE_AT_B, DEVICES, store, CAT)).toEqual({
      state: "none",
    });
    expect(store.keys()).toEqual(["studio-A:alice"]);
  });

  it("an explicit change replaces the choice; clearing forgets it", async () => {
    await selectDevice(ALICE, "room-1", "galvanic", DEVICES, store, CAT);
    await selectDevice(ALICE, "room-2", "galvanic", DEVICES, store, CAT);
    const r = await resolveSelection(ALICE, DEVICES, store, CAT);
    if (r.state === "ready") expect(r.device.deviceId).toBe("room-2");

    await clearSelection(ALICE, store);
    expect(await resolveSelection(ALICE, DEVICES, store, CAT)).toEqual({ state: "none" });
  });
});

describe("an unavailable machine is shown, never silently replaced", () => {
  it("reports a device that left the studio's register", async () => {
    await selectDevice(ALICE, "room-1", "galvanic", DEVICES, store, CAT);
    // Same practitioner, same studio, but that unit is gone.
    const r = await resolveSelection(
      ALICE,
      DEVICES.filter((d) => d.deviceId !== "room-1"),
      store,
      CAT,
    );
    expect(r.state).toBe("unavailable");
    if (r.state === "unavailable") {
      expect(r.reason).toMatch(/nothing is selected for you/i);
      // room-2 is available and identical in model. It must NOT be chosen.
      expect(JSON.stringify(r)).not.toContain("room-2");
    }
  });

  it("reports a retired device rather than falling through", async () => {
    await store.write(ALICE, { deviceId: "retired-1", modeKey: null });
    const r = await resolveSelection(ALICE, DEVICES, store, CAT);
    expect(r.state).toBe("unavailable");
    if (r.state === "unavailable") expect(r.reason).toMatch(/out of service/i);
  });

  it("refuses to remember a retired or cross-studio device in the first place", async () => {
    const retired = await selectDevice(ALICE, "retired-1", null, DEVICES, store, CAT);
    expect(retired.ok).toBe(false);
    if (!retired.ok) expect(retired.code).toBe("device_retired");

    const other = await selectDevice(ALICE, "b-room-1", null, DEVICES, store, CAT);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("cross_studio_device");

    // Nothing unusable became the remembered choice.
    expect(store.keys()).toEqual([]);
  });

  it("refuses a mode needing an option this unit does not have", async () => {
    const r = await selectDevice(ALICE, "room-1", "adjunct", DEVICES, store, CAT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("mode_requires_installed_option");

    const equipped = [DEV({ installedOptions: ["cataphoresis-head"] })];
    const ok = await selectDevice(ALICE, "room-1", "adjunct", equipped, store, CAT);
    expect(ok.ok).toBe(true);
  });
});

describe("an unverified model is never offered", () => {
  it("reports a device whose profile is blocked, with the catalogue's reason", async () => {
    await store.write(ALICE, { deviceId: "unverified-1", modeKey: null });
    const r = await resolveSelection(ALICE, DEVICES, store, CAT);
    expect(r.state).toBe("not-verified");
    if (r.state === "not-verified") {
      expect(r.profile?.model).toBe("Evolution ST 350");
      expect(r.reason).toMatch(/repeat upper bound|not offered/i);
    }
  });

  it("refuses to select it", async () => {
    const r = await selectDevice(ALICE, "unverified-1", null, DEVICES, store, CAT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("profile_not_offered");
  });

  it("leaves it out of the selectable list", () => {
    const ids = selectableDevices(ALICE, DEVICES, CAT).map((d) => d.device.deviceId);
    expect(ids).toEqual(["room-1", "room-2"]);
  });

  it("offers nothing at all against the REAL catalogue today, honestly", () => {
    // Not a failure: no exact model has complete evidence yet. The picker must
    // say so plainly rather than looking broken.
    expect(selectableDevices(ALICE, DEVICES, MACHINE_CATALOGUE)).toEqual([]);
  });

  it("reports a device registered against a stale contract version", async () => {
    const stale = [DEV({ profileVersion: 1 })];
    await store.write(ALICE, { deviceId: "room-1", modeKey: null });
    const r = await resolveSelection(ALICE, stale, store, CAT);
    expect(r.state).toBe("not-verified");
    if (r.state === "not-verified") expect(r.reason).toMatch(/contract version 1/);
  });
});

describe("the chart shows that model's native fields", () => {
  const mode = FIXTURE.modes[0]!;

  it("renders the machine's own labels and units", () => {
    const groups = nativeFieldGroups(FIXTURE, mode);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Galvanic");
    expect(groups[0]!.fields.map((f) => [f.label, f.unit])).toEqual([
      ["Current", "µA"],
      ["Time", "s"],
    ]);
  });

  it("writes no unit for a machine's own display scale", () => {
    // UE and UL are each their machine's display. Inventing a unit for them
    // would be the normalisation the contract forbids.
    expect(unitLabel("device-display")).toBe("");
    expect(unitLabel("none")).toBe("");
    expect(unitLabel("µA")).toBe("µA");
  });

  it("applies the SAME rule to a unit read back off the record", () => {
    // THE ENTRY FORM OBEYED THIS AND THE HISTORY BESIDE IT DID NOT, so one
    // reading rendered as "1.25" above and "1.25 device-display" below
    // (Codex, #860 4288424526). The rule is one rule; what differs is the
    // input, which is why there are two entry points and one sentinel set.
    expect(recordedUnitLabel("device-display")).toBe("");
    expect(recordedUnitLabel("none")).toBe("");
    expect(recordedUnitLabel("µA")).toBe("µA");
  });

  it("prints a HISTORICAL unit verbatim rather than harmonising it", () => {
    // `native_unit` is free text holding whatever the contract said when the
    // row was written, so it can be a unit today's union no longer contains.
    // Anything that is not a sentinel is printed as recorded - rewriting it to
    // today's vocabulary would destroy the native precision the whole contract
    // exists to preserve.
    expect(recordedUnitLabel("mC")).toBe("mC");
    expect(recordedUnitLabel("UE")).toBe("UE");
  });

  it("treats a missing recorded unit as nothing to write, not as a crash", () => {
    // The column is NOT NULL today, but this reads rows written by a command
    // that predates it, and a renderer is the wrong place to discover that.
    expect(recordedUnitLabel("")).toBe("");
    expect(recordedUnitLabel(null)).toBe("");
    expect(recordedUnitLabel(undefined)).toBe("");
  });

  it("keeps MultiPlex's two stages as two visible groups, in order", () => {
    const xcell = MACHINE_CATALOGUE.find((p) => p.profileId === "dectro-apilus:xcell")!;
    const mp = xcell.modes.find((m) => m.key === "multiplex")!;
    const groups = nativeFieldGroups(xcell, mp);
    expect(groups.map((g) => g.label)).toEqual(["MultiPlex", "Slow thermolysis", "Snap"]);
    // Each stage keeps its own duration/intensity rather than sharing one pair.
    expect(groups[1]!.fields.map((f) => f.label)).toEqual(["Duration", "Intensity"]);
    expect(groups[2]!.fields.map((f) => f.label)).toEqual([
      "Duration",
      "Intensity",
      "Snaps",
    ]);
  });

  it("surfaces a disputed bound as advisory text, not a limit", () => {
    const current = nativeFieldGroups(FIXTURE, mode)[0]!.fields[0]!;
    expect(current.advisory.join(" ")).toMatch(/sources disagree/i);
    expect(current.advisory.join(" ")).toMatch(/Record what the machine shows/i);
  });
});

describe("GEMM's core is current and duration; sixteen rows are not mandatory", () => {
  it("starts with exactly ONE setting group despite sixteen channels", () => {
    expect(FIXTURE.channels!.count).toBe(16);
    const groups = defaultSettingGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.channels).toEqual([]);
  });

  it("saves with no channel association at all", () => {
    expect(settingGroupIssues(FIXTURE, defaultSettingGroups())).toEqual([]);
  });

  it("preserves two different settings groups when probes differ", () => {
    const two = addSettingGroup(defaultSettingGroups());
    two[0]!.channels = [1, 2];
    two[1]!.channels = [3];
    two[0]!.readings = { current: { kind: "value", value: 120 } };
    two[1]!.readings = { current: { kind: "value", value: 90 } };
    expect(settingGroupIssues(FIXTURE, two)).toEqual([]);
    expect(two).toHaveLength(2);
    expect(two[0]!.readings.current).not.toEqual(two[1]!.readings.current);
  });

  it("rejects only the real errors: a channel the machine lacks, or a reused one", () => {
    const g = defaultSettingGroups();
    g[0]!.channels = [17];
    expect(settingGroupIssues(FIXTURE, g)[0]!.problem).toMatch(/outside 1\.\.16/);

    const two = addSettingGroup(defaultSettingGroups());
    two[0]!.channels = [4];
    two[1]!.channels = [4];
    expect(settingGroupIssues(FIXTURE, two)[0]!.problem).toMatch(/already recorded/i);
  });

  it("rejects a channel on a machine that has none", () => {
    const xcell = MACHINE_CATALOGUE.find((p) => p.profileId === "dectro-apilus:xcell")!;
    const g = defaultSettingGroups();
    g[0]!.channels = [1];
    expect(settingGroupIssues(xcell, g)[0]!.problem).toMatch(/no independently controlled/i);
  });
});

describe("a disputed manual range never blocks submission", () => {
  it("records a value above a disputed bound and does not block", () => {
    const outcome = validateReading(
      {
        profileId: "fixture:multineedle",
        version: 2,
        modeKey: "galvanic",
        fieldKey: "current",
        source: "practitioner-entered",
        value: { kind: "value", value: 900 },
      },
      { catalogue: CAT },
    );
    expect(outcome.ok).toBe(true);
    expect(blocksSubmission(outcome)).toBe(false);
    if (outcome.ok) expect(outcome.recorded).toEqual({ kind: "value", value: 900 });
  });

  it("still blocks genuinely malformed input", () => {
    const outcome = validateReading(
      {
        profileId: "fixture:multineedle",
        version: 2,
        modeKey: "galvanic",
        fieldKey: "duration",
        source: "practitioner-entered",
        value: { kind: "value", value: Number.NaN },
      },
      { catalogue: CAT },
    );
    expect(blocksSubmission(outcome)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Next visit
// ---------------------------------------------------------------------------

const PRIOR: RecordedSetup = {
  profileId: "fixture:multineedle",
  profileVersion: 2,
  modeKey: "galvanic",
  recordedAt: "2026-09-20T15:04:00Z",
  sessionId: "sess-77",
  groups: [
    {
      groupId: "g1",
      channels: [1, 2],
      readings: {
        current: { kind: "value", value: 120 },
        duration: { kind: "value", value: 300 },
      },
    },
    {
      groupId: "g2",
      channels: [3],
      readings: {
        current: { kind: "value", value: 90 },
        duration: { kind: "absent", reason: "not-recorded" },
      },
    },
  ],
};

describe("next-visit retrieval gives the setup back accurately", () => {
  it("shows machine, mode, every group and channel, units, session and time", () => {
    const v = priorSetupView(PRIOR, CAT);
    expect("unavailable" in v).toBe(false);
    if ("unavailable" in v) return;

    expect(v.machine).toBe("Fixture Multineedle");
    expect(v.modeLabel).toBe("Galvanic");
    expect(v.recordedAt).toBe("2026-09-20T15:04:00Z");
    expect(v.sessionId).toBe("sess-77");
    expect(v.renderedAgainstHistoricalVersion).toBe(false);

    // BOTH groups survive retrieval — a second probe group is not collapsed.
    expect(v.groups.map((g) => g.channels)).toEqual([[1, 2], [3]]);
    expect(v.groups[0]!.rows).toEqual([
      { key: "current", label: "Current", unit: "µA", display: "120" },
      { key: "duration", label: "Time", unit: "s", display: "300" },
    ]);
  });

  it("distinguishes a reasoned absence from a zero", () => {
    const v = priorSetupView(PRIOR, CAT);
    if ("unavailable" in v) throw new Error("expected a view");
    expect(v.groups[1]!.rows[1]!.display).toBe("not recorded");

    const zeroed: RecordedSetup = {
      ...PRIOR,
      groups: [
        { groupId: "g1", channels: [], readings: { current: { kind: "value", value: 0 } } },
      ],
    };
    const z = priorSetupView(zeroed, CAT);
    if ("unavailable" in z) throw new Error("expected a view");
    expect(z.groups[0]!.rows[0]!.display).toBe("0");
  });

  it("does NOT relabel a setup recorded against an older contract version", () => {
    // "Historical renderers must use the recorded version." With the contract
    // moved on, the recorded KEYS are shown rather than today's labels/units.
    const old: RecordedSetup = { ...PRIOR, profileVersion: 1 };
    const v = priorSetupView(old, CAT);
    if ("unavailable" in v) throw new Error("expected a view");
    expect(v.renderedAgainstHistoricalVersion).toBe(true);
    expect(v.profileVersion).toBe(1);
    expect(v.groups[0]!.rows[0]!.label).toBe("current"); // the key, not "Current"
    expect(v.groups[0]!.rows[0]!.unit).toBe("");
    // The values themselves are untouched.
    expect(v.groups[0]!.rows[0]!.display).toBe("120");
  });

  it("preserves readings recorded on a profile that left the catalogue", () => {
    const v = priorSetupView({ ...PRIOR, profileId: "gone:forever" }, CAT);
    expect("unavailable" in v).toBe(true);
    if ("unavailable" in v) expect(v.unavailable).toMatch(/preserved as recorded/i);
  });
});

describe("carry-forward is a reviewable proposal that clears on incompatibility", () => {
  const sameTarget = {
    profileId: "fixture:multineedle",
    profileVersion: 2,
    modeKey: "galvanic",
  };

  it("proposes the prior setup for the same machine, version and mode", () => {
    const p = proposeSetup(PRIOR, sameTarget, CAT);
    expect(p.propose).toBe(true);
    if (!p.propose) return;
    expect(p.needsReview).toBe(true);
    expect(p.groups).toHaveLength(2);
    expect(p.groups[0]!.readings.current).toEqual({ kind: "value", value: 120 });
  });

  it("CLEARS on a model change", () => {
    const p = proposeSetup(
      PRIOR,
      { profileId: "dectro-apilus:xcell", profileVersion: 1, modeKey: "multiplex" },
      CAT,
    );
    expect(p.propose).toBe(false);
    if (!p.propose) {
      expect(p.reason).toBe("profile");
      expect(p.message).toMatch(/do not transfer between models/i);
    }
  });

  it("CLEARS on a mode change", () => {
    const p = proposeSetup(PRIOR, { ...sameTarget, modeKey: "adjunct" }, CAT);
    expect(p.propose).toBe(false);
    if (!p.propose) expect(p.reason).toBe("mode");
  });

  it("CLEARS on a contract version change rather than converting units", () => {
    const p = proposeSetup(PRIOR, { ...sameTarget, profileVersion: 3 }, CAT);
    expect(p.propose).toBe(false);
    if (!p.propose) expect(p.reason).toBe("version");
  });

  it("CLEARING THE PROPOSAL CHANGES NO HISTORICAL DATA", () => {
    const before = JSON.stringify(PRIOR);
    proposeSetup(PRIOR, { profileId: "other:thing", profileVersion: 9, modeKey: "x" }, CAT);
    expect(JSON.stringify(PRIOR)).toBe(before);
  });

  it("editing an accepted proposal cannot reach the stored prior setup", () => {
    const p = proposeSetup(PRIOR, sameTarget, CAT);
    if (!p.propose) throw new Error("expected a proposal");
    p.groups[0]!.readings.current = { kind: "value", value: 999 };
    p.groups[0]!.channels.push(16);
    // The stored setup is untouched: the proposal holds deep copies.
    expect(PRIOR.groups[0]!.readings.current).toEqual({ kind: "value", value: 120 });
    expect(PRIOR.groups[0]!.channels).toEqual([1, 2]);
  });
});
