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
const { MachineFirstSetupPanel, withheld } = await import(
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

describe("the withheld-model catalogue is NOT in the treatment form", () => {
  // THESE FOUR ASSERTIONS ARE INVERTED, NOT DELETED, and the inversion is the
  // product decision rather than a loosening.
  //
  // They required the charting form to list every unverified model with its
  // full evidence reason - firmware conflicts, unread operating screens, a
  // manual returning 403 - eleven entries deep. The reasoning was sound as
  // far as it went: a picker that silently omits a studio's machine is worse
  // than one that says why. But on a charting form, mid-treatment, it put a
  // wall of procurement detail between the practitioner and the fields she
  // was filling in, and Sam's screenshot said exactly that ("this looks
  // weird ... is this all prepopulated").
  //
  // The information is not lost: `withheld(catalogue)` still computes it from
  // the same contract and is exported for an owner or support
  // machine-readiness surface, where somebody is actually deciding what to
  // register. What charting needs is a concise reason and a next action
  // (#860 6156583955).
  const html = render({ scope: SCOPE, devices: [], catalogue: MACHINE_CATALOGUE });

  it("names no withheld model", () => {
    for (const name of ["Dectro", "Silhouet-Tone", "Permanence"]) {
      expect(html, `${name} is procurement detail, not charting`).not.toContain(name);
    }
  });

  it("carries no evidence reason or implementation status", () => {
    for (const phrase of [
      "Not yet selectable",
      "firmware",
      "operating-screen",
      "403",
      "historical records only",
    ]) {
      expect(html).not.toContain(phrase);
    }
  });

  it("says concisely that nothing is available, instead", () => {
    // The replacement has to actually be there, or this is a deletion dressed
    // up as a decision.
    expect(html).toContain('data-testid="machine-select"');
    expect(html).toMatch(/no verified machine|not available|no machine/i);
  });

  it("keeps the detail available to a readiness surface", () => {
    // The seam, asserted so the data cannot be quietly dropped later: the
    // computation is still exported and still returns the withheld models with
    // their reasons.
    const list = withheld(MACHINE_CATALOGUE);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]!.reason.length).toBeGreaterThan(0);
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
    // The prompt moved with the control: the pill row and its "before
    // entering settings" copy are gone, because the dropdown is always
    // visible and the settings now appear in the same form rather than after
    // it.
    expect(html).toContain('data-testid="machine-select"');
    expect(html).toContain("Choose the machine you are working on");
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

  it("offers a visible way to change machine - the dropdown itself", () => {
    // THE LINK IS GONE ON PURPOSE. A separate "Change machine" control existed
    // because the pill picker DISAPPEARED once something was chosen, so there
    // had to be a way back. The dropdown is always visible, so switching is
    // choosing another option and clearing is choosing the empty one; a second
    // control would be a second way to do what this one already does
    // (Sam, 19:16; #860 6156583955).
    expect(html).toContain('data-testid="machine-select"');
    expect(html, "the link it replaced must not linger").not.toContain(
      "Change machine",
    );
    // The empty option is how a selection is cleared, so clearing stays
    // reachable after a choice.
    expect(html).toContain("Choose machine");
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

  it("collects no READING without somewhere to put it", () => {
    // THIS TEST'S ORIGINAL CLAIM EXPIRED, and its own comment said why without
    // anyone noticing: "there are no reading columns yet". 0223 created them.
    // It kept passing only because this fixture has no blockId, so no entry
    // surface rendered - an assertion that had quietly become about the
    // fixture rather than the component.
    //
    // The property that still matters is the original intent: a clinical form
    // must not accept numbers it would then discard. So the assertion is about
    // READING inputs specifically. A <select> for the machine is not a
    // reading - it chooses which contract governs the fields - and the
    // dropdown is now the product's primary control, so forbidding every
    // <select> would forbid the feature.
    expect(chosen, "no reading input without a block").not.toContain(
      'data-testid="reading-',
    );
    for (const tag of ["<textarea"]) {
      expect(chosen, `${tag} would imply free-text capture here`).not.toContain(tag);
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
    // `blockId` joined the argument list when the recorded-setup read was
    // folded into this SAME round trip. It is the same KIND of value as the
    // other two - which block is open is a route subject, not an authority
    // claim, and the server authorizes it - so the regex admits it rather than
    // this test demanding a shape that would force a SECOND server-action
    // POST, which is what broke repeat-client-fast-charting and
    // conditional-numbing-notes before.
    expect(code).toMatch(
      /loadMachineSetupContext\(\{\s*clientId,\s*sessionId,\s*blockId\s*\}\)/,
    );
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
    // READING inputs and a form of its own are what must be absent. The
    // machine <select> is present and is the point of the surface; see the
    // note on the sibling assertion above.
    expect(html).not.toContain('data-testid="reading-');
    for (const tag of ["<textarea", "<form"]) {
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

  it("keeps a machine-computed field TRANSCRIBABLE, while still labelling it", () => {
    // THIS TEST ASSERTED THE DEFECT. `Total` is device-computed on the
    // fixture, and this file used to require its input be `disabled` - "rather
    // than inviting a value the machine owns".
    //
    // That reading of `editable: false` was wrong. The flag means the
    // practitioner cannot change the value ON THE MACHINE; it says nothing
    // about whether the value can be CHARTED. Since nothing else populates
    // the field - there is no device integration - disabling the input made an
    // optional machine-derived reading impossible to record, and a required
    // one would have left `ready` false forever, blocking every save
    // (Codex, 15cc6c99).
    //
    // The distinction is preserved where it belongs: the field is still
    // LABELLED as machine-computed, and its submitted observation_source now
    // carries the contract's own value instead of claiming it was typed.
    const tags = html.match(/<input[^>]*>/g) ?? [];
    const computed = tags.find((t) => t.includes('data-testid="reading-computed"'));
    expect(computed, "no input was rendered for the computed field").toBeTruthy();
    expect(computed, "a machine-derived reading must still be enterable").not.toContain(
      "disabled",
    );
    const current = tags.find((t) => t.includes('data-testid="reading-current"'));
    expect(current).not.toContain("disabled");
    // AND IT IS STILL DISTINGUISHED, which is the half that must not be lost.
    //
    // Removing `disabled` removed the entry surface's ONLY signal - the
    // "shown by the machine" wording lived solely in the panel's read-only
    // list. The entry form now carries it too, so allowing the value to be
    // charted did not quietly erase the fact that the machine owns it.
    expect(html).toContain('data-testid="field-machine-shown-computed"');
    expect(html).toContain("shown by the machine");
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
    // "PREVIOUS TREATMENT", in Sam's words, replacing "Last recorded setup".
    // The rename is the product point rather than wording: Sam's screenshot
    // asked "is this all prepopulated", which is what a reader asks when past
    // values sit in the same visual register as the fields to be filled in.
    expect(html).toContain("Previous treatment");
    expect(html, "the old label must not linger").not.toContain(
      "Last recorded setup",
    );
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
    // The dropdown, not a pill: a replacement is chosen by selecting another
    // option in the control that is always on screen.
    expect(html).toContain('data-testid="machine-select"');
    expect(html).toContain(`value="${DEVICE.deviceId}"`);
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

// ---------------------------------------------------------------------------
// THE PHYSICAL UNIT IS NAMED in next-visit guidance.
//
// The retrieved setup dropped `studio_machine_id`, so the heading showed only
// the manufacturer and model. A studio with two units of the same model -
// which is the ordinary case the studio_machines table exists for - could not
// tell whether the setup to reproduce was Room 1's or Room 2's
// (Codex, d3e8b17b).
// ---------------------------------------------------------------------------
describe("next-visit guidance names the unit, not just the model", () => {
  const reading = (over: Record<string, unknown> = {}) => ({
    blockId: "b1",
    deviceId: DEVICE.deviceId,
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

  it("shows the studio's own name for the recorded unit", () => {
    const html = render({
      scope: SCOPE,
      devices: [DEVICE],
      catalogue: CAT,
      priorSetup: [reading()],
      unitNames: { [DEVICE.deviceId]: "Room 9 unit" },
    });
    expect(html).toContain('data-testid="prior-setup-unit"');
    const prior = html.slice(html.indexOf('data-testid="machine-prior-setup"'));
    expect(prior).toContain("Room 9 unit");
    // The model still qualifies it - the unit name alone does not say what it is.
    expect(prior).toContain("Fixture Panel");
  });

  it("CONTROL: with no name resolved, the model stands alone", () => {
    // Guards the assertion above: without this, "contains the display name"
    // could be satisfied by the picker elsewhere on the page.
    const html = render({
      scope: SCOPE,
      devices: [DEVICE],
      catalogue: CAT,
      priorSetup: [reading()],
    });
    const prior = html.slice(html.indexOf('data-testid="machine-prior-setup"'));
    expect(prior).not.toContain('data-testid="prior-setup-unit"');
    expect(prior).toContain("Fixture Panel");
  });

  it("NEVER renders a bare unit id, which is noise to a practitioner", () => {
    // An unresolvable unit must not leak its uuid into the heading.
    const html = render({
      scope: SCOPE,
      devices: [DEVICE],
      catalogue: CAT,
      priorSetup: [reading({ deviceId: "device-no-longer-listed" })],
      unitNames: { [DEVICE.deviceId]: "Room 9 unit" },
    });
    const prior = html.slice(html.indexOf('data-testid="machine-prior-setup"'));
    expect(prior).not.toContain("device-no-longer-listed");
    expect(prior).toContain("Fixture Panel");
  });

  it("a name resolved for a RETIRED unit renders like any other", () => {
    // THE RETIRED CASE IS NOT PROVABLE HERE, and the previous version of this
    // test pretended otherwise: it put a retired device into the `devices`
    // prop and asserted the name appeared. In production `devices` comes from
    // `listStudioMachines`, which excludes retired units in SQL, so that state
    // could never occur - the fixture was creating something the loader cannot
    // produce, which is the definition of a vacuous proof (Codex, 27061e88).
    //
    // What this file CAN prove is that the component does not care: a name is
    // a name. That the name is actually RESOLVABLE for a retired unit is a
    // database fact, proved in tests/db/machine-workflow-end-to-end against
    // real SQL with the unit genuinely retired.
    const html = render({
      scope: SCOPE,
      devices: [], // retired units are absent from the picker, as in production
      catalogue: CAT,
      priorSetup: [reading()],
      unitNames: { [DEVICE.deviceId]: "Room 9 unit" },
    });
    const prior = html.slice(html.indexOf('data-testid="machine-prior-setup"'));
    expect(prior).toContain("Room 9 unit");
  });
});

// ---------------------------------------------------------------------------
// EVERY CONTEXT FIELD REACHES THE PANEL.
//
// This is the gap that twice let a feature be inert in production while its
// tests passed. `priorUnitNames` was added to the loader, to the panel's props
// and to the panel's own forwarding - and never to the connected wrapper that
// builds those props in the real route. The panel therefore always received
// its default empty map, so no historical unit was ever named, while the
// render tests above passed because they pass the prop themselves. A test that
// supplies a prop directly cannot see a missing wire (Codex, 2351742d).
//
// THE FIELD LIST IS DERIVED FROM THE TYPE, not written out here. A hardcoded
// list would need maintaining in exactly the moment it is most likely to be
// forgotten - when a new field is added - which is the failure this guards
// against. Adding a field to MachineSetupContext now fails this test until the
// wrapper forwards it.
//
// It reads source text, so comments are stripped first: prose mentioning
// `ctx.priorUnitNames` would otherwise satisfy a guard about code, which has
// caught this lane four times.
// ---------------------------------------------------------------------------
describe("the connected wrapper forwards the whole context", () => {
  const stripComments = (text: string): string =>
    text
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

  const CONNECTED = stripComments(
    readFileSync(
      nodePath.resolve(
        __dirname,
        "../../components/machines/machine-first-setup-connected.tsx",
      ),
      "utf8",
    ),
  );

  const ACTIONS = readFileSync(
    nodePath.resolve(
      __dirname,
      "../../app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts",
    ),
    "utf8",
  );

  /** The context's own top-level field names, read off its declaration. */
  const contextFields = (): string[] => {
    const block = /export type MachineSetupContext = \{([\s\S]*?)\n\};/.exec(ACTIONS);
    expect(block, "MachineSetupContext's declaration must be findable").not.toBeNull();
    return stripComments(block![1]!)
      .split("\n")
      // Top-level members only: exactly two spaces of indent. Nested object
      // types sit on one line each, so they cannot be mistaken for members.
      .map((l) => /^ {2}(\w+)\??:/.exec(l)?.[1])
      .filter((n): n is string => Boolean(n));
  };

  it("finds the context's fields, so the assertion below is not vacuous", () => {
    const fields = contextFields();
    // A sanity floor AND a couple of known members: if the regex ever stops
    // matching, this fails here rather than passing an empty loop below.
    expect(fields.length).toBeGreaterThanOrEqual(8);
    expect(fields).toContain("priorSetup");
    // RENAMED from `priorUnitNames` when the recorded-setup surface landed:
    // one lookup now names the units of BOTH reads plus the unusable stored
    // selection, so a name tied to the prior setup alone was misleading.
    expect(fields).toContain("unitNames");
    // WHAT IS ALREADY RECORDED against the block being charted. The field
    // exists because a recorded capture was permanent and INVISIBLE - both
    // reads were built, granted and proved against Postgres, and neither ever
    // reached a screen.
    expect(fields).toContain("recordedSetup");
    expect(fields).toContain("persistence");
  });

  it("forwards every one of them", () => {
    const missing = contextFields().filter(
      (f) => !new RegExp(`ctx\\.${f}\\b`).test(CONNECTED),
    );
    expect(
      missing,
      `MachineSetupContext fields the wrapper never reads: ${missing.join(", ")}. ` +
        "A field the loader resolves but the wrapper drops makes the feature " +
        "inert in the real route while direct-render tests still pass.",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE MODE IS A CHOICE, and the field contract depends on it.
//
// The panel always took `activeModes(profile)[0]`, so for any profile with
// more than one active mode it rendered - and recorded against - the WRONG
// field contract. The loader had resolved the practitioner's remembered mode
// all along and the wrapper never forwarded it (Codex, 15cc6c99).
// ---------------------------------------------------------------------------
describe("choosing the mode on a multi-mode machine", () => {
  /** A synthetic profile with TWO active modes, which is the whole point. */
  const TWO_MODE: MachineProfile = {
    ...SYNTHETIC,
    profileId: "fixture:two-mode",
    modes: [
      SYNTHETIC.modes[0]!,
      {
        ...SYNTHETIC.modes[0]!,
        key: "blend",
        nativeLabel: "Blend",
        fields: [
          {
            ...SYNTHETIC.modes[0]!.fields[0]!,
            key: "blend_current",
            nativeLabel: "Blend current",
          },
        ],
      },
    ],
  };
  const TWO_MODE_CAT = [TWO_MODE];
  const DEV: StudioDevice = { ...DEVICE, profileId: "fixture:two-mode" };

  it("offers a picker when the machine has more than one active mode", () => {
    const html = render({
      scope: SCOPE,
      devices: [DEV],
      catalogue: TWO_MODE_CAT,
      initialDeviceId: DEV.deviceId,
    });
    expect(html).toContain('data-testid="machine-mode-picker"');
    expect(html).toContain('data-testid="machine-mode-galvanic"');
    expect(html).toContain('data-testid="machine-mode-blend"');
  });

  it("CONTROL: offers NO picker when there is only one mode to choose", () => {
    // Without this, "renders a picker" could be true unconditionally, and a
    // control on a single-mode machine is the cheapest way to know.
    const html = render({
      scope: SCOPE,
      devices: [DEVICE],
      catalogue: CAT,
      initialDeviceId: DEVICE.deviceId,
    });
    expect(html).not.toContain('data-testid="machine-mode-picker"');
  });

  it("honours the REMEMBERED mode rather than the profile's first", () => {
    // The defect in one assertion: this used to render Galvanic's contract
    // whatever had been remembered.
    const html = render({
      scope: SCOPE,
      devices: [DEV],
      catalogue: TWO_MODE_CAT,
      initialDeviceId: DEV.deviceId,
      initialModeKey: "blend",
      blockId: "block-1",
    });
    // The second mode's field, which only its contract declares.
    expect(html).toContain("Blend current");
    expect(html).toContain('aria-pressed="true"');
  });

  it("falls back to the first mode when the remembered one is not this machine's", () => {
    // A remembered mode can outlive the machine it was chosen on, and a key
    // means nothing outside the profile that declares it. Falling back beats
    // blanking the panel.
    const html = render({
      scope: SCOPE,
      devices: [DEV],
      catalogue: TWO_MODE_CAT,
      initialDeviceId: DEV.deviceId,
      initialModeKey: "a-mode-from-another-profile",
      blockId: "block-1",
    });
    expect(html).toContain('data-testid="machine-chosen"');
    // GALVANIC's field contract, not Blend's - the first active mode. Asserted
    // on the read-only field list, because the entry surface renders only when
    // `onRecord` is wired and this render does not wire it.
    expect(html).toContain("Current");
    expect(html, "Blend's contract must not be rendered here").not.toContain(
      "Blend current",
    );
  });
});

// ---------------------------------------------------------------------------
// A MODE IS ONLY OFFERED IF THIS PHYSICAL UNIT CAN RUN IT.
//
// `activeModes` answers what the MODEL offers. An option is fitted to a UNIT,
// so a mode gated on `requiresInstalledOption` was offered by the picker,
// refused by `selectDevice` when persisting, left optimistically selected
// anyway, and then refused again by `recordReadingsAction` after the
// practitioner had filled the form (Codex, ebc69ff6).
// ---------------------------------------------------------------------------
describe("the mode picker is built from the device, not the model", () => {
  const GATED: MachineProfile = {
    ...SYNTHETIC,
    profileId: "fixture:gated",
    modes: [
      SYNTHETIC.modes[0]!,
      {
        ...SYNTHETIC.modes[0]!,
        key: "adjunct",
        nativeLabel: "Adjunct",
        requiresInstalledOption: "adjunct-head",
        fields: [
          { ...SYNTHETIC.modes[0]!.fields[0]!, key: "current", nativeLabel: "Adjunct current" },
        ],
      },
    ],
  };
  const CAT_GATED = [GATED];
  const base: StudioDevice = { ...DEVICE, profileId: "fixture:gated" };
  const without: StudioDevice = { ...base, installedOptions: [] };
  const withOption: StudioDevice = { ...base, installedOptions: ["adjunct-head"] };

  it("does NOT offer a mode whose option this unit lacks", () => {
    const html = render({
      scope: SCOPE,
      devices: [without],
      catalogue: CAT_GATED,
      initialDeviceId: without.deviceId,
    });
    expect(html).not.toContain('data-testid="machine-mode-adjunct"');
    // One supported mode means no picker at all, which is the right outcome:
    // there is nothing to choose.
    expect(html).not.toContain('data-testid="machine-mode-picker"');
  });

  it("DOES offer it once the unit reports the option", () => {
    // The positive control. Without it the assertion above would be satisfied
    // by a picker that never renders the mode under any circumstances.
    const html = render({
      scope: SCOPE,
      devices: [withOption],
      catalogue: CAT_GATED,
      initialDeviceId: withOption.deviceId,
    });
    expect(html).toContain('data-testid="machine-mode-picker"');
    expect(html).toContain('data-testid="machine-mode-adjunct"');
  });

  it("does not SELECT an unsupported mode even when it is remembered", () => {
    // A remembered mode can outlive the option being removed from the unit.
    // Falling back to a supported one beats rendering a contract the capture
    // will be refused against.
    const html = render({
      scope: SCOPE,
      devices: [without],
      catalogue: CAT_GATED,
      initialDeviceId: without.deviceId,
      initialModeKey: "adjunct",
      blockId: "block-1",
    });
    expect(html).toContain('data-testid="machine-chosen"');
    // Galvanic's own label, not the adjunct mode's.
    expect(html).not.toContain("Adjunct current");
  });
});

// ---------------------------------------------------------------------------
// THE TOUCH FLOOR IS THE PRIMITIVE'S, not re-derived at the call site.
// ---------------------------------------------------------------------------
describe("mode and device controls meet DESIGN.md's interaction floor", () => {
  const TWO: MachineProfile = {
    ...SYNTHETIC,
    profileId: "fixture:floor",
    modes: [
      SYNTHETIC.modes[0]!,
      { ...SYNTHETIC.modes[0]!, key: "second", nativeLabel: "Second" },
    ],
  };
  const DEV: StudioDevice = { ...DEVICE, profileId: "fixture:floor" };
  // TWO RENDERS, because the two controls never appear together: the picker
  // shows only while nothing is chosen, and the mode controls only once
  // something is. A single render asserting both would have had to pass
  // whichever state it was in.
  const chosenHtml = render({
    scope: SCOPE,
    devices: [DEV],
    catalogue: [TWO],
    initialDeviceId: DEV.deviceId,
  });
  const pickingHtml = render({ scope: SCOPE, devices: [DEV], catalogue: [TWO] });

  const tagFrom = (html: string, testid: string): string => {
    const tags = html.match(/<button[^>]*>/g) ?? [];
    const found = tags.find((t) => t.includes(`data-testid="${testid}"`));
    expect(found, `no button rendered for ${testid}`).toBeTruthy();
    return found!;
  };
  const tagFor = (testid: string): string => tagFrom(chosenHtml, testid);

  it("the mode control carries the 44px floor", () => {
    // My first version was `text-xs py-1.5` with no minimum height - about
    // 28px on a thumb.
    expect(tagFor("machine-mode-second")).toContain("min-h-[44px]");
  });

  it("and relaxes only behind the explicit pointer-fine opt-in", () => {
    // Not a width breakpoint: an iPad in portrait is 768px wide and still a
    // thumb, which is why the repository gates this on the pointer itself.
    expect(tagFor("machine-mode-second")).toContain("pointer-fine:min-h-8");
  });

  it("the DEVICE control carries it too - now as the dropdown", () => {
    // This asserted the pill row's height, which was ~36px and under the
    // floor. The pills are gone; the control is a <select> built from
    // `fieldControlClass`, which carries the floor, the 16px type that stops
    // iOS zooming on focus, and the focus ring. Asserted on the select rather
    // than deleted, because the LAW is what the test was for, not the pill.
    const tag = (pickingHtml.match(/<select[^>]*>/g) ?? []).find((t) =>
      t.includes('data-testid="machine-select"'),
    );
    expect(tag, "no machine dropdown was rendered").toBeTruthy();
    expect(tag).toContain("min-h-[44px]");
    expect(tag).toContain("text-base");
  });

  it("the shared focus treatment comes with them", () => {
    // The reason to use the primitive rather than copy its height: the floor
    // is one of several rules it carries, and a call site that re-derives the
    // height will not re-derive the rest.
    expect(tagFor("machine-mode-second")).toContain("focus-visible:");
  });
});

// ---------------------------------------------------------------------------
// DISTINCT SETTING GROUPS, in the mounted surface.
//
// The entry form hard-coded group `g1` with no channels while the schema, the
// command and both read paths supported several groups with channel
// associations, so probes at different settings could only be stored as one
// apparently global setup (Codex, 15cc6c99; narrow implementation approved
// 2026-10-13).
//
// EVERY GATE HERE IS THE CONTRACT'S. The channel identities are 1..count, the
// add control appears only when the model declares `supportsDistinctSettingGroups`,
// and a group without channels is never widened to "all".
// ---------------------------------------------------------------------------
describe("setting groups in the entry surface", () => {
  const withChannels = (over: Record<string, unknown> = {}): MachineProfile => ({
    ...SYNTHETIC,
    profileId: "fixture:chan",
    channels: {
      count: 4,
      nativeLabel: "Channel",
      associationRequired: false,
      supportsDistinctSettingGroups: true,
      verification: "device-confirmed",
      evidence: ["p"],
      ...over,
    },
  });
  const dev = (profileId: string): StudioDevice => ({ ...DEVICE, profileId });

  const entry = (profile: MachineProfile) =>
    render({
      scope: SCOPE,
      devices: [dev(profile.profileId)],
      initialDeviceId: DEVICE.deviceId,
      catalogue: [profile],
      blockId: "block-1",
      onRecord: async () => ({ ok: true }),
    });

  it("offers the contract's channel identities, and only those", () => {
    const html = entry(withChannels());
    for (const c of [1, 2, 3, 4]) {
      expect(html).toContain(`data-testid="setting-group-g1-channel-${c}"`);
    }
    expect(html, "channel 5 does not exist on this model").not.toContain(
      'data-testid="setting-group-g1-channel-5"',
    );
  });

  it("offers Add setting group when the model says probes can differ", () => {
    expect(entry(withChannels())).toContain('data-testid="setting-group-add"');
  });

  it("does NOT offer it when the model has channels but no distinct groups", () => {
    // The contract's own words: "a simple form must never label a per-probe
    // setting as a global control". The inverse holds too - a model that does
    // not support distinct groups must not be given the control.
    const html = entry(withChannels({ supportsDistinctSettingGroups: false }));
    expect(html).not.toContain('data-testid="setting-group-add"');
    // The channel association is still offered: knowing WHICH probe is a
    // separate question from whether probes can differ.
    expect(html).toContain('data-testid="setting-group-g1-channel-1"');
  });

  it("offers neither for a model with no channel structure", () => {
    const html = entry({ ...SYNTHETIC, profileId: "fixture:nochan", channels: undefined });
    expect(html).not.toContain('data-testid="setting-group-add"');
    expect(html).not.toContain("channel-1");
  });

  it("KEEPS THE SIMPLE PATH for a model with no channels", () => {
    // Codex's constraint, as an assertion: a profile without channels must
    // render exactly what it did before - one group, no group chrome, and the
    // unprefixed input ids every existing test and spec already use.
    const html = entry({ ...SYNTHETIC, profileId: "fixture:nochan2", channels: undefined });
    expect(html).toContain('data-testid="reading-current"');
    expect(html).not.toContain('data-testid="reading-g1-current"');
    expect(html, "no group heading for a single group").not.toContain(
      "Setting group 1",
    );
  });

  it("says an unassociated group records NO association, not every probe", () => {
    // The one interpretation this surface must never make. `associationRequired`
    // is false by a recorded practitioner ruling, so saving without naming
    // probes is legal - and it means the association is unknown, which is a
    // weaker claim than "all of them".
    const html = entry(withChannels());
    expect(html).toContain('data-testid="setting-group-g1-no-channels"');
    expect(html).toContain("not as every");
  });

  it("the channel controls carry the shared touch floor", () => {
    const html = entry(withChannels());
    const tags = html.match(/<button[^>]*>/g) ?? [];
    const chan = tags.find((t) =>
      t.includes('data-testid="setting-group-g1-channel-2"'),
    );
    expect(chan).toBeTruthy();
    expect(chan).toContain("min-h-[44px]");
  });

  it("the reading input carries it too, and does not shrink its type", () => {
    // DESIGN.md LAW 5: density comes from the box, not the type size. A 16px
    // input is also what stops iOS zooming the page on focus.
    const html = entry(withChannels());
    const inputs = html.match(/<input[^>]*>/g) ?? [];
    const current = inputs.find((t) => t.includes('data-testid="reading-current"'));
    expect(current).toBeTruthy();
    expect(current).toContain("min-h-[44px]");
    expect(current).toContain("text-base");
  });
});

// ---------------------------------------------------------------------------
// THE MACHINE DROPDOWN's own contract.
//
// Sam's correction, 19:16: "it should be a dropdown to select the machine then
// each machine's settings show up so we can do live charting"
// (#860 6156583955).
// ---------------------------------------------------------------------------
describe("the machine dropdown", () => {
  const SECOND: StudioDevice = {
    ...DEVICE,
    deviceId: "room-3",
    displayName: "Room 3 unit",
  };

  it("is ALWAYS VISIBLE, with nothing chosen and with something chosen", () => {
    // The pills it replaced vanished once a machine was chosen, which is why a
    // separate "Change machine" link had to exist. An always-present control
    // is the whole point.
    const empty = render({ scope: SCOPE, devices: [DEVICE], catalogue: CAT });
    const picked = render({
      scope: SCOPE,
      devices: [DEVICE],
      catalogue: CAT,
      initialDeviceId: DEVICE.deviceId,
    });
    expect(empty).toContain('data-testid="machine-select"');
    expect(picked).toContain('data-testid="machine-select"');
  });

  it("is LABELLED, not a bare control", () => {
    const html = render({ scope: SCOPE, devices: [DEVICE], catalogue: CAT });
    expect(html).toContain("Machine");
  });

  it("names the UNIT first and the model second", () => {
    // A studio names its rooms, and two rooms can hold the same model - so the
    // studio's own name is the identifying part and the model qualifies it.
    const html = render({ scope: SCOPE, devices: [DEVICE], catalogue: CAT });
    const select = html.slice(html.indexOf('data-testid="machine-select"'));
    const option = select.slice(select.indexOf("<option value=\"room-9\""));
    const text = option.slice(0, option.indexOf("</option>"));
    expect(text).toContain("Room 9 unit");
    expect(text).toContain("Fixture Panel");
    expect(
      text.indexOf("Room 9 unit"),
      "the unit name comes first",
    ).toBeLessThan(text.indexOf("Fixture Panel"));
  });

  it("lists every usable unit, so a studio with two can choose", () => {
    const html = render({
      scope: SCOPE,
      devices: [DEVICE, SECOND],
      catalogue: CAT,
    });
    expect(html).toContain('value="room-9"');
    expect(html).toContain('value="room-3"');
  });

  it("EXCLUDES a retired unit, which selectableDevices already filters", () => {
    // Asserted here rather than trusted: the dropdown is a new consumer of
    // that filter, and a dropdown built from the raw device list would offer a
    // unit the command then refuses.
    const retired: StudioDevice = { ...SECOND, retiredAt: "2026-10-01T00:00:00Z" };
    const html = render({
      scope: SCOPE,
      devices: [DEVICE, retired],
      catalogue: CAT,
    });
    expect(html).toContain('value="room-9"');
    expect(html, "a retired unit must not be offered").not.toContain('value="room-3"');
  });

  it("initialises from the REMEMBERED unit when it is still usable", () => {
    const html = render({
      scope: SCOPE,
      devices: [DEVICE, SECOND],
      catalogue: CAT,
      initialDeviceId: SECOND.deviceId,
    });
    // React renders the selected option's `selected` attribute on the server.
    const select = html.slice(
      html.indexOf('data-testid="machine-select"') - 400,
      html.indexOf("</select>"),
    );
    expect(select).toMatch(/room-3/);
  });

  it("offers the explicit empty state, which is also how a choice is cleared", () => {
    const html = render({
      scope: SCOPE,
      devices: [DEVICE],
      catalogue: CAT,
      initialDeviceId: DEVICE.deviceId,
    });
    expect(html).toContain('<option value="">');
    expect(html).toContain("Choose machine");
  });

  it("is DISABLED with a reason when the studio has nothing usable", () => {
    // Not an empty dropdown with no explanation: emptiness has two causes and
    // the practitioner needs the right one.
    const html = render({
      scope: SCOPE,
      devices: [],
      catalogue: CAT,
      inventoryReason: "This studio has no machine registered yet.",
    });
    expect(html).toContain("disabled");
    expect(html).toContain("no machine registered yet");
  });

  it("uses the SHARED control classes, so the touch floor is not re-derived", () => {
    // fieldControlClass carries the 44px floor, the 16px type that stops iOS
    // zooming on focus, and the focus ring. The pills it replaced were
    // hand-rolled at about 36px, under DESIGN.md LAW 6.
    const html = render({ scope: SCOPE, devices: [DEVICE], catalogue: CAT });
    const tag = (html.match(/<select[^>]*>/g) ?? []).find((t) =>
      t.includes('data-testid="machine-select"'),
    );
    expect(tag).toBeTruthy();
    expect(tag).toContain("min-h-[44px]");
    expect(tag).toContain("text-base");
    expect(tag).toContain("focus-visible:");
  });

  it("renders no dropdown at all without identity, rather than an empty one", () => {
    // Without a scope the panel cannot know which studio's units to list, and
    // guessing is what the server-derived identity exists to prevent.
    const html = render({ devices: [DEVICE], catalogue: CAT });
    expect(html).not.toContain('data-testid="machine-select"');
  });
});

// ---------------------------------------------------------------------------
// PREVIOUS TREATMENT is a REFERENCE, and has to read as one.
//
// Sam's screenshot asked "is this all prepopulated". Nothing ever was - the
// entry draft starts empty and the setting-groups suite proves a new capture
// begins blank - but it READ as prepopulated, because past values sat in the
// same visual register as the fields about to be filled in. Queue item 2 of
// #860 6156583955: "Prior treatment setup is a small clearly labelled
// Previous treatment reference. Its values are seeded history, not today's
// entries."
// ---------------------------------------------------------------------------
describe("the Previous treatment reference", () => {
  const prior = [
    {
      blockId: "b1",
      deviceId: DEVICE.deviceId,
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
    },
  ];

  const html = render({
    scope: SCOPE,
    devices: [DEVICE],
    catalogue: CAT,
    priorSetup: prior,
    unitNames: { [DEVICE.deviceId]: "Room 9 unit" },
  });

  it("is labelled as PREVIOUS, not as a current reading", () => {
    expect(html).toContain("Previous treatment");
  });

  it("says in words that these are not today's entries", () => {
    // The line that actually answers the question Sam asked.
    expect(html).toContain('data-testid="prior-setup-reference-note"');
    // The apostrophe is asserted AROUND rather than through: the source writes
    // &apos; and renderToStaticMarkup emits &#x27;, which is the renderer's
    // choice and not the product's claim. Pinning one encoding makes the test
    // fail on a React upgrade that picks another.
    expect(html).toMatch(/not today/);
    expect(html).toMatch(/s entries/);
    expect(html).toMatch(/reference only/i);
  });

  it("is DATED, so it cannot be mistaken for this visit", () => {
    // A date is the cheapest unambiguous signal that this is a past event.
    expect(html).toContain('data-testid="prior-setup-when"');
    expect(html).toMatch(/2026/);
  });

  it("shows the DATE only, not a time of day", () => {
    // Deliberate: a clock time invites reading the row set as "the settings at
    // that instant", and with several groups these rows can carry different
    // instants. Codex's decision is explicit that independently timed
    // revisions must not be presented as one moment (#860 6157725545).
    const when = html.slice(html.indexOf('data-testid="prior-setup-when"'));
    const text = when.slice(when.indexOf(">") + 1, when.indexOf("</span>"));
    expect(text).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("does NOT pre-fill today's entry fields from it", () => {
    // The property Sam's question was really about. A value she has not
    // re-read off the machine is not a reading, and the record must not be
    // able to acquire one by her failing to notice a filled box.
    const withEntry = render({
      scope: SCOPE,
      devices: [DEVICE],
      catalogue: CAT,
      initialDeviceId: DEVICE.deviceId,
      blockId: "block-1",
      onRecord: async () => ({ ok: true }),
      priorSetup: prior,
      unitNames: { [DEVICE.deviceId]: "Room 9 unit" },
    });
    const input = (withEntry.match(/<input[^>]*>/g) ?? []).find((t) =>
      t.includes('data-testid="reading-current"'),
    );
    expect(input, "no entry input was rendered").toBeTruthy();
    expect(input, "today's field must start empty").toMatch(/value=""|(?!.*value=)/);
    expect(input, "the previous 120 must not be pre-filled").not.toContain(
      'value="120"',
    );
  });

  it("renders nothing at all when there is no history", () => {
    const none = render({ scope: SCOPE, devices: [DEVICE], catalogue: CAT });
    expect(none).not.toContain('data-testid="machine-prior-setup"');
    expect(none).not.toContain("Previous treatment");
  });
});

// ---------------------------------------------------------------------------
// WHAT IS ALREADY RECORDED reaches the practitioner.
//
// A recorded capture was permanent and INVISIBLE: nothing in the application
// read what had already been recorded against the block being charted, so
// after a page load the only thing she saw was nothing, and her options were
// to re-record - appending a second immutable capture indistinguishable from
// a genuine mid-treatment change - or to guess.
//
// The surface itself is proved in tests/components/machine-recorded-setups.
// What is proved HERE is that the panel renders it at all, in the right place,
// and only when there is something to show - which is the part a direct test
// of the component cannot see.
// ---------------------------------------------------------------------------
describe("the panel shows what is already recorded on this block", () => {
  const recorded = [
    {
      blockId: "block-1",
      captureId: "cap-1",
      revision: 1,
      deviceId: DEVICE.deviceId,
      profileId: "fixture:panel",
      profileVersion: 1,
      modeKey: "galvanic",
      groupKey: "g1",
      channels: [],
      stageKey: null,
      fieldKey: "current",
      value: { kind: "value" as const, value: 120 },
      nativeUnit: "µA",
      decimals: 0,
      recordedAt: "2026-10-14T14:00:00Z",
    },
  ];

  it("renders the recorded surface when there is something recorded", () => {
    const html = render({
      scope: SCOPE,
      devices: [DEVICE],
      catalogue: CAT,
      recordedSetup: recorded,
      unitNames: { [DEVICE.deviceId]: "Room 9 unit" },
    });
    expect(html).toContain('data-testid="machine-recorded-setups"');
    expect(html).toContain("Recorded this treatment");
  });

  it("renders NOTHING of it when nothing is recorded", () => {
    // The default. A heading over no content reads as a surface that failed
    // to load, which is the opposite of the reassurance it exists to give.
    const html = render({ scope: SCOPE, devices: [DEVICE], catalogue: CAT });
    expect(html).not.toContain('data-testid="machine-recorded-setups"');
    expect(html).not.toContain("Recorded this treatment");
  });

  it("puts TODAY'S RECORD ABOVE last visit's reference", () => {
    // The order of the questions she actually asks. Putting today's record
    // below last visit's reference buries the one that stops a double
    // capture.
    const html = render({
      scope: SCOPE,
      devices: [DEVICE],
      catalogue: CAT,
      recordedSetup: recorded,
      priorSetup: recorded.map((r) => ({ ...r, blockId: "older-block" })),
      unitNames: { [DEVICE.deviceId]: "Room 9 unit" },
    });
    const recordedAt = html.indexOf('data-testid="machine-recorded-setups"');
    const priorAt = html.indexOf('data-testid="machine-prior-setup"');
    expect(recordedAt).toBeGreaterThan(-1);
    expect(priorAt).toBeGreaterThan(-1);
    expect(recordedAt, "today's record must come first").toBeLessThan(priorAt);
  });

  it("names the recorded unit from the SAME map that names the prior one", () => {
    // One server lookup feeds both, which is why the context field is called
    // `unitNames` and not `priorUnitNames` any more.
    const html = render({
      scope: SCOPE,
      devices: [DEVICE],
      catalogue: CAT,
      recordedSetup: recorded,
      unitNames: { [DEVICE.deviceId]: "Room 9 unit" },
    });
    const section = html.slice(
      html.indexOf('data-testid="machine-recorded-setups"'),
    );
    expect(section).toContain("Room 9 unit");
  });
});
