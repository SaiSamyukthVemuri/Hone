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
const { NO_PERSISTENCE, TEST_STORE_PERSISTENCE } = await import(
  "@/lib/machines/selection-store"
);
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

describe("the connected wrapper's first paint is honest", () => {
  // renderToStaticMarkup runs no effect, so this IS the server paint a
  // practitioner sees before the identity round trip returns. It must state
  // the unscoped truth rather than imply a machine is coming.
  const html = renderToStaticMarkup(createElement(MachineFirstSetupConnected, {}));

  it("renders the panel, not a placeholder", () => {
    expect(html).toContain('data-testid="machine-first-panel"');
  });

  it("says it does not yet know who is charting", () => {
    expect(html).toContain("does not yet know which practitioner and studio is charting");
  });

  it("reports no persistence on the first paint", () => {
    expect(html).toContain('data-persistence="none"');
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
    // It calls the no-argument loader and invents no identity to pass.
    expect(code).toContain("loadMachineSetupContext()");
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
    // Choosing a machine is a UI default. It must not reach a treatment
    // record, which is why this module has no supabase client at all.
    for (const table of [
      "session_blocks",
      "electrolysis_entries",
      "laser_entries",
      "sessions",
      "clients",
    ]) {
      expect(code, `machine setup must not touch ${table}`).not.toContain(table);
    }
  });

  it("performs no write of its own beyond the selection store", () => {
    expect(code).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(code).not.toContain("createClient");
    expect(code).not.toContain("revalidatePath");
  });

  it("the panel renders no control that could edit a recorded value", () => {
    const html = render({
      scope: SCOPE,
      devices: [DEVICE],
      initialDeviceId: "room-9",
      catalogue: CAT,
    });
    for (const tag of ["<input", "<textarea", "<select", "<form"]) {
      expect(html).not.toContain(tag);
    }
  });
});
