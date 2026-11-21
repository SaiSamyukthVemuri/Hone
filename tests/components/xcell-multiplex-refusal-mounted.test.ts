// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { MachineFirstSetupPanel } = await import("@/components/machines/machine-first-setup-panel");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); host = root = null; });

const MSG = "The studio's xCell has been retired, so MultiPlex cannot be used. Ask the studio owner to add the xCell again in Settings.";
function mount(extra: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(MachineFirstSetupPanel, {
    devices: [], scope: { studioId: "s", practitionerId: "p" }, catalogue: MACHINE_CATALOGUE, legacyMachine: { profileId: "dectro-apilus:xcell", label: "Dectro xCell" }, multiplexRoute: null, ...extra,
  } as never)));
}

describe("a retired xCell is explained at the machine choice", () => {
  it("shows the refusal as a plain note under the machine choice", () => {
    mount({ multiplexRefusal: MSG });
    const note = host!.querySelector('[data-testid="xcell-multiplex-refusal"]');
    expect(note?.textContent).toBe(MSG);
    expect(note?.getAttribute("role")).toBe("note");
  });
  it("shows nothing without a refusal", () => {
    mount({ multiplexRefusal: null });
    expect(host!.querySelector('[data-testid="xcell-multiplex-refusal"]')).toBeNull();
  });
});
