// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { XCELL_PUR_PROFILES } from "@/lib/machines/xcell-pur";
import { SYNTHETIC_DEMO_PROFILE } from "@/lib/machines/synthetic-profile";

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { MachineSettingDraft } = await import("@/components/machines/machine-setting-draft");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); host = root = null; });

const profile = XCELL_PUR_PROFILES[0];
const mode = profile.modes.find((m) => m.key === "multiplex")!;

type Parked = Parameters<NonNullable<React.ComponentProps<typeof MachineSettingDraft>["onPark"]>>[0];
function mount(extra: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(MachineSettingDraft, { profile, mode, ...extra } as never)));
}
function unmount() { act(() => root!.unmount()); host!.remove(); host = root = null; }
function type(el: HTMLInputElement, v: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => { set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); });
}
const inputs = () => [...host!.querySelectorAll("input")].filter((i) => i.type !== "checkbox" && i.type !== "hidden") as HTMLInputElement[];

describe("a MultiPlex draft parked while she looks at another machine or mode comes back exactly", () => {
  it("restores what was typed, keeps blank blank, and reports the restored payload (not an empty one) under the remount", () => {
    let parked: Parked | null = null;
    const reports1: { groups: unknown[]; blocking: string | null }[] = [];
    mount({ onDraftChange: (d: { groups: unknown[]; blocking: string | null }) => reports1.push(d), onPark: (p: Parked) => { parked = p; } });
    const first = inputs();
    expect(first.length).toBeGreaterThan(3);
    type(first[0], "12.5");
    type(first[1], "40");
    const typedValues = inputs().map((i) => i.value);
    expect(typedValues.slice(0, 2)).toEqual(["12.5", "40"]);
    expect(typedValues.slice(2).every((v) => v === "")).toBe(true);
    expect(parked).not.toBeNull();
    unmount();

    const reports2: { groups: unknown[]; blocking: string | null }[] = [];
    mount({ restore: parked, onDraftChange: (d: { groups: unknown[]; blocking: string | null }) => reports2.push(d), onPark: () => undefined });
    expect(inputs().map((i) => i.value)).toEqual(typedValues);
    // the FIRST report after the remount already carries her values (never an empty draft that a Save could send)
    expect(reports2.length).toBeGreaterThan(0);
    expect(reports2[0].groups.length).toBeGreaterThan(0);
    expect(JSON.stringify(reports2[0].groups)).toContain("12.5");
  });
  it("without a restore a remount starts empty and reports the empty draft (the existing stale-draft protection)", () => {
    const reports: { groups: unknown[] }[] = [];
    mount({ onDraftChange: (d: { groups: unknown[] }) => reports.push(d) });
    expect(inputs().every((i) => i.value === "")).toBe(true);
    expect(reports[0].groups).toEqual([]);
  });
  it("group ids are never REISSUED across add, remove, park and restore: a removed group's id stays retired (the parked counter is not one behind)", () => {
    let parked: Parked | null = null;
    const issued = new Set<string>();
    const demo = { profile: SYNTHETIC_DEMO_PROFILE, mode: SYNTHETIC_DEMO_PROFILE.modes[0] };
    const track = (p: Parked) => { parked = p; for (const g of p.groups) issued.add(g.id); };
    mount({ ...demo, onDraftChange: () => undefined, onPark: track });
    const add = () => act(() => { host!.querySelector<HTMLButtonElement>('[data-testid="setting-group-add"]')!.click(); });
    const removeAllButFirst = () => {
      const ids = (parked?.groups ?? []).map((g) => g.id).slice(1);
      for (const id of ids) act(() => { host!.querySelector<HTMLButtonElement>(`[data-testid="setting-group-remove-${id}"]`)?.click(); });
    };
    type(inputs()[0], "5");
    add();
    add();
    const retired = new Set(issued);
    expect(retired.size).toBeGreaterThanOrEqual(3);
    removeAllButFirst();
    expect(parked!.groups.length, "control: only the first group is left").toBe(1);
    add(); // a new group after removals: its id must not be one that was issued and removed
    const fresh = parked!.groups.map((g) => g.id).filter((id) => !retired.has(id) || id === parked!.groups[0].id);
    expect(parked!.groups.length).toBe(2);
    expect(parked!.groups.map((g) => g.id).filter((id) => retired.has(id)).length, "the added group's id is new, not a removed group's").toBe(1);
    unmount();
    mount({ ...demo, restore: parked, onDraftChange: () => undefined, onPark: track });
    add();
    const ids = parked!.groups.map((g) => g.id);
    expect(ids.length).toBe(3);
    expect(new Set(ids).size, "after restoring and adding, no id is issued twice").toBe(3);
    expect(fresh.length).toBeGreaterThan(0);
  });
});
