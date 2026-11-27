// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-124 item 19 / Insurance F1+F2. The dashboard quick-pin consumes the pinned-note actions. A caution note is clinical: a refused or failed
// save must NEVER close the dialog and discard what was typed, and a successful save must draw the pin. Both result shapes are pinned, plus the
// deploy-skew reading (an old server's bare pin, or undefined, means "went through" - the pre-result behaviour - never a failure).
const next: { add: unknown; edit: unknown } = { add: undefined, edit: undefined };
const calls = { add: 0, edit: 0 };
vi.mock("../clients/[id]/pinned-notes-actions", () => ({ addClientPinnedNoteAction: async () => { calls.add++; if (next.add instanceof Error) throw next.add; return next.add; }, editClientPinnedNoteAction: async () => { calls.edit++; if (next.edit instanceof Error) throw next.edit; return next.edit; } }));
vi.mock("@/app/(app)/clients/[id]/pinned-notes-actions", () => ({ addClientPinnedNoteAction: async () => { calls.add++; if (next.add instanceof Error) throw next.add; return next.add; }, editClientPinnedNoteAction: async () => { calls.edit++; if (next.edit instanceof Error) throw next.edit; return next.edit; } }));

async function mount(note?: { id: string; text: string; created_by_practitioner_id: string | null }) {
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { DashboardQuickPin } = await import("@/app/(app)/dashboard/dashboard-quick-pin");
  const host = document.createElement("div"); document.body.appendChild(host);
  await act(async () => { createRoot(host).render(createElement(DashboardQuickPin, { clientId: "c1", clientName: "Ada", pinnedNotes: note ? [note] : [], viewer: { isOwner: true, practitionerId: "p1" } })); });
  const open = host.querySelector(note ? 'button[aria-label^="Edit pinned note"]' : 'button[aria-label^="Add pinned note"]') as HTMLButtonElement;
  await act(async () => { open.click(); });
  const ta = host.querySelector("textarea, input[type=text]") as HTMLTextAreaElement;
  const set = async (v: string) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), "value")!; await act(async () => { d.set!.call(ta, v); ta.dispatchEvent(new Event("input", { bubbles: true })); }); };
  const save = async () => { await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
  return { host, ta, set, save };
}
beforeEach(() => { calls.add = 0; calls.edit = 0; next.add = undefined; next.edit = undefined; });

describe("a refused or failed save keeps the dialog open and the typed note", () => {
  it("returned {ok:false,error}: the sentence shows, the textarea keeps the text, the dialog stays open, no pin is drawn", async () => {
    next.add = { ok: false, error: "Shorten the note to 200 characters or fewer, then save it again." };
    const { host, set, save } = await mount();
    await set("Latex allergy - use nitrile");
    await save();
    expect(host.querySelector("form")).not.toBeNull(); // still open
    expect((host.querySelector("textarea, input[type=text]") as HTMLTextAreaElement).value).toBe("Latex allergy - use nitrile");
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("Shorten the note");
    expect(host.textContent).not.toMatch(/Latex allergy - use nitrile.*Edit/s);
  });
  it("a thrown error keeps it open with the fixed sentence", async () => {
    next.add = new Error("An error occurred in the Server Components render");
    const { host, set, save } = await mount();
    await set("Keep me");
    await save();
    expect(host.querySelector("form")).not.toBeNull();
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/Couldn’t save the note/);
    expect(host.textContent).not.toContain("Server Components");
  });
  it("edit: a returned failure keeps the edit and its text", async () => {
    next.edit = { ok: false, error: "That note changed or is no longer available. Reload the page and try again." };
    const { host, set, save } = await mount({ id: "n1", text: "old", created_by_practitioner_id: "p1" });
    await set("new text");
    await save();
    expect(calls.edit).toBe(1);
    expect((host.querySelector("textarea, input[type=text]") as HTMLTextAreaElement).value).toBe("new text");
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("Reload the page");
  });
});

describe("a successful save draws the pin and closes (both shapes)", () => {
  it("new shape {ok:true,data}", async () => {
    next.add = { ok: true, data: { id: "n9", text: "Beta blockers", created_by_practitioner_id: "p1" } };
    const { host, set, save } = await mount();
    await set("Beta blockers");
    await save();
    expect(host.querySelector("form")).toBeNull();
    expect(host.textContent).toContain("Beta blockers");
  });
  it("OLD shape (the bare pin, from a server not yet on this deploy) draws it too", async () => {
    next.add = { id: "n8", text: "Pacemaker", created_by_practitioner_id: "p1" };
    const { host, set, save } = await mount();
    await set("Pacemaker");
    await save();
    expect(host.querySelector("form")).toBeNull();
    expect(host.textContent).toContain("Pacemaker");
  });
  it("undefined (an old void server) is read as 'went through': closes, no failure message", async () => {
    next.add = undefined;
    const { host, set, save } = await mount();
    await set("Whatever");
    await save();
    expect(host.querySelector("form")).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
