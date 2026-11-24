// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { StudioMachinesForm } = await import("@/components/machines/studio-machines-form");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEN = "dectro-apilus:senior-3g";
const models = [{ profileId: "dectro-apilus:xcell-pur", name: "xCell", description: "" }, { profileId: SEN, name: "Senior 3G", description: "" }];
const noop = async () => ({ ok: true as const, state: { enabled: [], defaultProfileId: null } });
let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); host = root = null; });
const render = (initial: { enabled: string[]; defaultProfileId: string | null }, key?: string) =>
  act(() => root!.render(createElement(StudioMachinesForm, { key, models, initial, setModel: noop, setDefault: noop })));
const senOn = () => host!.querySelector(`[data-testid="studio-machine-switch-${SEN}"]`)!.getAttribute("aria-checked");

describe("the switches show the state the server now holds after a registration re-renders the page", () => {
  it("a new server state under a new key shows the Senior switch on; the same key keeps the old copy (why the key is needed)", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    render({ enabled: ["dectro-apilus:xcell-pur"], defaultProfileId: null }, "a");
    expect(senOn()).toBe("false");
    render({ enabled: ["dectro-apilus:xcell-pur", SEN], defaultProfileId: null }, "a");
    expect(senOn(), "same key: the form keeps its own copy").toBe("false");
    render({ enabled: ["dectro-apilus:xcell-pur", SEN], defaultProfileId: null }, "b");
    expect(senOn()).toBe("true");
  });
  it("the page keys the form by the state it read (enabled models and the default)", () => {
    const src = readFileSync("app/(app)/settings/machines/page.tsx", "utf8");
    expect(src).toContain("key={`${switches.enabled.slice().sort().join(\",\")}|${switches.defaultProfileId ?? \"\"}`}");
  });
});
