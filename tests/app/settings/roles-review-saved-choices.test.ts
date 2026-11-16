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
const HASH = "ab".repeat(32);
// The table is the DATABASE's. It deliberately disagrees with the page's own saved state (saved: Whole studio; table says the owner was shown Own
// assigned) to prove the page prints the table and derives nothing.
const row = (timing: string) => ({ role: "practitioner" as const, key: KEY, label: "Cancel appointments", storedBefore: null, shownBefore: "own" as const, requested: "off" as const, storedAfter: "off" as const, written: true, effectiveBefore: "studio" as const, effectiveAfter: "studio" as const, timing });
const withTable = (timing: string, roles: unknown[] = [{ role: "practitioner" as const, diff: emptyDiff, people: [], count: 0, storedRemoved: [] }]) => ({
  ok: true as const,
  preview: { version: 7, roles, review: { version: 7, hash: HASH, rows: [row(timing)] } },
}) as never;
const inertPreview = withTable("not_released");

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
        version: 0,
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
    expect(panel?.textContent ?? "").toContain("Each saved choice below says when it takes effect.");
    expect(panel?.textContent ?? "").not.toMatch(/until they are released and you activate/i);
    // the table's own values, not the page's saved state (Whole studio)
    const li = q(`[data-saved-choice="practitioner:${KEY}"]`)?.textContent ?? "";
    expect(li).toMatch(/Own assigned to Off/);
    expect(li).not.toMatch(/Whole studio to Off/);
    expect(li).toContain("Saved. This setting is not released yet, so it changes nothing today.");
  });

  it("an effective-access change still shows in its own section, beside the saved choices", async () => {
    const eff = { ...effectivePreview, preview: { ...effectivePreview.preview, review: { version: 7, hash: HASH, rows: [row("at_release")] } } };
    await mount({ previewSave: async () => eff as never });
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

describe("0356: the review is bound to the version the page was read at, and Save carries the reviewed hash", () => {
  it("the preview is requested for the page's version (7 here is the state's; the prop is what is sent)", async () => {
    const previewSave = vi.fn(async () => inertPreview);
    await mount({ version: 7, previewSave });
    await chooseOff();
    await review();
    expect(previewSave).toHaveBeenCalledWith({ practitioner: { [KEY]: "off" } }, 7);
  });

  it("Save sends the reviewed edits, the previewed version and the hash exactly as returned", async () => {
    const save = vi.fn(async () => ({ ok: true as const, newVersion: 8 }));
    const reload = vi.fn(async () => ({ ok: true as const, state: { ...state, version: 8 } }));
    await mount({ version: 7, previewSave: async () => inertPreview, save, reload });
    await chooseOff();
    await review();
    await act(async () => button(/Save changes/)!.click());
    expect(save).toHaveBeenCalledWith({ practitioner: { [KEY]: "off" } }, 7, false, "", HASH);
  });

  it("a stale page gets no summary: the draft is kept, the current policy is read, and the next review is for the NEW version", async () => {
    const previewSave = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, error: { code: "stale_version" as const, currentVersion: 9 } })
      .mockResolvedValueOnce(inertPreview);
    const reload = vi.fn(async () => ({ ok: true as const, state: { ...state, version: 9 } }));
    await mount({ version: 7, previewSave, reload });
    await chooseOff();
    await review();
    expect(q('[data-testid="roles-review"]')).toBeNull();
    expect(q('[role="alert"]')?.textContent ?? "").toMatch(/Someone changed these settings/);
    expect((q(`input[type="radio"][name$="-practitioner-${KEY}"][value="off"]`) as HTMLInputElement).checked).toBe(true);
    expect(reload).toHaveBeenCalled();
    await review();
    expect(previewSave).toHaveBeenLastCalledWith({ practitioner: { [KEY]: "off" } }, 9); // mutation: not rebasing the version leaves 7 here
  });

  it("review_changed at Save: nothing saved, back to the draft, a fresh review is required", async () => {
    const save = vi.fn(async () => ({ ok: false as const, error: { code: "review_changed" as const } }));
    await mount({ version: 7, previewSave: async () => inertPreview, save });
    await chooseOff();
    await review();
    await act(async () => button(/Save changes/)!.click());
    expect(q('[data-testid="roles-review"]')).toBeNull();
    expect(q('[role="alert"]')?.textContent ?? "").toMatch(/Review the changes again/);
    expect((q(`input[type="radio"][name$="-practitioner-${KEY}"][value="off"]`) as HTMLInputElement).checked).toBe(true);
    expect(button(/^Review changes/)!.disabled).toBe(false);
  });

  it("the reviewed command missing (review_unavailable) fails closed with a clear message, nothing saved", async () => {
    await mount({ version: 7, previewSave: async () => ({ ok: false as const, error: { code: "review_unavailable" as const } }) });
    await chooseOff();
    await review();
    expect(q('[data-testid="roles-review"]')).toBeNull();
    expect(q('[role="alert"]')?.textContent ?? "").toMatch(/Reviewing role changes is not available yet/);
  });

  it("each timing is worded from the table, and applies_on_save has its own wording", async () => {
    await mount({ previewSave: async () => withTable("applies_on_save") });
    await chooseOff();
    await review();
    expect(q(`[data-saved-choice="practitioner:${KEY}"]`)?.textContent ?? "").toContain("Takes effect as soon as you save it.");
    expect(q('[data-testid="review-saved-choices"]')?.textContent ?? "").not.toMatch(/waits for you to activate/i);
  });
});

// Codex 4585249966: change an unset key and change it back, then recover from a stale version. The draft must carry nothing for that key, so the
// other session's fresh choice survives; a genuine edit still rides on top. Both start from the server's one shown map, so this is plain equality.
describe("Codex 4585249966: stale-version recovery carries only genuine edits", () => {
  const B = "appt.mark_no_show";
  const unset = parseState({
    ok: true,
    version: 7,
    basis: "existing_snapshot",
    gates: {},
    roles: { practitioner: {}, receptionist: {} },
  })!;
  const fresh = parseState({
    ok: true,
    version: 9,
    basis: "existing_snapshot",
    gates: {},
    roles: { practitioner: { [KEY]: { stored: "own", effective: "own", source: "stored" } }, receptionist: {} },
  })!;
  const radio = (k: string, v: string) => q(`input[type="radio"][name$="-practitioner-${k}"][value="${v}"]`) as HTMLInputElement;

  it("change and revert, plus one genuine edit: after recovery the other session's value survives and the genuine edit is kept", async () => {
    const previewSave = vi.fn().mockResolvedValueOnce({ ok: false as const, error: { code: "stale_version" as const, currentVersion: 9 } });
    const reload = vi.fn(async () => ({ ok: true as const, state: { ...fresh, writable: true, notWritableReason: null } }));
    await mount({ policies: unset.policies, version: 7, previewSave, reload });
    await act(async () => radio(KEY, "off").click());
    await act(async () => radio(KEY, "studio").click()); // reverted: the shown value again
    await act(async () => radio(B, "off").click()); // a genuine edit
    expect(host!.textContent).toContain("(unsaved)");
    await review();
    expect(reload).toHaveBeenCalled();
    expect(radio(KEY, "own").checked).toBe(true); // the other session's choice was NOT overwritten by the reverted edit
    expect(radio(B, "off").checked).toBe(true); // the genuine edit rode on top
  });

  it("with no genuine edit at all, a reverted change is clean: Review stays disabled and nothing is carried", async () => {
    await mount({ policies: unset.policies, version: 7, previewSave: vi.fn() });
    await act(async () => radio(KEY, "off").click());
    await act(async () => radio(KEY, "studio").click());
    expect(button(/^Review changes/)!.disabled).toBe(true);
  });

  it("the saved policy is ONE normalised map: every catalog key has its shown value and the draft starts equal to it", () => {
    const v = unset.policies.practitioner.values as Record<string, string>;
    expect(v[KEY]).toBe("studio");
    expect(Object.keys(v).length).toBeGreaterThan(20);
  });
});
