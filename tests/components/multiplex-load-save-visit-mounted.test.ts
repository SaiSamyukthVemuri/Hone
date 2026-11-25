// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// SAVE VISIT while the first MultiPlex choice is still loading. The real form, the real connected panel, the real Save visit control, one held loader.
// Save visit runs the same `runSave` path as the button: while the load is pending it must send NO save request and say why; once it settles the area
// saves as MultiPlex, and a failed load refuses with the plain message and keeps the draft.
const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: nav.refresh }),
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

import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import type { StudioDevice } from "@/lib/machines/selection";

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { BlockSetupForm } = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form");
const { ChartingVisitSaveProvider, VisitSaveControl } = await import("@/components/charting-visit-save");
const { ChartingVisitDraftProvider } = await import("@/components/charting-visit-draft");
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
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = host = null; blockActions.createTreatmentAreaWithEntryAction.mockReset(); });

async function mount() {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(ChartingVisitDraftProvider, null,
        createElement(ChartingVisitSaveProvider, null,
          createElement(BlockSetupForm, {
            sessionId: "s1", clientId: "c1", previousBlock: null, block: null, firstEntry: null, initialAreas: [{ area: "Upper lip", side: "center" }] as never,
            defaultMachineFrequency: null, onCancel: () => undefined, multiplexOffer: { deviceId: PLACEHOLDER.deviceId },
          } as never),
          createElement(VisitSaveControl))),
    ),
  );
}
const multiplexPill = () => host!.querySelector<HTMLButtonElement>('[data-testid="mode-multiplex"]')!;
const clickMultiplex = () => act(async () => { multiplexPill().click(); });
const saveVisit = () => act(async () => void host!.querySelector<HTMLButtonElement>('[data-testid="visit-save-button"]')!.click());
const result = () => host!.querySelector('[data-testid^="visit-save-result-"]');
const create = blockActions.createTreatmentAreaWithEntryAction;

describe("Save visit while the first MultiPlex choice is loading", () => {
  it("sends NO save request, reports the area HELD and says it is loading MultiPlex; after the load it saves as MultiPlex", async () => {
    create.mockResolvedValue({ ok: true, blockId: "new-b1" });
    let release: (v: unknown) => void = () => undefined;
    actions.loadMachineSetupContext.mockImplementationOnce(() => new Promise((r) => { release = r; }) as never);
    await mount();
    await clickMultiplex();
    await saveVisit();
    expect(create, "no save request while the load is pending").not.toHaveBeenCalled();
    expect(result()?.getAttribute("data-status")).toBe("held");
    expect(host!.querySelector('[role="alert"]')?.textContent, "the section the result line points to says why (not just the button label)").toBe("Loading MultiPlex…");

    await act(async () => { release(ZERO()); });
    expect(multiplexPill().getAttribute("aria-pressed")).toBe("true");
    await saveVisit();
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(create.mock.calls[0])).toContain("multiplex");
  });

  it("a FAILED load: Save visit sends nothing and refuses with the plain message", async () => {
    actions.loadMachineSetupContext.mockImplementationOnce((() => Promise.reject(new Error("network"))) as never);
    await mount();
    await clickMultiplex();
    await saveVisit();
    expect(create).not.toHaveBeenCalled();
    expect(result()?.getAttribute("data-status")).not.toBe("saved");
    expect(host!.querySelector('[role="alert"]')?.textContent).toContain("MultiPlex could not be loaded");
  });
});
