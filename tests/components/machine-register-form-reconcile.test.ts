// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// Codex P2 (#1637): after a registration removes the xCell option, the form kept the removed profile id in state while the menu showed
// another model, so submitting would act on a model the person did not choose. The form now derives the model from the CURRENT list.

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MachineRegisterForm, reconcileProfileId } = await import("@/components/machines/machine-register-form");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = { profileId: "model-a", label: "Maker Alpha" };
const X = { profileId: "model-x", label: "Dectro xCell" };

let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); host = root = null; });

const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
};

describe("reconcileProfileId", () => {
  it("keeps a choice that is still listed and falls back to the first listed model otherwise", () => {
    expect(reconcileProfileId("model-x", [A, X])).toBe("model-x");
    expect(reconcileProfileId("model-x", [A])).toBe("model-a");
    expect(reconcileProfileId("model-x", [])).toBe("");
  });
});

describe("the form acts on the model the menu shows", () => {
  it("after the chosen model leaves the list, a submit registers the model now shown, never the removed one", async () => {
    const register = vi.fn(async () => ({ ok: true }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(MachineRegisterForm, { models: [A, X], register } as never)));
    const select = () => host!.querySelector<HTMLSelectElement>("#machine-model")!;
    setValue(select(), "model-x");
    expect(select().value).toBe("model-x");
    // the xCell is registered elsewhere and leaves the list
    act(() => root!.render(createElement(MachineRegisterForm, { models: [A], register } as never)));
    expect(select().value).toBe("model-a");
    setValue(host!.querySelector<HTMLInputElement>("#machine-name")!, "Room 2");
    await act(async () => { host!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith({ profileId: "model-a", displayName: "Room 2" });
  });
});
