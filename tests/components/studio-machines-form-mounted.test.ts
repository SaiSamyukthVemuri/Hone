// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { StudioMachinesForm } = await import("@/components/machines/studio-machines-form");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); host = root = null; });

const PUR = "dectro-apilus:xcell-pur";
const SEN = "dectro-apilus:senior-3g";
const models = [
  { profileId: PUR, name: "Dectro xCell", description: "Thermolysis, Blend, Galvanic, MultiPlex" },
  { profileId: SEN, name: "Apilus Senior 3G", description: "Thermo Flash and more" },
];
function mount(initial: { enabled: string[]; defaultProfileId: string | null }, over: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(StudioMachinesForm, { models, initial, setModel: async () => ({ ok: true, state: initial }), setDefault: async () => ({ ok: true, state: initial }), ...over } as never)));
}
const sw = (id: string) => host!.querySelector(`[data-testid="studio-machine-switch-${id}"]`) as HTMLButtonElement;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("Studio machines", () => {
  it("shows a switch per model reflecting what is on, and the default among the enabled ones plus 'Ask at each visit'", () => {
    mount({ enabled: [PUR], defaultProfileId: PUR });
    expect(sw(PUR).getAttribute("aria-checked")).toBe("true");
    expect(sw(SEN).getAttribute("aria-checked")).toBe("false");
    const sel = host!.querySelector('[data-testid="studio-machine-default"]') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["Ask at each visit", "Dectro xCell"]);
    expect(sel.value).toBe(PUR);
  });
  it("with nothing enabled there is no default control, only the instruction", () => {
    mount({ enabled: [], defaultProfileId: null });
    expect(host!.querySelector('[data-testid="studio-machine-default"]')).toBeNull();
    expect(host!.querySelector('[data-testid="studio-machine-default-none"]')?.textContent).toBe("Enable a machine to choose a default.");
  });
  it("a switch sends exactly that model and the opposite state, then shows what the database now holds", async () => {
    const calls: unknown[] = [];
    mount({ enabled: [PUR], defaultProfileId: PUR }, {
      setModel: async (id: string, on: boolean) => { calls.push([id, on]); return { ok: true, state: { enabled: [PUR, SEN], defaultProfileId: PUR } }; },
    });
    act(() => sw(SEN).click());
    await flush();
    expect(calls).toEqual([[SEN, true]]);
    expect(sw(SEN).getAttribute("aria-checked")).toBe("true");
    expect(host!.querySelector('[data-testid="studio-machines-message"]')?.textContent).toBe("Apilus Senior 3G turned on.");
  });
  it("a refusal changes nothing on screen and says so", async () => {
    mount({ enabled: [PUR], defaultProfileId: PUR }, { setModel: async () => ({ ok: false, error: "Your machine settings could not be saved. Nothing was changed." }) });
    act(() => sw(PUR).click());
    await flush();
    expect(sw(PUR).getAttribute("aria-checked")).toBe("true");
    expect(host!.querySelector('[data-testid="studio-machines-message"]')?.textContent).toMatch(/Nothing was changed/);
  });
  it("choosing 'Ask at each visit' sends null", async () => {
    const calls: unknown[] = [];
    mount({ enabled: [PUR, SEN], defaultProfileId: PUR }, { setDefault: async (id: string | null) => { calls.push(id); return { ok: true, state: { enabled: [PUR, SEN], defaultProfileId: id } }; } });
    const sel = host!.querySelector('[data-testid="studio-machine-default"]') as HTMLSelectElement;
    act(() => { sel.value = ""; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(calls).toEqual([null]);
  });
});
