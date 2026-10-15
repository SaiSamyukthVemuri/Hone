import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import type { MachineProfile } from "@/lib/machines/profile-contract";

// ===========================================================================
// COLLECTING MACHINE SETTINGS WHEN THERE IS NO BLOCK YET.
//
// WHAT CHANGED. Until now the create form refused to collect a reading it had
// nowhere to put: a new settings block has no row, so the panel showed the
// model's field contract read-only and the practitioner saved the area,
// re-opened it, and recorded. Two steps for one act.
//
// `create_block_with_initial_setup` (0223) writes the area and the settings in
// ONE transaction, so there is now somewhere to put them. This collects them
// for that save - and saves nothing itself.
//
// THE SQL HAS NOT RUN. 0223 is pending; the behavioural specification is
// tests/db/machine-setup-submission.db.test.ts and it has not executed. What
// is proved here is the RENDER and the SHAPE of the handoff.
// ===========================================================================

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MachineSettingDraft } = await import(
  "@/components/machines/machine-setting-draft"
);

const PROFILE = {
  profileId: "fixture:draft",
  version: 1,
  family: "Synthetic/Demo",
  manufacturer: "Fixture",
  model: "Draft",
  availability: "active",
  verification: "device-confirmed",
  frequency: { kind: "not-applicable" },
  channels: {
    count: 2,
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
          advisory: [],
        },
      ],
    },
  ],
} as unknown as MachineProfile;

const html = renderToStaticMarkup(
  createElement(MachineSettingDraft, {
    profile: PROFILE,
    mode: PROFILE.modes[0]!,
    onDraftChange: () => {},
  }),
);

describe("the create-mode collector", () => {
  it("renders the machine's own fields", () => {
    // THE SAME COMPONENT the entry form uses, which is the point of having
    // extracted it: one definition of what the contract says a reading is.
    expect(html).toContain('data-testid="machine-setting-draft"');
    expect(html).toContain('data-testid="field-label-current"');
    expect(html).toContain("(µA)");
    expect(html).toContain('data-testid="reading-current"');
  });

  it("SAYS that these save with the treatment area", () => {
    // The difference from the entry form is not visible in the fields. With
    // no block there is no separate Save to press, so without this line she
    // has no way to know whether the area's Save carries them.
    expect(html).toContain('data-testid="setting-draft-note"');
    expect(html).toMatch(/saved together with the treatment area/i);
    expect(html).toMatch(/one save/i);
  });

  it("offers NO save control of its own", () => {
    // It saves nothing. The host form's Save is the only one, and a second
    // button would be a second way to do one thing - with no block to record
    // against, it could not work anyway.
    expect(html).not.toContain('data-testid="machine-reading-save"');
    expect(html).not.toContain("Save these settings");
    expect(html).not.toContain('data-testid="machine-reading-saved"');
  });

  it("starts EMPTY, so nothing can be recorded unread", () => {
    // A value she has not read off the machine is not a reading, and the
    // record must not be able to acquire one by her failing to notice a
    // filled box.
    const input = (html.match(/<input[^>]*>/g) ?? []).find((t) =>
      t.includes('data-testid="reading-current"'),
    );
    expect(input, "no entry input was rendered").toBeTruthy();
    expect(input).not.toMatch(/value="[^"]+"/);
  });
});

describe("the handoff's shape, pinned on source", () => {
  const read = (rel: string) =>
    readFileSync(nodePath.resolve(__dirname, "../..", rel), "utf8").replace(
      /^\s*(\/\/|\*|\/\*).*$/gm,
      " ",
    );

  const DRAFT = "components/machines/machine-setting-draft.tsx";
  const PANEL = "components/machines/machine-first-setup-panel.tsx";
  const CONN = "components/machines/machine-first-setup-connected.tsx";
  const FORM = "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx";

  it("reports the NEXT draft, not the current state", () => {
    // `setGroups` has not applied when the report runs, so reporting from
    // state would always be one keystroke behind and the host would save the
    // previous values. The report is computed from the candidate.
    const src = read(DRAFT);
    expect(src).toMatch(/const report = \(next: SettingGroupDraft\[\]\)/);
    expect(src).toMatch(/const next = f\(prev\);\s*\n\s*report\(next\);/);
  });

  it("assembles the groups so the host does not reimplement it", () => {
    expect(read(DRAFT)).toMatch(/assembleGroupSubmissions\(fieldGroups, next\)/);
  });

  it("delegates WHY a draft blocks to the shared rule", () => {
    // It computed this inline until a negative control caught it: "a
    // half-finished draft is reported as ready" could be mutated in and every
    // test stayed green, because a static render cannot type into a field.
    // The rule is `draftBlocking` in lib/machines/setting-groups.ts and is
    // proved directly in tests/lib/machines/setting-groups.test.ts.
    const src = read(DRAFT);
    expect(src).toMatch(/draftBlocking\(profile, fieldGroups, next\)/);
    expect(
      src,
      "the rule must not be reimplemented here",
    ).not.toMatch(/missing a required field/);
  });

  it("the PANEL renders it only when there is no block AND a host to carry it", () => {
    // Three arms. Without a host that can carry a draft the panel still shows
    // the contract read-only, because it must never collect a reading it has
    // nowhere to put.
    expect(read(PANEL)).toMatch(/!blockId && onSettingDraft && mode \?/);
  });

  it("the PANEL supplies the identity, which the collector cannot know", () => {
    // The collector has the profile and the mode but not which physical unit
    // is chosen, and the host needs all four: a draft typed under one machine
    // and saved under another is numbers she never read off anything.
    const src = read(PANEL);
    expect(src).toMatch(/deviceId: chosen\.device\.deviceId/);
    expect(src).toMatch(/profileVersion: chosen\.profile\.version/);
    expect(src).toMatch(/modeKey: mode\.key/);
  });

  it("the WRAPPER forwards it — the step that made two features inert", () => {
    expect(read(CONN)).toMatch(/onSettingDraft=\{onSettingDraft\}/);
  });

  it("the FORM supplies it ONLY in create mode", () => {
    // On an existing block the panel records directly, so the two paths must
    // never both be live.
    expect(read(FORM)).toMatch(
      /onSettingDraft=\{block \? undefined : setMachineDraft\}/,
    );
  });

  it("the FORM refuses to save a half-finished draft", () => {
    // Skipping it would discard numbers she typed; sending it would be
    // refused by the command after a round trip.
    const src = read(FORM);
    expect(src).toMatch(/if \(machineDraft\?\.blocking\)/);
    expect(src).toMatch(/setError\(machineDraft\.blocking\)/);
  });

  it("the FORM mints the retry key ONCE, through prepareHandoff", () => {
    // Minting per attempt would make every retry a new save; never minting a
    // new one would make a deliberate second capture impossible. And
    // `prepareHandoff` COPIES the groups, so a keystroke landing after the
    // save began cannot change what is recorded under the same key.
    const src = read(FORM);
    expect(src).toMatch(/prepareHandoff\(identity, chosen\.groups,/);
    expect(src).toMatch(/initialSetup: machineSetupForSave\(\)/);
    expect((src.match(/randomUUID/g) ?? []).length).toBe(1);
  });
});
