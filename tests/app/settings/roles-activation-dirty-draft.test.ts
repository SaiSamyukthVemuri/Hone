// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseState } from "@/lib/settings/roles/core-parse";

// Codex P2 on #1335 (roles-editor activation): an activation preview opened with a clean draft must not stay confirmable once the owner
// edits a permission, and a preview that is still loading when the edit happens must not open. Mounted in jsdom (this file only).

const refresh = vi.fn();
vi.mock("next/navigation", async (orig) => ({ ...(await orig<Record<string, unknown>>()), useRouter: () => ({ push: vi.fn(), refresh }) }));

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { RolesEditor } = await import("@/app/(app)/settings/roles/roles-editor");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const K1 = "appt.cancel";
const state = parseState({
  ok: true,
  version: 7,
  basis: "existing_snapshot",
  gates: {},
  roles: { practitioner: { [K1]: { stored: "studio", effective: "own", source: "inactive_until_activated" } }, receptionist: {} },
})!;
const people = [{ id: "p2", name: "Alex Practitioner", email: "alex@example.test", role: "practitioner" as const, state: "active" as const }];
const failing = async () => ({ ok: false as const, error: { code: "unavailable" as const } });
const previewOk = async () => ({ ok: true as const, preview: { version: 3, roles: [] } });
const activationPreview = { ok: true as const, preview: { version: 7, roles: [], keys: [K1], digest: "abc123", sensitiveKeys: [], confirmationRequired: false } };

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  refresh.mockReset();
});

async function mount(over: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(RolesEditor, {
        policies: state.policies,
        reviewed: true,
        writable: true,
        notWritableReason: null,
        staffRoleChange: false,
        initialView: "permissions",
        people,
        timezone: "America/Toronto",
        previewSave: failing,
        previewReset: previewOk,
        previewAdopt: previewOk,
        save: failing,
        reset: failing,
        adopt: failing,
        previewActivation: async () => activationPreview,
        activate: failing,
        loadHistory: failing,
        loadAccess: failing,
        changeRole: failing,
        reload: failing,
        ...over,
      }),
    );
  });
}

const q = (sel: string) => host!.querySelector(sel) as HTMLElement | null;
async function openActivationPreview() {
  await act(async () => (q('[data-testid="activation-review"]') as HTMLButtonElement).click());
}
async function typeReason() {
  const textarea = q('[data-testid="activation-pending"] [data-testid="reason-input"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")!.set!;
  await act(async () => {
    setter.call(textarea, "Reviewing the new defaults today");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function editAPermission() {
  const radio = [...host!.querySelectorAll('input[type="radio"]')].find(
    (r) => !(r as HTMLInputElement).checked && !(r as HTMLInputElement).disabled && !q('[data-testid="activation-pending"]')!.contains(r),
  ) as HTMLInputElement;
  expect(radio, "an editable permission option to change").toBeTruthy();
  await act(async () => radio.click());
}
const commit = () => q('[data-testid="activation-commit"]') as HTMLButtonElement | null;

describe("activation cannot be confirmed over an unsaved permission draft", () => {
  it("control: with a clean draft the opened preview is confirmable and commits", async () => {
    const activate = vi.fn(async () => ({ ok: true as const, newVersion: 8 }));
    await mount({ activate });
    await openActivationPreview();
    await typeReason();
    expect(commit()?.disabled).toBe(false);
    await act(async () => commit()!.click());
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("an edit after the preview opened drops the preview: no confirmable commit, a visible line, and activate is never called", async () => {
    const activate = vi.fn(async () => ({ ok: true as const, newVersion: 8 }));
    await mount({ activate });
    await openActivationPreview();
    await typeReason();
    expect(commit()?.disabled).toBe(false);
    await editAPermission();
    expect(commit(), "the preview is gone or its commit is disabled").toSatisfy((b: HTMLButtonElement | null) => b === null || b.disabled);
    expect(q('[data-testid="activation-pending"]')!.textContent).toMatch(/unsaved changes/i);
    expect(activate).not.toHaveBeenCalled();
  });

  it("an edit while the preview is still loading: the late preview does not open", async () => {
    let release!: (v: typeof activationPreview) => void;
    const previewActivation = vi.fn(() => new Promise<typeof activationPreview>((r) => (release = r)));
    await mount({ previewActivation });
    await openActivationPreview();
    await editAPermission();
    await act(async () => release(activationPreview));
    expect(commit()).toBeNull();
    expect(q('[data-testid="activation-pending"]')!.textContent).toMatch(/unsaved changes/i);
  });
});

// Codex P2 on #1335 (401cbff82): once the owner confirms an activation, editing is locked until the request has settled, so a change made
// in that window cannot be dropped when the page is replaced with the saved state.
describe("permission editing is locked while an activation is in flight", () => {
  const radios = () => [...host!.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
  const snapshot = () => radios().map((r) => `${r.name}=${r.value}:${r.checked}`).join("|");
  // an input inside a disabled fieldset still reports disabled=false; :disabled is the effective state
  const enabledCount = () => radios().filter((r) => !r.matches(":disabled")).length;

  it("every permission control is disabled until activate settles; the draft is unchanged on return", async () => {
    let settle!: (v: { ok: false; error: { code: "refused" } }) => void;
    const activate = vi.fn(() => new Promise<{ ok: false; error: { code: "refused" } }>((r) => (settle = r)));
    await mount({ activate });
    await openActivationPreview();
    await typeReason();
    const before = snapshot();
    expect(enabledCount(), "control: editable before the commit").toBeGreaterThan(0);
    await act(async () => commit()!.click());
    expect(activate).toHaveBeenCalledTimes(1);
    expect(enabledCount(), "no permission control is editable while activation is pending").toBe(0);
    // an attempted edit through the DOM changes nothing
    const target = radios().find((r) => !r.checked)!;
    await act(async () => target.click());
    expect(snapshot()).toBe(before);
    await act(async () => settle({ ok: false, error: { code: "refused" } }));
    expect(enabledCount(), "editable again once the request has settled").toBeGreaterThan(0);
    expect(snapshot(), "the draft is unchanged on return").toBe(before);
  });

  it("a rejected activation request also unlocks the editor, with a visible message", async () => {
    await mount({ activate: () => Promise.reject(new Error("network down")) });
    await openActivationPreview();
    await typeReason();
    await act(async () => commit()!.click());
    expect(q('[data-testid="activation-pending"]')!.textContent).toMatch(/could not confirm/i);
    expect(enabledCount()).toBeGreaterThan(0);
  });
});

// Privacy Q3/Q4 on #1335: the reason box asks owners to keep client names and clinical details out of it, and History says what it covers.
describe("copy: reason hint and History scope", () => {
  it("the activation reason box carries the no-client-details line", async () => {
    await mount({});
    await openActivationPreview();
    expect(q('[data-testid="activation-pending"]')!.textContent).toMatch(/Please don.t include client names or clinical details\./);
  });
  it("History describes the changes made on this page, not every role write", async () => {
    await mount({ initialView: "history" });
    const text = q('[data-testid="roles-history"]')!.textContent ?? "";
    expect(text).toContain("Every change made on this page");
    expect(text).not.toContain("Every role and permission change");
  });
});
