// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ action: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/components/pending-link", () => ({ PendingLink: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never) }));
vi.mock("@/app/(app)/clients/group-actions", () => ({ changeClientGroup: mocks.action }));
import { ClientGroupsCard, GroupCatalogue } from "@/app/(app)/clients/ClientGroups";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const group = { id: "g1", name: "Active", updated_at: "2030-01-01T00:00:00Z" };
beforeEach(() => { vi.clearAllMocks(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
function setInput(input: HTMLInputElement, value: string) {
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
describe("group controls", () => {
  it("acknowledges membership pending, disables repeats, then displays uncertain failures", async () => {
    let reject!: (reason: unknown) => void;
    mocks.action.mockReturnValue(new Promise((_, r) => { reject = r; }));
    act(() => root.render(createElement(ClientGroupsCard, { clientId: "c1", catalogue: { available: true, value: [group] }, assigned: { available: true, value: [group] } })));
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Remove Active"]')!;
    await act(async () => { button.click(); });
    expect(button.disabled).toBe(true); expect(host.textContent).toContain("Saving group change");
    await act(async () => { reject(new Error("network")); });
    expect(button.disabled).toBe(false); expect(host.querySelector('[role="alert"]')?.textContent).toContain("Reload");
    expect(mocks.action).toHaveBeenCalledWith({ kind: "membership", clientId: "c1", groupId: "g1", assigned: false });
  });
  it("keeps typed draft and its original CAS baseline when another form refreshes the catalogue", async () => {
    mocks.action.mockResolvedValue({ ok: false, error: "Someone renamed this group. Reload." });
    act(() => root.render(createElement(GroupCatalogue, { groups: [group] })));
    const inputs = host.querySelectorAll("input"); setInput(inputs[1], "My draft");
    act(() => root.render(createElement(GroupCatalogue, { groups: [{ ...group, name: "Renamed elsewhere", updated_at: "2030-01-02T00:00:00Z" }] })));
    expect(inputs[1].value).toBe("My draft");
    await act(async () => { host.querySelectorAll("form")[1].dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ name: "My draft", expectedName: "Active", expectedUpdatedAt: group.updated_at }));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Reload"); expect(inputs[1].value).toBe("My draft");
  });
});
