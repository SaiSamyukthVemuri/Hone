// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// HON-124 item 14. A destructive press asks first through the house ConfirmDialog: it names the action and its consequence, Cancel and Escape
// do nothing, focus returns to the trigger, Confirm runs the action ONCE with the fields, and a failure shows a fixed sentence.
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ConfirmActionForm } = await import("@/components/confirm-action-form");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounts: HTMLElement[] = [];
function render(el: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  mounts.push(host);
  act(() => createRoot(host).render(el));
  return host;
}
afterEach(() => { mounts.splice(0).forEach((m) => m.remove()); });
const props = (action: (fd: FormData) => Promise<void>) => ({
  action, fields: { id: "row-1" }, triggerLabel: "Remove", triggerAriaLabel: "Remove Ada",
  title: "Remove Ada from the team?", description: "Ada will be deactivated and lose access to this studio. Their existing appointments and records are kept.",
  confirmLabel: "Remove", busyLabel: "Removing…",
});
const dialog = () => document.querySelector('[data-testid="confirm-dialog"]');
const tick = async () => { await act(async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); }); };

describe("ConfirmActionForm", () => {
  it("pressing the trigger runs nothing: it opens an alertdialog that names the action and its consequence", async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    const h = render(createElement(ConfirmActionForm, props(action)));
    const trigger = h.querySelector("button")!;
    expect(trigger.getAttribute("aria-label")).toBe("Remove Ada");
    await act(async () => { trigger.click(); });
    expect(action).not.toHaveBeenCalled();
    const d = document.querySelector('[role="alertdialog"]')!;
    expect(d).not.toBeNull();
    expect(d.textContent).toContain("Remove Ada from the team?");
    expect(d.textContent).toContain("lose access to this studio");
    expect(d.textContent).toContain("appointments and records are kept");
  });

  it("Cancel and Escape close it without running the action, and focus goes back to the trigger", async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    const h = render(createElement(ConfirmActionForm, props(action)));
    const trigger = h.querySelector("button")!;
    trigger.focus();
    await act(async () => { trigger.click(); });
    await act(async () => { (document.querySelector('[data-testid="confirm-dialog-cancel"]') as HTMLElement).click(); });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await act(async () => { trigger.click(); });
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(action).not.toHaveBeenCalled();
  });

  it("Confirm runs the action exactly once with the hidden fields, then closes", async () => {
    let seen: Record<string, string> = {};
    const action = vi.fn(async (fd: FormData) => { seen = Object.fromEntries([...fd.entries()] as [string, string][]); });
    const h = render(createElement(ConfirmActionForm, props(action)));
    await act(async () => { h.querySelector("button")!.click(); });
    const confirm = document.querySelector('[data-testid="confirm-dialog-confirm"]') as HTMLButtonElement;
    await act(async () => { confirm.click(); confirm.click(); });
    await tick();
    expect(action).toHaveBeenCalledTimes(1);
    expect(seen).toEqual({ id: "row-1" });
    expect(dialog()).toBeNull();
  });

  it("a failure keeps the dialog open with a FIXED sentence, never the action's own error text", async () => {
    const action = vi.fn().mockRejectedValue(new Error("duplicate key value violates unique constraint secret_table_pkey"));
    const h = render(createElement(ConfirmActionForm, props(action)));
    await act(async () => { h.querySelector("button")!.click(); });
    await act(async () => { (document.querySelector('[data-testid="confirm-dialog-confirm"]') as HTMLElement).click(); });
    await tick();
    const d = dialog()!;
    expect(d).not.toBeNull();
    expect(d.textContent).toContain("That did not go through.");
    expect(d.textContent).not.toMatch(/duplicate key|secret_table/);
  });
});

describe("after a success the row unmounts: focus moves to a stable target and the result is announced", () => {
  it("document.activeElement is the list heading, not body, and the live region says what happened", async () => {
    const { useState } = await import("react");
    function Harness({ action }: { action: (fd: FormData) => Promise<void> }) {
      const [rows, setRows] = useState(["a"]);
      return createElement("div", null,
        createElement("p", { id: "team-live", role: "status" }),
        createElement("h2", { id: "pending-invitations", tabIndex: -1 }, "Pending invitations"),
        ...rows.map((r) => createElement("div", { key: r },
          createElement(ConfirmActionForm, {
            ...props(async (fd: FormData) => { await action(fd); setRows([]); }),
            afterSuccess: { focusId: "pending-invitations", announceId: "team-live", message: "Ada was removed from the team." },
          }))));
    }
    const action = vi.fn().mockResolvedValue(undefined);
    const h = render(createElement(Harness, { action }));
    const trigger = h.querySelector("button")!;
    trigger.focus();
    await act(async () => { trigger.click(); });
    await act(async () => { (document.querySelector('[data-testid="confirm-dialog-confirm"]') as HTMLElement).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(h.querySelector("button")).toBeNull(); // the row really is gone
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.id).toBe("pending-invitations");
    expect(h.querySelector("#team-live")!.textContent).toBe("Ada was removed from the team.");
  });

  it("a failure keeps focus where it was (inside the open dialog) and announces nothing", async () => {
    const action = vi.fn().mockRejectedValue(new Error("x"));
    const h = render(createElement("div", null,
      createElement("p", { id: "team-live", role: "status" }),
      createElement("h2", { id: "hd", tabIndex: -1 }, "H"),
      createElement(ConfirmActionForm, { ...props(action), afterSuccess: { focusId: "hd", announceId: "team-live", message: "done" } })));
    await act(async () => { h.querySelector("button")!.click(); });
    await act(async () => { (document.querySelector('[data-testid="confirm-dialog-confirm"]') as HTMLElement).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(h.querySelector("#team-live")!.textContent).toBe("");
    expect(document.activeElement?.id).not.toBe("hd");
  });
});

describe("source pins: every destructive control in scope asks first", () => {
  const ROOT = path.resolve(__dirname, "../..");
  const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
  it("the team page no longer posts Remove, Revoke or Deactivate straight from a bare form", () => {
    const src = read("app/(app)/settings/team/page.tsx");
    for (const a of ["removePractitionerAction", "revokeInvitationAction"]) {
      expect(src).not.toContain(`<form action={${a}}>`);
      expect(src).toMatch(new RegExp(`<ConfirmActionForm[^>]*\\n\\s*action=\\{${a}\\}`));
    }
    // Deactivate asks; Reactivate (not destructive) keeps its plain form
    expect(src).toMatch(/<ConfirmActionForm[^>]*\n\s*action=\{setReceptionistActiveAction\}/);
    expect(src).toMatch(/<form action=\{setReceptionistActiveAction\}>[\s\S]{0,900}Reactivate/);
  });
  it("each team list names a focusable heading and the page has one live region outside the rows", () => {
    const src = read("app/(app)/settings/team/page.tsx");
    for (const id of ["front-desk", "practitioners", "pending-invitations"]) expect(src).toMatch(new RegExp(`<h2 id="${id}" tabIndex=\\{-1\\}`));
    expect(src.match(/id="team-live" role="status"/g)?.length).toBe(1);
    expect(src.match(/afterSuccess=\{\{ focusId: "(front-desk|practitioners|pending-invitations)", announceId: "team-live"/g)?.length).toBe(3);
  });
  it("the practitioner's Cancel appointment runs the action only from the dialog's Confirm", () => {
    const src = read("app/(app)/calendar/PractitionerCancelForm.tsx");
    expect(src).toContain("onSubmit={ask}");
    expect(src).toMatch(/onConfirm=\{submit\}/);
    expect(src).toMatch(/function ask\(e: React\.FormEvent\) \{\s*e\.preventDefault\(\);[\s\S]{0,120}setConfirming\(true\)/);
    expect(src.match(/cancelAppointmentAction\(/g)?.length).toBe(1);
  });
});
