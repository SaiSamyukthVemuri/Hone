// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardQuickPin } from "@/app/(app)/dashboard/dashboard-quick-pin";

const { add, edit } = vi.hoisted(() => ({ add: vi.fn(), edit: vi.fn() }));
vi.mock("@/app/(app)/clients/[id]/pinned-notes-actions", () => ({
  addClientPinnedNoteAction: add,
  editClientPinnedNoteAction: edit,
}));

const notes = [
  { id: "mine", text: "Winter travel", created_by_practitioner_id: "chloe" },
  { id: "theirs", text: "Morning visits", created_by_practitioner_id: "alex" },
  { id: "legacy", text: "Phone for openings", created_by_practitioner_id: null },
];
let host: HTMLDivElement;
let root: Root;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  vi.resetAllMocks();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(isOwner: boolean, pinnedNotes = notes) {
  act(() => root.render(createElement(DashboardQuickPin, {
    clientId: "client", clientName: "Morgan", viewer: { isOwner, practitionerId: "chloe" }, pinnedNotes,
  })));
}

function button(label: string) {
  const target = [...host.querySelectorAll("button")].find(el => (el.getAttribute("aria-label") ?? el.textContent) === label);
  if (!target) throw new Error(`Missing button ${label}`);
  return target;
}

function type(text: string) {
  const field = host.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return field;
}

describe("inline dashboard pinned notes", () => {
  it("shows every pin once and offers edit only to its author or the owner", () => {
    render(false);
    expect([...host.querySelectorAll("li")].map(el => el.textContent?.replace(/Edit$/, ""))).toEqual(notes.map(n => n.text));
    expect(host.querySelectorAll('button[aria-label^="Edit pinned note"]')).toHaveLength(1);
    render(true);
    expect(host.querySelectorAll('button[aria-label^="Edit pinned note"]')).toHaveLength(3);
  });

  it("uses the original text seen when opened even if another practitioner edits it while open", async () => {
    render(false);
    act(() => button("Edit pinned note for Morgan: Winter travel").click());
    expect(host.querySelector("textarea")?.value).toBe("Winter travel");
    type("Back in December");
    render(false, notes.map(n => n.id === "mine" ? { ...n, text: "Newer note from another device" } : n));
    edit.mockRejectedValue(new Error("conflict"));
    await act(async () => button("Save pinned note").click());
    expect(edit).toHaveBeenCalledTimes(1);
    const data = edit.mock.calls[0][0] as FormData;
    expect(Object.fromEntries(data)).toEqual({ client_id: "client", note_id: "mine", original_text: "Winter travel", text: "Back in December" });
    expect(add).not.toHaveBeenCalled();
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Refresh");
    expect(host.querySelector("textarea")?.value).toBe("Back in December");
    act(() => button("Cancel").click());
    expect(host.textContent).toContain("Newer note from another device");
  });

  it("saves a new pin through the existing add action without any edit metadata", async () => {
    render(false);
    act(() => button("Add pinned note for Morgan").click());
    type("Available after 4 pm");
    await act(async () => button("Save pinned note").click());
    expect(Object.fromEntries(add.mock.calls[0][0] as FormData)).toEqual({ client_id: "client", text: "Available after 4 pm" });
    expect(edit).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")).toBeNull();
  });
});
