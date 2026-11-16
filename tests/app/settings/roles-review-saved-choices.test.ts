// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseState } from "@/lib/settings/roles/core-parse";

// Codex 4582227072 and 4582227075 on #1490, mounted in jsdom (this file only). Synthetic data.
//  1. With nothing released, a stored choice can change while effective access does not: the review must still list it, under its own heading.
//  2. A refused or rejected preview must not leave the review stuck on "checking" with Save disabled: the draft is kept, the error is shown, and
//     Review changes works again.

const refresh = vi.fn();
vi.mock("next/navigation", async (orig) => ({ ...(await orig<Record<string, unknown>>()), useRouter: () => ({ push: vi.fn(), refresh }) }));

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { RolesEditor } = await import("@/app/(app)/settings/roles/roles-editor");
const { UnsavedChangesProvider } = await import("@/components/settings/unsaved-changes");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "appt.cancel";
const state = parseState({
  ok: true,
  version: 7,
  basis: "existing_snapshot",
  gates: {},
  roles: { practitioner: { [KEY]: { stored: "studio", effective: "studio", source: "snapshot" } }, receptionist: {} },
})!;
const people = [{ id: "p2", name: "Alex Practitioner", email: "alex@example.test", role: "practitioner" as const, state: "active" as const }];
const failing = async () => ({ ok: false as const, error: { code: "unavailable" as const } });
const previewOk = async () => ({ ok: true as const, preview: { version: 3, roles: [] } });
const emptyDiff = { changes: [], fixedNarrowings: [], widened: 0, narrowed: 0, newlyEnabledSensitive: 0 };
const effectivePreview = {
  ok: true as const,
  preview: { version: 7, roles: [{ role: "practitioner" as const, diff: { ...emptyDiff, narrowed: 1 }, people: [{ id: "p2", name: "Alex Practitioner", state: "active" as const }], count: 1, storedRemoved: [] }] },
};
const inertPreview = { ok: true as const, preview: { version: 7, roles: [{ role: "practitioner" as const, diff: emptyDiff, people: [], count: 0, storedRemoved: [] }] } };

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
      createElement(UnsavedChangesProvider, null, createElement(RolesEditor, {
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
        previewActivation: failing,
        activate: failing,
        loadHistory: failing,
        loadAccess: failing,
        changeRole: failing,
        reload: failing,
        ...over,
      })),
    );
  });
}

const q = (sel: string) => host!.querySelector(sel) as HTMLElement | null;
const button = (re: RegExp) => [...host!.querySelectorAll("button")].find((b) => re.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
async function chooseOff() {
  const radio = q(`input[type="radio"][name$="-practitioner-${KEY}"][value="off"]`) as HTMLInputElement;
  expect(radio).toBeTruthy();
  await act(async () => radio.click());
}
async function review() {
  await act(async () => button(/^Review changes/)!.click());
}

describe("Codex 4582227072: the review lists the stored choices, separately from effective access", () => {
  it("an inert change (effective access unchanged) shows under its own heading", async () => {
    await mount({ previewSave: async () => inertPreview });
    await chooseOff();
    await review();
    const panel = q('[data-testid="review-saved-choices"]');
    expect(panel?.textContent ?? "").toContain("Saved choices");
    expect(panel?.textContent ?? "").toContain("After a setting is released, a choice that lowers access applies at once, and one that raises access waits for you to activate it.");
    expect(panel?.textContent ?? "").not.toMatch(/until they are released and you activate/i);
    expect(q(`[data-saved-choice="practitioner:${KEY}"]`)?.textContent ?? "").toMatch(/Whole studio to Off/);
  });

  it("an effective-access change still shows in its own section, beside the saved choices", async () => {
    await mount({ previewSave: async () => effectivePreview });
    await chooseOff();
    await review();
    expect(q('[data-review-role="practitioner"]')?.textContent ?? "").toMatch(/1 lose access/);
    expect(q('[data-testid="review-saved-choices"]')).toBeTruthy();
  });
});

describe("Codex 4582227075: a failed preview leaves a retry path", () => {
  it("refused, then rejected, then a retry that succeeds: the draft is kept throughout and Save becomes available", async () => {
    const previewSave = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, error: { code: "unexpected" as const } })
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(inertPreview);
    await mount({ previewSave });
    await chooseOff();

    await review(); // refused
    expect(q('[data-testid="roles-review"]')).toBeNull(); // not stuck on "checking"
    expect(q('[role="alert"]')?.textContent ?? "").not.toBe("");
    expect(button(/^Review changes/)!.disabled).toBe(false);
    expect((q(`input[type="radio"][name$="-practitioner-${KEY}"][value="off"]`) as HTMLInputElement).checked).toBe(true); // draft kept

    await review(); // rejected
    expect(q('[data-testid="roles-review"]')).toBeNull();
    expect(q('[role="alert"]')?.textContent ?? "").toMatch(/could not check|try Review changes again/i);
    expect(button(/^Review changes/)!.disabled).toBe(false);
    expect((q(`input[type="radio"][name$="-practitioner-${KEY}"][value="off"]`) as HTMLInputElement).checked).toBe(true);

    await review(); // succeeds
    expect(previewSave).toHaveBeenCalledTimes(3);
    expect(q('[data-testid="roles-review"]')).toBeTruthy();
    expect(q('[data-testid="roles-review"]')!.textContent).not.toMatch(/Checking what these changes/);
    expect(button(/Save changes/)).toBeTruthy();
  });
});

// Codex 4582593018: changing a value and changing it back must leave the draft clean. The saved policy holds no stored value for the key (the
// studio is on the basis), so the draft's explicit basis value after the revert is the SAME choice and must not count as an unsaved change.
describe("Codex 4582593018: change and revert is not an unsaved change", () => {
  const stateNoStored = parseState({
    ok: true,
    version: 7,
    basis: "existing_snapshot",
    gates: {},
    roles: { practitioner: { [KEY]: { stored: null, effective: "studio", source: "snapshot" } }, receptionist: {} },
  })!;
  const radio = (v: string) => q(`input[type="radio"][name$="-practitioner-${KEY}"][value="${v}"]`) as HTMLInputElement;
  const beforeUnloadPrevented = () => {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };

  it("clean after off then back to studio: Review is disabled-because-nothing-changed, no (unsaved) marker, no navigation warning", async () => {
    await mount({ policies: stateNoStored.policies, previewSave: async () => inertPreview });
    expect(button(/^Review changes/)!.disabled).toBe(true);
    expect(beforeUnloadPrevented()).toBe(false);

    await act(async () => radio("off").click());
    expect(button(/^Review changes/)!.disabled).toBe(false); // really dirty
    expect(host!.textContent).toContain("(unsaved)");
    expect(beforeUnloadPrevented()).toBe(true);

    await act(async () => radio("studio").click());
    expect(radio("studio").checked).toBe(true);
    expect(button(/^Review changes/)!.disabled).toBe(true); // clean again
    expect(host!.textContent).not.toContain("(unsaved)");
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("after a revert there is nothing to review: the preview is never requested", async () => {
    const previewSave = vi.fn(async () => inertPreview);
    await mount({ policies: stateNoStored.policies, previewSave });
    await act(async () => radio("off").click());
    await act(async () => radio("studio").click());
    expect(button(/^Review changes/)!.disabled).toBe(true);
    expect(previewSave).not.toHaveBeenCalled();
  });
});
