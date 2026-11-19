// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import type { StudioDevice } from "@/lib/machines/selection";

// The CONNECTED layer's gate on the one-choice preselect: it hands the panel an `onlyChoice` only when nothing else would choose. The panel
// is stubbed so the PROP is what is asserted (the panel's own precedence is pinned in machine-panel-preselect.test.ts).
const seen = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("@/components/machines/machine-first-setup-panel", () => ({
  MachineFirstSetupPanel: (p: Record<string, unknown>) => {
    seen.props = p;
    return null;
  },
}));

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { MachineFirstSetupConnected } = await import("@/components/machines/machine-first-setup-connected");
const { ChartingViewContext } = await import("@/components/charting-view-context");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACTIVE = MACHINE_CATALOGUE.find((p) => p.profileId === "dectro-apilus:senior-3g" && p.availability === "active")!;
const UNIT: StudioDevice = { deviceId: "u1", studioId: "st", profileId: ACTIVE.profileId, profileVersion: ACTIVE.version, displayName: "Unit 1", installedOptions: [], retiredAt: null };
const ctx = (over: Record<string, unknown> = {}) => ({
  scope: { studioId: "st", practitionerId: "p" }, devices: [UNIT], inventoryReason: null, remembered: null, rememberedUnavailable: null,
  persistence: { kind: "database", persisted: true }, catalogue: MACHINE_CATALOGUE, canManageMachines: false, priorSetup: [], recordedSetup: [],
  priorSetupUnavailable: false, recordedSetupUnavailable: false, unitNames: {}, suggestedMachine: null, restoredSelection: null, clientLastMachine: null,
  legacyMachine: null, multiplexRoute: null, ...over,
});

let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); host = root = null; seen.props = null; });

async function only(over: { ctx?: Record<string, unknown>; props?: Record<string, unknown>; view?: "current" | "new" }) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const c = ctx(over.ctx);
  await act(async () =>
    root!.render(
      createElement(
        ChartingViewContext.Provider,
        { value: { view: over.view ?? "new", setView: () => undefined, notice: null } },
        createElement(MachineFirstSetupConnected, { clientId: "c1", sessionId: "s1", load: async () => c, ...(over.props ?? {}) } as never),
      ),
    ),
  );
  const open = host.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]');
  if (open) await act(async () => open.click());
  await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  expect(seen.props, "the panel mounted").not.toBeNull();
  return seen.props!.onlyChoice;
}

describe("the connected layer hands the panel a preselect only when nothing else would choose", () => {
  it("control: a new area in New view with one usable unit and nothing else chosen gets the unit", async () => {
    expect(await only({})).toEqual({ kind: "native", deviceId: "u1" });
  });
  it("Current view: never", async () => {
    expect(await only({ view: "current" })).toBeNull();
  });
  it("a held area (the practitioner already typed charting values): never", async () => {
    expect(await only({ props: { holdAutoSelect: true } })).toBeNull();
  });
  it("an area with a saved identity: never", async () => {
    expect(await only({ props: { savedIdentity: { profileId: null, deviceId: "u1", modeKey: null } } })).toBeNull();
  });
  it("an existing block (blockId present): never", async () => {
    expect(await only({ props: { blockId: "b1" } })).toBeNull();
  });
  it("the client's last machine: never", async () => {
    expect(await only({ ctx: { clientLastMachine: { deviceId: "u1", modeKey: null, legacy: false } } })).toBeNull();
  });
  it("a remembered machine: never", async () => {
    expect(await only({ ctx: { remembered: { deviceId: "u1", modeKey: null } } })).toBeNull();
  });
  it("no scope (an unidentified surface): never", async () => {
    expect(await only({ ctx: { scope: null } })).toBeNull();
  });
});
