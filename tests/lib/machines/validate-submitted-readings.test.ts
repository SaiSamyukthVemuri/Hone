import { describe, expect, it, vi } from "vitest";

import type { MachineProfile } from "@/lib/machines/profile-contract";
import type { StudioDevice } from "@/lib/machines/selection";
import type { ReadingSubmission } from "@/lib/machines/machine-queries";

// THE CATALOGUE IS INJECTED THROUGH THE MODULE THE VALIDATOR ACTUALLY READS.
//
// `validateSubmittedReadings(device, profile, ...)` takes a profile, but
// validates against `catalogueForRuntime()` and uses the argument only for
// `profile.profileId`. A fixture passed as that argument is therefore NOT the
// contract checked - the first version of this file learned that the hard way,
// with every case failing on "No catalogue profile 'fixture:submit'" and three
// of them PASSING on that unrelated error because they asserted only that an
// error existed.
const runtimeCatalogue = vi.hoisted(() => ({ value: [] as MachineProfile[] }));
vi.mock("@/lib/machines/synthetic-profile", () => ({
  catalogueForRuntime: () => runtimeCatalogue.value,
}));

const { validateSubmittedReadings } = await import(
  "@/lib/machines/validate-submitted-readings"
);

// ===========================================================================
// THE SUBMIT PATH'S OWN CONTRACT (Codex, #860 4309004312, half (b))
// ===========================================================================
//
// WHY THIS FILE EXISTS AT ALL: `validateSubmittedReadings` is reachable from
// THREE server paths - the per-group command, the whole-save command and the
// initial save that creates the treatment area - and it had no test of its
// own. Everything asserted about it was asserted through an action, so a rule
// it fails to APPLY (as opposed to applies wrongly) was invisible.
//
// THE DEFECT. `validateReading` enforces a mandatory channel association
// correctly, and `machine-profile-catalogue.test.ts` proves both directions:
// refused with no channel, accepted with one. But the submit path builds its
// `ReadingInput` WITHOUT a `channel` field at all - channels are a GROUP-level
// fact and never travelled with the reading - so for a profile declaring
// `associationRequired: true` the "accepted with one" branch is unreachable:
// every numeric reading is refused with `channel_required` even when the group
// did name its channels. A user-facing save blocker.
//
// NOT REACHABLE TODAY, and that is stated rather than implied: no profile in
// the catalogue or the synthetic fixture sets `associationRequired: true` - the
// only `channels` block is `permanence-gemm:gemm-16`, which is BLOCKED and
// sets it false. So this is a latent blocker that would have surfaced on the
// day the first such contract was published, which for GEMM is the day its
// evidence review completes.
//
// Synthetic contracts only. Nothing here corresponds to a real machine.

const FX_EVIDENCE = [
  {
    id: "fx",
    kind: "studio-device-photo" as const,
    consultedOn: "2026-10-18",
    establishes: "Nothing about a real machine.",
  },
];

const field = {
  key: "current",
  nativeLabel: "Current",
  quantity: "current" as const,
  unit: "mA" as const,
  decimals: 1,
  optional: false,
  expectedSource: "practitioner-entered" as const,
  editable: true,
  verification: "device-confirmed" as const,
  evidence: ["fx"],
};

function profileWith(channels: Record<string, unknown> | undefined): MachineProfile {
  return {
    profileId: "fixture:submit",
    version: 1,
    family: "Dectro/Apilus",
    manufacturer: "Fixture",
    model: "Submit",
    availability: "active",
    verification: "device-confirmed",
    frequency: { kind: "not-applicable" },
    evidence: FX_EVIDENCE,
    openQuestions: [],
    ...(channels ? { channels } : {}),
    modes: [
      {
        key: "m",
        nativeLabel: "M",
        family: "thermolysis",
        availability: "active",
        verification: "device-confirmed",
        evidence: ["fx"],
        stages: [],
        fields: [field],
      },
    ],
  } as unknown as MachineProfile;
}

const REQUIRES_CHANNEL = profileWith({
  count: 4,
  nativeLabel: "Channel",
  associationRequired: true,
  supportsDistinctSettingGroups: true,
  verification: "device-confirmed",
  evidence: ["fx"],
});

const OPTIONAL_CHANNEL = profileWith({
  count: 4,
  nativeLabel: "Channel",
  associationRequired: false,
  supportsDistinctSettingGroups: true,
  verification: "device-confirmed",
  evidence: ["fx"],
});

const NO_CHANNELS = profileWith(undefined);

const device: StudioDevice = {
  deviceId: "dev-1",
  studioId: "studio-1",
  profileId: "fixture:submit",
  profileVersion: 1,
  displayName: "Room 1 fixture",
  installedOptions: [],
  retiredAt: null,
};

const reading: ReadingSubmission = {
  stageKey: null,
  fieldKey: "current",
  value: { kind: "value", value: 1.2 },
  observationSource: "practitioner-entered",
};

const run = (
  profile: MachineProfile,
  channels: number[],
  readings: readonly ReadingSubmission[] = [reading],
) => {
  // PUBLISHED, so the contract validated against is the one under test.
  runtimeCatalogue.value = [profile];
  return validateSubmittedReadings(device, profile, "m", readings, channels);
};

/** The error text, or null when the group was accepted. */
const errorOf = (
  out: ReturnType<typeof validateSubmittedReadings>,
): string | null => ("error" in out ? out.error : null);

describe("ANTI-VACUITY: the fixture really is the contract under test", () => {
  // Without this, a case that fails on profile RESOLUTION looks exactly like a
  // case that fails on the channel rule - which is how three cases in the
  // first version of this file came to pass for the wrong reason.
  it("the fixture profile resolves, so no case can fail on 'unknown model'", () => {
    const out = run(OPTIONAL_CHANNEL, []);
    expect(errorOf(out), "the fixture is not in the catalogue the validator reads").toBeNull();
  });

  it("and an unpublished profile DOES fail on resolution, so the check above is real", () => {
    runtimeCatalogue.value = [];
    const out = validateSubmittedReadings(
      device,
      OPTIONAL_CHANNEL,
      "m",
      [reading],
      [],
    );
    expect(errorOf(out)).toMatch(/No catalogue profile/);
  });
});

describe("a group that NAMES its channels satisfies a mandatory association", () => {
  it("is accepted when the group named one", () => {
    const out = run(REQUIRES_CHANNEL, [2]);
    expect(
      errorOf(out),
      "a valid group that DID pick a channel was refused, so the save is blocked",
    ).toBeNull();
    expect("rows" in out && out.rows).toHaveLength(1);
  });

  it("and when it named several, which is what a group may do", () => {
    // `channels` is a group-level LIST: one probe set can be associated with
    // more than one independently controlled output. The requirement is that
    // the group names its channels, not that a reading names exactly one.
    const out = run(REQUIRES_CHANNEL, [3, 4]);
    expect(errorOf(out)).toBeNull();
  });

  it("and the row is still built, with the machine's own unit and precision", () => {
    // RE-NAMED. The first title claimed the row "carries the association",
    // which it does not and must not: `ReadingInputRow` has no channel,
    // because the association is a GROUP-level fact that 0223 stores through
    // `p_channels`. A test whose name overstates its assertions reports
    // coverage that is not there.
    const out = run(REQUIRES_CHANNEL, [2]);
    expect("rows" in out).toBe(true);
    if ("rows" in out) {
      expect(out.rows).toHaveLength(1);
      expect(out.rows[0]).toMatchObject({
        fieldKey: "current",
        nativeUnit: "mA",
        decimals: 1,
      });
      expect(out.rows[0]).not.toHaveProperty("channel");
    }
  });
});

describe("but an UNASSOCIATED group is still refused when the contract requires one", () => {
  it("an empty channel list is refused", () => {
    const out = run(REQUIRES_CHANNEL, []);
    expect(errorOf(out), "an unassociated group was accepted").toMatch(
      /requires each reading to name one/,
    );
  });

  it("CONTROL: the same empty list is fine when the contract does NOT require one", () => {
    // The practitioner ruling that `associationRequired: false` encodes: a
    // setup saves without a mandatory row per channel. Every profile shipped
    // today is in this branch, so this is the path in production.
    expect(errorOf(run(OPTIONAL_CHANNEL, []))).toBeNull();
  });

  it("CONTROL: and fine for a profile with no channels at all", () => {
    expect(errorOf(run(NO_CHANNELS, []))).toBeNull();
  });

  it("an ABSENT reading is not forced to name a channel", () => {
    // `validateReading` applies the requirement only to a `value` reading: a
    // not-recorded field has no association to make, and demanding one would
    // make "not recorded" unrecordable on such a model.
    const absent: ReadingSubmission = {
      stageKey: null,
      fieldKey: "current",
      value: { kind: "absent", reason: "not-recorded" },
      observationSource: "practitioner-entered",
    };
    expect(errorOf(run(REQUIRES_CHANNEL, [], [absent]))).toBeNull();
  });
});

describe("and the channel itself is still validated, not merely counted", () => {
  it("a channel outside the model's count is refused", () => {
    const out = run(REQUIRES_CHANNEL, [9]);
    expect(
      errorOf(out),
      "channel 9 on a 4-channel model was accepted",
    ).toMatch(/channel/i);
  });

  it("a channel on a profile with NO channels is refused", () => {
    const out = run(NO_CHANNELS, [1]);
    expect(
      errorOf(out),
      "a channel was accepted on a model that has none - a probe-holder outlet is not a channel",
    ).toMatch(/no independently controlled channels/);
  });

  it("a LATER channel in the list is refused too, not just the first", () => {
    // Without this, validating only `channels[0]` passes every case above: the
    // first channel is valid in all of them. An out-of-range channel further
    // down the list would be stored.
    const out = run(REQUIRES_CHANNEL, [2, 9]);
    expect(
      errorOf(out),
      "only the first named channel was validated, so channel 9 was accepted",
    ).toMatch(/channel/i);
  });

  it("a malformed channel is refused", () => {
    expect(errorOf(run(REQUIRES_CHANNEL, [0]))).toMatch(/channel/i);
    expect(errorOf(run(REQUIRES_CHANNEL, [1.5]))).toMatch(/channel/i);
  });
});
