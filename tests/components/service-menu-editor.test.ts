// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FormDirtyGuard } from "@/components/settings/form-dirty-guard";
import { UnsavedChangesProvider } from "@/components/settings/unsaved-changes";
import { ServiceOrderList, ServiceSaveForm } from "@/app/(app)/settings/services/ServiceOrderList";

vi.mock("@/app/(app)/settings/services/actions", () => ({ moveServiceAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function ServiceMenu({ save }: { save: (name: string) => Promise<string> }) {
  const [names, setNames] = useState(["Consultation", "Electrolysis"]);
  const rows = names.map((name, i) => ({
    id: String(i), name, active: true, duration: 30, price: "$90.00", colorKey: null, visibility: null,
    editor: createElement(ServiceSaveForm, {
      title: name, serviceId: String(i), saveAction: async (data: FormData) => {
        const result = await save(String(data.get("name")));
        setNames((stored) => stored.map((v, index) => index === i ? result : v));
        return { ok: true as const };
      },
      children: [
        createElement(FormDirtyGuard, { key: "guard", name: `service-edit-${i}`, token: name }),
        createElement("input", { key: "name", name: "name", defaultValue: name, required: true }),
      ],
    }),
  }));
  return createElement(UnsavedChangesProvider, {
    children: createElement(ServiceOrderList, {
      rows, groups: [{ label: "Menu", ids: ["0", "1"] }], createEditor: null,
    }),
  });
}

function select(index: number) {
  return act(async () => document.getElementById(`service-select-${index}`)!.click());
}
function editForm(index: number) {
  return document.getElementById(`service-editor-${index}`)!.querySelector("form")!;
}
function nameInput(index: number) {
  return editForm(index).elements.namedItem("name") as HTMLInputElement;
}
function isDirty() {
  const beforeUnload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(beforeUnload);
  return beforeUnload.defaultPrevented;
}

it("keeps the draft and navigation guard on refusal, then restores the accepted server value on retry", async () => {
  const save = vi.fn<(name: string) => Promise<string>>()
    .mockRejectedValueOnce(new Error("temporarily refused"))
    .mockResolvedValueOnce("Trimmed service");
  await act(async () => root.render(createElement(ServiceMenu, { save })));
  await select(0);
  await act(async () => {
    const input = nameInput(0);
    input.value = "  Trimmed service  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(isDirty()).toBe(true);
  await select(1);
  await select(0);
  expect(nameInput(0).value).toBe("  Trimmed service  ");
  await act(async () => editForm(0).requestSubmit());
  expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/try again/i);
  expect(host.querySelector('[role="status"]')?.textContent).not.toMatch(/saved/i);
  expect(nameInput(0).value).toBe("  Trimmed service  ");
  expect(isDirty()).toBe(true);
  await act(async () => editForm(0).requestSubmit());
  expect(save).toHaveBeenCalledTimes(2);
  expect(nameInput(0).value).toBe("Trimmed service");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[role="status"]')?.textContent).toMatch(/saved/i);
  expect(isDirty()).toBe(false);
});

it("keeps Discard edits disabled while a save is in flight, so a newer draft is never erased, and re-enables it after a refused save", async () => {
  let release!: (value: string) => void; let refuse!: (error: Error) => void;
  const pending = new Promise<string>((resolve, reject) => { release = resolve; refuse = reject; });
  const save = vi.fn<(name: string) => Promise<string>>()
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce("Second save");
  await act(async () => root.render(createElement(ServiceMenu, { save })));
  await select(0);
  const discard = () => document.querySelector<HTMLButtonElement>('[data-testid="discard-edits-0"]')!;
  expect(discard().disabled).toBe(false);
  await act(async () => { nameInput(0).value = "First edit"; nameInput(0).dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => editForm(0).requestSubmit());
  // in flight: the form is busy and discard cannot be used; a click does nothing
  expect(editForm(0).getAttribute("aria-busy")).toBe("true");
  expect(discard().disabled).toBe(true);
  expect(discard().getAttribute("aria-disabled")).toBe("true");
  await act(async () => discard().click());
  expect(host.querySelector('[role="status"]')?.textContent ?? "").not.toMatch(/discarded/i);
  expect(nameInput(0).value).toBe("First edit");
  // a second submit while pending is ignored, not queued
  await act(async () => editForm(0).requestSubmit());
  expect(save).toHaveBeenCalledTimes(1);
  // the save is REFUSED: the draft stays, Discard works again, retry works
  await act(async () => { refuse(new Error("temporarily refused")); await pending.catch(() => {}); });
  expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/try again/i);
  expect(nameInput(0).value).toBe("First edit");
  expect(discard().disabled).toBe(false);
  await act(async () => { nameInput(0).value = "Newer edit"; nameInput(0).dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => editForm(0).requestSubmit());
  expect(save).toHaveBeenCalledTimes(2);
  expect(discard().disabled).toBe(false);
  // discarding once idle still discards
  await act(async () => { nameInput(0).value = "Unsaved"; nameInput(0).dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => discard().click());
  expect(host.querySelector('[role="status"]')?.textContent).toMatch(/discarded/i);
});
