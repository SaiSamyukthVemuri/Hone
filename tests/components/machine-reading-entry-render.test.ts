import { describe, expect, it } from "vitest";

import type { MachineProfile } from "@/lib/machines/profile-contract";

// ===========================================================================
// A RENDER LOCK for MachineReadingEntry, captured BEFORE its draft fields were
// extracted into a shared component.
//
// WHY A LOCK AND NOT MORE ASSERTIONS. The extraction exists so the create-mode
// surface can collect machine settings with no block to save them against,
// reusing the same fields rather than growing a second copy of them. It is
// meant to change NOTHING about what this component renders - and "nothing"
// is a claim that needs a before and an after, not a reading of the diff.
//
// HOW THE BASELINE WAS OBTAINED, stated because a golden value whose
// provenance is unclear is worth little: a temporary capture test rendered the
// PRE-EXTRACTION component with the fixture below and printed its testids and
// visible text; those two lists are pasted here verbatim and the capture test
// was deleted in the same change.
//
// WHAT IT DOES NOT COVER. A static render cannot press "Add setting group", so
// the two-group layout is not locked here - its testids change shape with the
// group count (`reading-current` becomes `reading-g2-current`), and that is
// covered by the panel suite and by e2e step 13, WHICH HAS NOT RUN. The lock
// is the single-group render, which is what every first capture is.
//
// A FAILURE HERE IS NOT NECESSARILY A BUG. It means the render changed, which
// during a no-change refactor is a defect, and after a deliberate copy or
// layout change is a decision to record by updating these lists and saying
// why.
// ===========================================================================

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MachineReadingEntry } = await import(
  "@/components/machines/machine-reading-entry"
);

const PROFILE = {
  profileId: "fixture:baseline",
  version: 1,
  family: "Synthetic/Demo",
  manufacturer: "Fixture",
  model: "Baseline",
  availability: "active",
  verification: "device-confirmed",
  frequency: { kind: "not-applicable" },
  channels: {
    count: 4,
    nativeLabel: "Probe",
    associationRequired: false,
    supportsDistinctSettingGroups: true,
    verification: "device-confirmed",
    evidence: [],
  },
  evidence: [],
  modes: [
    {
      key: "galvanic",
      nativeLabel: "Galvanic",
      stages: [],
      fields: [
        {
          key: "current",
          nativeLabel: "Current",
          unit: "µA",
          decimals: 0,
          quantity: "current",
          scope: "per-channel",
          optional: false,
          editable: true,
          source: "practitioner-entered",
          advisory: ["Current is documented in microamps."],
        },
        {
          key: "duration",
          nativeLabel: "Time",
          unit: "s",
          decimals: 1,
          quantity: "duration",
          scope: "per-channel",
          optional: true,
          editable: true,
          source: "practitioner-entered",
          advisory: [],
        },
      ],
    },
  ],
} as unknown as MachineProfile;

const html = renderToStaticMarkup(
  createElement(MachineReadingEntry, {
    profile: PROFILE,
    mode: PROFILE.modes[0]!,
    blockId: "block-1",
    deviceId: "dev-1",
    onRecord: async () => ({ ok: true }),
    mintKey: () => "k1",
  }),
);

const testids = [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);
const text = html
  .replace(/<[^>]+>/g, "\u0001")
  .split("\u0001")
  .map((t) => t.trim())
  .filter(Boolean);

/** Captured from the PRE-EXTRACTION component. */
const BASELINE_TESTIDS = [
  "machine-reading-entry",
  "setting-group-g1",
  "setting-group-g1-channel-1",
  "setting-group-g1-channel-2",
  "setting-group-g1-channel-3",
  "setting-group-g1-channel-4",
  "setting-group-g1-no-channels",
  "field-label-current",
  "field-unit-current",
  "reading-current",
  "field-label-duration",
  "field-unit-duration",
  "reading-duration",
  "setting-group-add",
  "machine-reading-save",
];

/** Captured from the PRE-EXTRACTION component. */
const BASELINE_TEXT = [
  "Probes these settings applied to",
  "1",
  "2",
  "3",
  "4",
  "No probe recorded for this group. This is saved as no association — not as every probe.",
  "Galvanic",
  "Current",
  "(µA)",
  "Time",
  "(s)",
  "optional",
  "Add setting group",
  "Save these settings",
  "Enter every required field before saving.",
];

describe("the entry form's render is unchanged by the extraction", () => {
  it("emits the same testids, in the same order", () => {
    // ORDER MATTERS, not just membership: a field moved above its label, or a
    // group's channels rendered after its readings, is a different form even
    // though the same ids appear.
    expect(testids).toEqual(BASELINE_TESTIDS);
  });

  it("shows the same words, in the same order", () => {
    // The machine's OWN label and unit are in here - "Current", "(µA)", and
    // "Time" for duration - so this also locks the rule that the fields come
    // from the model and not from the component.
    expect(text).toEqual(BASELINE_TEXT);
  });

  it("is not vacuous: the fixture really renders the form", () => {
    // Without this, an empty render would satisfy two equal-to-baseline
    // assertions if the baselines were ever emptied too.
    expect(testids.length).toBeGreaterThan(10);
    expect(html).toContain('data-testid="machine-reading-entry"');
    expect(html).toContain("Save these settings");
  });
});
