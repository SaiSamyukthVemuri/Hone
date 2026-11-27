// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// THE REAL MachineFirstSetupConnected, UNMOUNTED ALONE while a MultiPlex load is pending and the host form stays mounted. The mounted state-machine tests
// use a stand-in panel that reports its own presence, so they cannot see whether the REAL panel does: this one wraps the real component, so removing its
// presence cleanup fails here. The host must end the load in failed(panel_gone), refuse Save with the plain message, and a click on the pill must retry.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/clients/c1/sessions/s1",
}));
const ctxBox = vi.hoisted(() => ({ ctx: null as unknown }));
const actions = vi.hoisted(() => ({
  loadMachineSetupContext: vi.fn(async () => ctxBox.ctx),
  lookupAreaCreateClaimAction: vi.fn(async () => ({ ok: true, status: "absent" })),
  recordSetupSubmissionAction: vi.fn(async () => ({ ok: true })),
  readingsForBlockAction: vi.fn(async () => ({ ok: true, readings: [], unitNames: {} })),
  recordBlockMachineIdentityAction: vi.fn(async () => ({ ok: true })),
  rememberMachineSelectionAction: vi.fn(async () => ({ ok: true })),
  clearMachineSelectionAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions", () => actions);
const blockActions = vi.hoisted(() => ({ updateTreatmentAreaWithEntryAction: vi.fn(), createTreatmentAreaWithEntryAction: vi.fn() }));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions", () => blockActions);
const ctl = vi.hoisted(() => ({ hide: () => undefined as void, show: () => undefined as void }));
vi.mock("@/components/machines/machine-first-setup-connected", async () => {
  const actual = await vi.importActual<typeof import("@/components/machines/machine-first-setup-connected")>("@/components/machines/machine-first-setup-connected");
  const { createElement, useState } = await import("react");
  return {
    ...actual,
    // the REAL component, mounted and unmounted by the test while the host stays put
    MachineFirstSetupConnected: (props: Record<string, unknown>) => {
      const [hidden, setHidden] = useState(false);
      ctl.hide = () => setHidden(true);
      ctl.show = () => setHidden(false);
      return hidden ? null : createElement(actual.MachineFirstSetupConnected as never, props as never);
    },
  };
});

import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import type { StudioDevice } from "@/lib/machines/selection";
import { multiplexPill as multiplexPillOf, ensureThermolysis, chooseMultiplex, modeButton } from "./helpers/multiplex-modality";

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { BlockSetupForm } = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLACEHOLDER: StudioDevice = {
  deviceId: "unspecified:xcell-pur", studioId: "studio-synthetic", profileId: "dectro-apilus:xcell-pur", profileVersion: 1,
  displayName: "Machine not specified", installedOptions: [], retiredAt: null, isUnspecified: true,
};
const ZERO = () => ({
  scope: { studioId: "studio-synthetic", practitionerId: "pract-synthetic" }, devices: [PLACEHOLDER], inventoryReason: null, remembered: null, rememberedUnavailable: null,
  persistence: { kind: "database", persisted: true }, catalogue: MACHINE_CATALOGUE, canManageMachines: false, priorSetup: [], recordedSetup: [],
  priorSetupUnavailable: false, recordedSetupUnavailable: false, unitNames: {}, suggestedMachine: null, restoredSelection: null, clientLastMachine: null,
  legacyMachine: null, multiplexRoute: { deviceId: PLACEHOLDER.deviceId, modeKey: "multiplex", unspecified: true },
});

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = host = null; vi.clearAllMocks(); });

const pill = () => multiplexPillOf(host!);
const saveButton = () => host!.querySelector<HTMLButtonElement>('[data-testid="save-treatment-area"]')!;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("the REAL panel unmounted while a MultiPlex load is pending", () => {
  it("ends the load in failed (panel gone): Save refuses with the plain message and sends nothing, and the pill retries", async () => {
    ctxBox.ctx = ZERO();
    const create = blockActions.createTreatmentAreaWithEntryAction as unknown as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({ ok: true, blockId: "new-b1" });
    // the first load never answers: it is pending when the panel goes away
    actions.loadMachineSetupContext.mockImplementationOnce(() => new Promise(() => undefined) as never);
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () =>
      root!.render(createElement(BlockSetupForm, {
        sessionId: "s1", clientId: "c1", previousBlock: null, block: null, firstEntry: null, initialAreas: [{ area: "Upper lip", side: "center" }] as never,
        defaultMachineFrequency: null, onCancel: () => undefined, multiplexOffer: { deviceId: PLACEHOLDER.deviceId },
      } as never)),
    );
    await ensureThermolysis(host!); await act(async () => { pill()!.click(); });
    expect(saveButton().disabled, "held while the load is pending").toBe(true);

    await act(async () => { ctl.hide(); }); // the real panel unmounts; the host stays
    await flush();
    expect(saveButton().disabled, "the load that nobody is left to answer has ended").toBe(false);
    await act(async () => { saveButton().click(); });
    expect(create, "nothing is sent").not.toHaveBeenCalled();
    expect(host!.querySelector('[role="alert"]')?.textContent).toBe("MultiPlex could not be loaded, so nothing was saved. Pick MultiPlex again, or choose another mode.");

    // retry from the pill, with the real panel back
    await act(async () => { ctl.show(); });
    await ensureThermolysis(host!); await act(async () => { pill()!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(pill()!.getAttribute("aria-pressed")).toBe("true");
    expect(saveButton().disabled).toBe(false);
    await act(async () => { saveButton().click(); });
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(create.mock.calls[0])).toContain("multiplex");
  });
});
