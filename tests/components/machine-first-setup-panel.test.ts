import { describe, expect, it } from "vitest";

import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import type { MachineProfile } from "@/lib/machines/profile-contract";
import type { StudioDevice } from "@/lib/machines/selection";

// MPX-03 mount. What the machine-first panel actually RENDERS.
//
// These assertions run the real component through react-dom/server rather than
// grepping its source, which is the idiom this repo already uses for render
// contracts (see tests/app/reliability/authenticated-error-boundary.test.ts).
// A refactor that rephrases the honest status lines, or that quietly starts
// collecting readings, fails here.
//
// Verified with SYNTHETIC records only. No studio, practitioner, client or
// device in this file corresponds to anything real.

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MachineFirstSetupPanel } = await import(
  "@/components/machines/machine-first-setup-panel"
);
const { MachineFirstSetupConnected } = await import(
  "@/components/machines/machine-first-setup-connected"
);
const { NO_PERSISTENCE, DATABASE_PERSISTENCE, TEST_STORE_PERSISTENCE } =
  await import("@/lib/machines/selection-store");
const { readFileSync } = await import("node:fs");
const nodePath = (await import("node:path")).default;

/** Synthetic, active, GEMM-shaped. Not a real machine. */
const SYNTHETIC: MachineProfile = {
  profileId: "fixture:panel",
  version: 1,
  family: "Permanence/GEMM-16",
  manufacturer: "Fixture",
  model: "Panel",
  availability: "active",
  verification: "device-confirmed",
  frequency: { kind: "not-applicable" },
  evidence: [
    {
      id: "p",
      kind: "studio-device-photo",
      consultedOn: "2026-10-12",
      establishes: "A synthetic unit used to render the chosen state.",
    },
  ],
  openQuestions: [],
  channels: {
    count: 16,
    nativeLabel: "Channel",
    associationRequired: false,
    supportsDistinctSettingGroups: true,
    verification: "device-confirmed",
    evidence: ["p"],
  },
  modes: [
    {
      key: "galvanic",
      nativeLabel: "Galvanic",
      family: "galvanic",
      availability: "active",
      verification: "device-confirmed",
      evidence: ["p"],
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
          evidence: ["p"],
          ranges: [
            {
              max: 400,
              class: "hardware-enforced",
              evidence: "p",
              discrepancy: "the brochure and the manual disagree",
            },
          ],
        },
        {
          key: "duration",
          nativeLabel: "Time",
          quantity: "duration",
          unit: "s",
          decimals: 1,
          optional: false,
          expectedSource: "practitioner-entered",
          editable: true,
          verification: "device-confirmed",
          evidence: ["p"],
        },
        {
          key: "computed",
          nativeLabel: "Total",
          quantity: "energy-display",
          unit: "device-display",
          decimals: 0,
          optional: true,
          expectedSource: "device-computed",
          editable: false,
          verification: "device-confirmed",
          evidence: ["p"],
        },
      ],
    },
  ],
};

const CAT = [SYNTHETIC, ...MACHINE_CATALOGUE];
const SCOPE = { studioId: "studio-synthetic", practitionerId: "pract-synthetic" };

const DEVICE: StudioDevice = {
  deviceId: "room-9",
  studioId: "studio-synthetic",
  profileId: "fixture:panel",
  profileVersion: 1,
  displayName: "Room 9 unit",
  installedOptions: [],
  retiredAt: null,
};

function render(props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(MachineFirstSetupPanel, props));
}

// ---------------------------------------------------------------------------

describe("the panel with no identity yet", () => {
  // The pure panel with no props. This is what the connected wrapper renders
  // on its FIRST paint, before the server identity round trip returns - and
  // what it keeps rendering if that read fails. Charting below is unaffected
  // either way, so the honest unscoped state is the correct fallback.
  const html = render();

  it("renders at all, and heads the block with the machine", () => {
    expect(html).toContain('data-testid="machine-first-panel"');
    expect(html).toContain("Machine");
  });

  it("says no verified machine is available, and why", () => {
    expect(html).toContain("No verified machine is available to select yet");
    expect(html).toContain(
      "does not yet know which practitioner and studio is charting",
    );
  });

  it("offers no machine to choose", () => {
    expect(html).not.toContain("Choose the machine you are working on");
  });
});

describe("evidence-blocked models are exposed truthfully", () => {
  const html = render();

  it("lists every withheld profile by name", () => {
    expect(html).toContain("Not yet selectable");
    for (const name of [
      "Dectro xCell",
      "Dectro Senior 3G",
      "Dectro Junior 3G",
      "Silhouet-Tone ST 250",
      "Silhouet-Tone Evolution 5HD",
      "Silhouet-Tone Evolution ST 350",
      "Permanence GEMM-16",
    ]) {
      expect(html, `${name} should be shown, not silently omitted`).toContain(name);
    }
  });

  it("gives the real reason rather than a generic one", () => {
    // The ST 350's reason is the finding from the activation review.
    expect(html).toContain("four native display LABELS");
    // The ST 250's is the 403 manual.
    expect(html).toContain("403");
    // The GEMM's is its timer page.
    expect(html).toContain("microamps");
  });

  it("marks a legacy-only profile as historical rather than merely blocked", () => {
    expect(html).toContain("Dectro Platinum");
    expect(html).toContain("historical records only");
  });

  it("distinguishes the two GEMM variants", () => {
    expect(html).toContain("Permanence GEMM-16 (US)");
    expect(html).toContain("Permanence GEMM-16 (Beauty)");
  });
});

describe("real persistence status is stated in the UI", () => {
  const html = render();

  it("says the choice is not remembered", () => {
    expect(html).toContain('data-testid="machine-first-status"');
    expect(html).toContain("Remembered:");
    expect(html).toContain("lasts for this form only");
  });

  it("says nothing from the panel is recorded, and the fields below still are", () => {
    expect(html).toContain("Recorded:");
    expect(html).toContain("nothing from this panel");
    expect(html).toContain("remain the record");
  });

  it("never claims a saved selection", () => {
    expect(html.toLowerCase()).not.toContain("saved");
    expect(html.toLowerCase()).not.toContain("remembered for next time");
  });
});

describe("with a synthetic studio machine, selection is offered", () => {
  const html = render({ scope: SCOPE, devices: [DEVICE], catalogue: CAT });

  it("invites the machine-first choice", () => {
    expect(html).toContain("Choose the machine you are working on before entering settings");
  });

  it("names the studio's own device and the exact model behind it", () => {
    expect(html).toContain("Room 9 unit");
    expect(html).toContain("Fixture Panel");
  });

  it("does not offer a device from another studio", () => {
    const other = render({
      scope: { studioId: "studio-elsewhere", practitionerId: "pract-synthetic" },
      devices: [DEVICE],
      catalogue: CAT,
    });
    expect(other).not.toContain("Room 9 unit");
    expect(other).toContain("has no registered machine on a reviewed profile");
  });
});

describe("once chosen, the panel shows that model's native fields", () => {
  const html = render({
    scope: SCOPE,
    devices: [DEVICE],
    initialDeviceId: "room-9",
    catalogue: CAT,
  });

  it("names the chosen device, model and mode", () => {
    expect(html).toContain("Room 9 unit");
    expect(html).toContain("Fixture Panel");
    expect(html).toContain("Galvanic");
  });

  it("offers a visible way to change machine", () => {
    expect(html).toContain("Change machine");
  });

  it("renders the machine's own labels with their native units", () => {
    expect(html).toContain("Current");
    expect(html).toContain("(µA)");
    expect(html).toContain("Time");
    expect(html).toContain("(s)");
  });

  it("writes no unit for the machine's own display scale", () => {
    // `Total` is a device-display field: inventing a unit for it would be the
    // normalisation the contract forbids.
    expect(html).toContain("Total");
    expect(html).not.toContain("(device-display)");
  });

  it("states the precision the record will preserve", () => {
    expect(html).toContain("whole numbers");
    expect(html).toContain("1 decimal place");
  });

  it("marks an optional, machine-computed field as both", () => {
    expect(html).toContain("optional");
    expect(html).toContain("shown by the machine");
  });

  it("shows a disputed bound as advisory text, not as a limit or an error", () => {
    expect(html).toContain("sources disagree");
    expect(html).toContain("Record what the machine shows");
    expect(html.toLowerCase()).not.toContain("maximum allowed");
    expect(html).not.toContain("role=\"alert\"");
  });

  it("does NOT render sixteen channel rows for a sixteen-channel machine", () => {
    for (const n of ["Channel 1", "Channel 16", "Channel 8"]) {
      expect(html, `${n} must not be a mandatory row`).not.toContain(n);
    }
  });
});

describe("the panel records nothing, structurally", () => {
  const chosen = render({
    scope: SCOPE,
    devices: [DEVICE],
    initialDeviceId: "room-9",
    catalogue: CAT,
  });

  it("renders no input, textarea or select anywhere", () => {
    // The load-bearing safety property of this slice: there are no reading
    // columns yet, and a clinical form that accepted numbers and then dropped
    // them would be worse than one that does not ask. The only controls are
    // the machine buttons and "Change machine".
    for (const tag of ["<input", "<textarea", "<select"]) {
      expect(chosen, `${tag} would imply this panel collects readings`).not.toContain(
        tag,
      );
    }
  });

  it("carries no form element of its own", () => {
    expect(chosen).not.toContain("<form");
  });
});

// ---------------------------------------------------------------------------
// Server-derived identity, and the persisted / test-store distinction
// ---------------------------------------------------------------------------

describe("the connected wrapper makes NO request until asked", () => {
  const html = renderToStaticMarkup(createElement(MachineFirstSetupConnected, {
    clientId: "client-ana",
    sessionId: "session-1",
  }));

  it("renders a trigger, not the panel", () => {
    // THE REGRESSION THIS PINS. The first version loaded on mount, which added
    // a server-action POST to the session route every time a settings block
    // opened. e2e/repeat-client-fast-charting.spec.ts classifies any POST
    // without an idempotencyKey as a "source read" and exists to prove a
    // retried commit does not re-read the source, so that extra request broke
    // it; conditional-numbing-notes lost its save to the same race. The panel
    // must not appear, and no action must run, until she asks.
    expect(html).toContain('data-testid="machine-first-trigger"');
    expect(html).toContain('data-testid="machine-first-open"');
    expect(html).not.toContain('data-testid="machine-first-panel"');
  });

  it("states machine-first as an explicit step", () => {
    expect(html).toContain("Record which machine you are working on");
    expect(html).toContain("Choose machine");
  });

  it("uses no effect, so nothing can fire on mount", () => {
    const src = readFileSync(
      nodePath.resolve(
        __dirname,
        "../../components/machines/machine-first-setup-connected.tsx",
      ),
      "utf8",
    );
    // Comments stripped FIRST: this file's own header explains the regression
    // and names `useEffect` while doing so, and comment prose must never
    // satisfy or break a code assertion.
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    // An effect is how the regression got in. Its absence is the guard.
    expect(code).not.toContain("useEffect");
    expect(code).toContain("useCallback");
  });

  it("sends no ownership of its own", () => {
    const src = readFileSync(
      nodePath.resolve(
        __dirname,
        "../../components/machines/machine-first-setup-connected.tsx",
      ),
      "utf8",
    );
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    // It passes the ROUTE SUBJECT - which chart is open - and invents no
    // identity. Those are different things, and an earlier version of this
    // test conflated them: it demanded a no-argument loader, which is exactly
    // what made the prior-setup read fall back to the whole studio and show
    // one client's settings on another's chart (Codex, 9c6fbbe5).
    expect(code).toMatch(/loadMachineSetupContext\(\{\s*clientId,\s*sessionId\s*\}\)/);
    // No ownership, in any spelling.
    expect(code).not.toMatch(/studioId/);
    expect(code).not.toMatch(/practitionerId/);
    expect(code).not.toMatch(/studioId:\s*["'`]/);
    expect(code).not.toMatch(/practitionerId:\s*["'`]/);
  });
});

describe("a real studio with no inventory says so, specifically", () => {
  const html = render({
    scope: SCOPE,
    devices: [],
    inventoryReason:
      "No machine inventory exists in the database yet, so no studio has a registered machine to choose.",
    persistence: NO_PERSISTENCE,
  });

  it("names the missing inventory rather than blaming the studio", () => {
    expect(html).toContain("No machine inventory exists in the database yet");
    expect(html).not.toContain("does not yet know which practitioner and studio is charting");
  });
});

describe("persisted behaviour and test-store behaviour render differently", () => {
  it("the real capability reports no, with the reason", () => {
    const html = render({ scope: SCOPE, persistence: NO_PERSISTENCE });
    expect(html).toContain('data-persistence="none"');
    expect(html).toContain("Remembered:");
    expect(html).toContain("lasts for this form only");
  });

  it("a TEST STORE is labelled as one and never as a database", () => {
    // The dishonesty this guards against: a panel backed by an in-memory
    // double reporting the same "yes" a real column would.
    const html = render({ scope: SCOPE, persistence: TEST_STORE_PERSISTENCE });
    expect(html).toContain('data-persistence="test-store"');
    expect(html).toContain("test store only");
    expect(html).toContain("never reported to a practitioner");
  });

  it("neither rendering claims a saved selection", () => {
    for (const cap of [NO_PERSISTENCE, TEST_STORE_PERSISTENCE]) {
      const html = render({ scope: SCOPE, persistence: cap });
      expect(html.toLowerCase()).not.toContain("saved");
    }
  });
});

describe("historical values are untouched by anything here", () => {
  const actionsSrc = readFileSync(
    nodePath.resolve(
      __dirname,
      "../../app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts",
    ),
    "utf8",
  );
  const code = actionsSrc
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

  it("the machine actions touch no clinical table", () => {
    // Readings live in their own table, written only through the owner/member
    // gated command. No existing treatment record is reachable from here.
    //
    // Anchored to `.from("<table>")` rather than a bare substring search: the
    // substring form fails on any mention of the word, including the import
    // path "@/lib/sessions/session-lineage", while a real table access inside
    // a template string would look identical to it.
    for (const table of [
      "session_blocks",
      "electrolysis_entries",
      "laser_entries",
      "sessions",
      "clients",
    ]) {
      expect(code, `machine setup must not select from ${table}`).not.toMatch(
        new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]`),
      );
    }
  });

  it("performs no raw DML and no cache invalidation of its own", () => {
    // It legitimately builds a Supabase client now that the storage exists, so
    // the claim is about what it DOES with one: named commands only.
    expect(code).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(code).not.toContain("revalidatePath");
  });

  it("renders NO entry control until there is a block to record against", () => {
    // This replaces the old "no input anywhere" assertion rather than deleting
    // it. The panel still refuses to collect a reading it has nowhere to put:
    // without a blockId and a recorder it shows the field CONTRACT, read-only.
    const html = render({
      scope: SCOPE,
      devices: [DEVICE],
      initialDeviceId: "room-9",
      catalogue: CAT,
    });
    for (const tag of ["<input", "<textarea", "<select", "<form"]) {
      expect(html).not.toContain(tag);
    }
    // And what it shows instead is the contract: label, unit, precision.
    expect(html).toContain("Current");
    expect(html).toContain("(µA)");
    expect(html).toContain("whole numbers");
  });
});

describe("with a block to chart against, the entry surface appears", () => {
  const html = render({
    scope: SCOPE,
    devices: [DEVICE],
    initialDeviceId: "room-9",
    catalogue: CAT,
    blockId: "block-1",
    onRecord: async () => ({ ok: true }),
  });

  it("renders one input per native field, under the machine's own labels", () => {
    expect(html).toContain('data-testid="machine-reading-entry"');
    expect(html).toContain('data-testid="reading-current"');
    expect(html).toContain('data-testid="reading-duration"');
    expect(html).toContain("Current");
    expect(html).toContain("(µA)");
    expect(html).toContain("Time");
  });

  it("offers a save control", () => {
    expect(html).toContain('data-testid="machine-reading-save"');
    expect(html).toContain("Save these settings");
  });

  it("marks the machine-computed field as not editable", () => {
    // `Total` is device-computed on the fixture, so its input is disabled
    // rather than inviting a value the machine owns. The whole tag is
    // inspected because React emits attributes in source order, so a
    // one-directional regex would depend on JSX ordering.
    const tags = html.match(/<input[^>]*>/g) ?? [];
    const computed = tags.find((t) => t.includes('data-testid="reading-computed"'));
    expect(computed, "no input was rendered for the computed field").toBeTruthy();
    expect(computed).toContain("disabled");
    // And the practitioner-entered ones are NOT disabled.
    const current = tags.find((t) => t.includes('data-testid="reading-current"'));
    expect(current).not.toContain("disabled");
  });

  it("still shows the disputed bound as advisory, not as a limit", () => {
    expect(html).toContain("sources disagree");
    expect(html).not.toMatch(/max="400"/);
  });
});

describe("the next-visit retrieval renders the prior setup", () => {
  const html = render({
    scope: SCOPE,
    devices: [DEVICE],
    catalogue: CAT,
    priorSetup: [
      {
        blockId: "b1",
        profileId: "fixture:panel",
        profileVersion: 1,
        modeKey: "galvanic",
        groupKey: "g1",
        channels: [2],
        stageKey: null,
        fieldKey: "current",
        value: { kind: "value", value: 120 },
        nativeUnit: "µA",
        decimals: 0,
        recordedAt: "2026-09-20T15:04:00Z",
      },
    ],
  });

  it("names the machine, the mode, the value and its unit", () => {
    expect(html).toContain('data-testid="machine-prior-setup"');
    expect(html).toContain("Last recorded setup");
    expect(html).toContain("Fixture Panel");
    expect(html).toContain("Galvanic");
    expect(html).toContain("120");
    expect(html).toContain("µA");
  });

  it("shows the channel association that was recorded", () => {
    expect(html).toContain("Channels 2");
  });

  it("does NOT relabel a setup recorded against an older contract version", () => {
    const old = render({
      scope: SCOPE,
      catalogue: CAT,
      priorSetup: [
        {
          blockId: "b1",
          profileId: "fixture:panel",
          profileVersion: 99,
          modeKey: "galvanic",
          groupKey: "g1",
          channels: [],
          stageKey: null,
          fieldKey: "current",
          value: { kind: "value", value: 120 },
          nativeUnit: "µA",
          decimals: 0,
          recordedAt: "2026-09-20T15:04:00Z",
        },
      ],
    });
    // The recorded KEY, not today's label, and the difference is stated.
    expect(old).toContain("current");
    expect(old).toContain("field contract has changed");
  });

  it("renders nothing at all when there is no history", () => {
    const none = render({ scope: SCOPE, catalogue: CAT, priorSetup: [] });
    expect(none).not.toContain('data-testid="machine-prior-setup"');
  });
});

// ---------------------------------------------------------------------------
// A HISTORICAL SETUP MUST STILL CARRY ITS UNIT.
//
// `named` is deliberately undefined whenever today's catalogue must not speak
// for an old reading - a different contract version, or a profile that has
// left the catalogue entirely. Suppressing the LABEL there is correct.
// Suppressing the UNIT with it was not: guidance rendered as a bare "120",
// which defeats the entire reason a reading stores its own native unit
// (Codex, 7cae831b).
//
// The repair then still PREFERRED today's unit whenever the version matched,
// which is the same defect one step quieter - the published database contract
// is immutable per version, but the application catalogue is a source file
// whose unit can be edited without a version bump, and nothing enforces
// agreement between the two for one version number. The component now holds no
// current unit metadata at all, so it cannot print one (Codex, 87c88017).
// ---------------------------------------------------------------------------
describe("an obsolete setup is rendered from the RECORDING, never from today's catalogue", () => {
  const reading = (over: Record<string, unknown> = {}) => ({
    blockId: "b1",
    profileId: "fixture:panel",
    profileVersion: 1,
    modeKey: "galvanic",
    groupKey: "g1",
    channels: [],
    stageKey: null,
    fieldKey: "current",
    value: { kind: "value", value: 120 },
    nativeUnit: "µA",
    decimals: 0,
    recordedAt: "2026-09-20T15:04:00Z",
    ...over,
  });

  const unitOf = (html: string): string | null => {
    // The unit is the span immediately after the value, so read it positionally
    // rather than asking whether the string appears anywhere on the page - the
    // entry form above also renders units, and a page-wide `toContain` would
    // pass on those while the history showed a bare number.
    const prior = html.slice(html.indexOf('data-testid="machine-prior-setup"'));
    const m = /120<\/span>(?:<!--[^>]*-->)?<span[^>]*>([^<]*)<\/span>/.exec(prior);
    return m ? m[1]! : null;
  };

  it("CONTROL: the unit is read from the history block, not from the page", () => {
    // Guards the reader above. Without a history block there is no unit to
    // find, so a passing assertion below cannot be coming from the entry form.
    const none = render({ scope: SCOPE, catalogue: CAT, priorSetup: [] });
    expect(unitOf(none)).toBeNull();
  });

  it("a CURRENT-version setup shows the recorded unit", () => {
    const html = render({ scope: SCOPE, catalogue: CAT, priorSetup: [reading()] });
    expect(unitOf(html)).toBe("µA");
  });

  it("an OLDER contract version still shows the recorded unit", () => {
    const html = render({
      scope: SCOPE,
      catalogue: CAT,
      priorSetup: [reading({ profileVersion: 99 })],
    });
    expect(html).toContain("field contract has changed");
    expect(unitOf(html), "a bare 120 is the defect").toBe("µA");
    // And still the recorded key rather than today's label.
    expect(html).toContain("current");
  });

  it("a profile REMOVED from the catalogue still shows the recorded unit", () => {
    // Nothing in today's catalogue describes this reading at all - not the
    // machine name, not the mode, not the field. The unit survives because it
    // came from the reading.
    const html = render({
      scope: SCOPE,
      catalogue: CAT,
      priorSetup: [reading({ profileId: "fixture:withdrawn" })],
    });
    expect(unitOf(html)).toBe("µA");
    expect(html, "the profile id stands in for a name it no longer has").toContain(
      "fixture:withdrawn",
    );
  });

  it("the unit comes from the READING even when the catalogue would say otherwise", () => {
    // The case no version check can catch: same version, but the catalogue's
    // unit has drifted from what was published and recorded. Today's opinion
    // must not be printed on an old measurement.
    const html = render({
      scope: SCOPE,
      catalogue: CAT,
      priorSetup: [reading({ nativeUnit: "mA" })],
    });
    expect(unitOf(html), "the catalogue says µA; the reading says mA").toBe("mA");
  });

  it("the recorded PRECISION is preserved too, not re-derived", () => {
    const html = render({
      scope: SCOPE,
      catalogue: CAT,
      priorSetup: [
        reading({ fieldKey: "duration", value: { kind: "value", value: 300.5 }, decimals: 1, nativeUnit: "s" }),
      ],
    });
    const prior = html.slice(html.indexOf('data-testid="machine-prior-setup"'));
    expect(prior).toContain("300.5");
  });
});

// ---------------------------------------------------------------------------
// A STORED-BUT-UNUSABLE MACHINE IS EXPLAINED, not silently dropped.
//
// The loader used to forward the stored device id whatever its state, and
// `selectableDevices` then correctly excluded it - so the panel rendered an
// empty picker while the status line still said a machine was remembered, and
// the reason `resolveSelection` had already produced was never shown
// (Codex, 1a39a51f).
// ---------------------------------------------------------------------------
describe("a stored machine that cannot be used says so", () => {
  const WHY =
    "Room 1 demo was taken out of service. Choose a replacement — nothing is selected for you.";
  // DATABASE_PERSISTENCE deliberately: with NO_PERSISTENCE the status line
  // takes its "no. <reason>" branch and never prints "nothing yet" at all, so
  // the assertions below would hold whatever the component did. The control at
  // the end of this block is what caught that.
  const html = render({
    scope: SCOPE,
    devices: [DEVICE],
    catalogue: CAT,
    persistence: DATABASE_PERSISTENCE,
    unavailableSelection: { deviceId: "device-gone", reason: WHY },
  });

  it("states the reason", () => {
    expect(html).toContain('data-testid="machine-selection-not-remembered"');
    expect(html).toContain("taken out of service");
  });

  it("shows NOTHING as chosen, because nothing may be charted on it", () => {
    expect(html).not.toContain('data-testid="machine-chosen"');
  });

  it("still offers the picker, so a replacement can be chosen", () => {
    expect(html).toContain(`machine-pick-${DEVICE.deviceId}`);
  });

  it("does not claim nothing is remembered, because something is", () => {
    // The database does hold the unusable machine. Reporting "nothing yet"
    // here would be the failed-clear lie in a new costume.
    const status = html.slice(html.indexOf('data-testid="machine-first-status"'));
    expect(status).not.toContain("nothing yet");
  });

  it("CONTROL: without it, the panel neither explains nor warns", () => {
    const plain = render({
      scope: SCOPE,
      devices: [DEVICE],
      catalogue: CAT,
      persistence: DATABASE_PERSISTENCE,
    });
    expect(plain).not.toContain('data-testid="machine-selection-not-remembered"');
    expect(plain).toContain("nothing yet");
  });
});
