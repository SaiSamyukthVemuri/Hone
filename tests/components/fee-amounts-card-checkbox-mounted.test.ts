// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ enabled: vi.fn(), save: vi.fn(), refresh: vi.fn(), guard: vi.fn() }));
vi.mock("@/app/(app)/settings/payments/fee-settings-actions", () => ({
  setManualFeeEnabledAction: (...a: unknown[]) => h.enabled(...a),
  saveManualFeeRuleAction: (...a: unknown[]) => h.save(...a),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("@/components/settings/unsaved-changes", () => ({ useUnsavedChangesGuard: (...a: unknown[]) => h.guard(...a) }));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { FeeAmountsCard } = await import("@/app/(app)/settings/payments/FeeAmountsCard");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const type = (enabled: boolean) => ({ enabled, mode: "fixed" as const, percentBp: null, status: { saved: "Saved as off", effective: "Not active" } });
const saved = { enabled: false, mode: "fixed", cents: 5000, percentBp: null };
const roots: Array<ReturnType<typeof createRoot>> = [];
beforeEach(() => { vi.clearAllMocks(); h.enabled.mockReset().mockResolvedValue({ ok: true }); h.save.mockReset().mockResolvedValue({ ok: true }); });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); });

async function mount(currencyLabel: "CAD" | "USD" | null = "CAD") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host); roots.push(root);
  const props = { initialLateCancelCents: 5000, initialNoShowCents: null, lateCancel: type(false), noShow: type(false), currencyLabel };
  await act(async () => root.render(createElement(FeeAmountsCard, props)));
  const get = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`)!;
  const box = () => get<HTMLInputElement>("late-cancel-fee-enabled");
  const confirm = async () => { await act(async () => get("confirm-dialog-confirm").click()); };
  return { host, root, props, get, box, confirm };
}
async function typeValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("confirmation is required, and the next toggle uses the saved async result rather than re-reading the controlled input", async () => {
  let release!: (v: { ok: true }) => void;
  h.enabled.mockImplementationOnce(() => new Promise((r) => { release = r; }));
  const { box, confirm, get } = await mount();
  await act(async () => box().click());
  expect(h.enabled).not.toHaveBeenCalled();
  expect(get("confirm-dialog").textContent).toContain("$50.00 CAD");
  await confirm();
  expect(h.enabled).toHaveBeenLastCalledWith({ feeType: "late_cancel", enabled: true, expectedEnabled: false, expectedRule: saved });
  expect(box().checked).toBe(false);
  expect(get<HTMLButtonElement>("confirm-dialog-confirm").disabled).toBe(true);
  await act(async () => release({ ok: true }));
  expect(box().checked).toBe(true);
  await act(async () => box().click());
  expect(h.enabled).toHaveBeenLastCalledWith({ feeType: "late_cancel", enabled: false, expectedEnabled: true });
  expect(box().checked).toBe(false);
});

it("cancelling confirmation writes nothing; a refused enable leaves the saved switch off and shows the failure", async () => {
  const { box, get, confirm, host } = await mount();
  await act(async () => box().click());
  await act(async () => get("confirm-dialog-cancel").click());
  expect(h.enabled).not.toHaveBeenCalled();
  h.enabled.mockResolvedValue({ ok: false, error: "changed elsewhere" });
  await act(async () => box().click());
  await confirm();
  expect(box().checked).toBe(false);
  expect(host.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toContain("changed elsewhere");
});

it("mode changes stay local, keep independent drafts, and one Save rule never enables a fee or changes the other fee", async () => {
  const { get, box, host, root, props } = await mount();
  await act(async () => get("late-cancel-fee-mode-percent").click());
  await typeValue(get("late-cancel-fee-percent"), "75");
  await act(async () => get("late-cancel-fee-mode-fixed").click());
  expect(get<HTMLInputElement>("late-cancel-fee-amount").value).toBe("50.00");
  await act(async () => get("late-cancel-fee-mode-percent").click());
  expect(get<HTMLInputElement>("late-cancel-fee-percent").value).toBe("75");
  expect(h.save).not.toHaveBeenCalled();
  expect(box().disabled).toBe(true);
  await act(async () => get("late-cancel-fee-save").click());
  expect(h.save).toHaveBeenCalledExactlyOnceWith({ feeType: "late_cancel", mode: "percent", valueText: "75", expected: saved });
  expect(h.enabled).not.toHaveBeenCalled();
  expect(box().checked).toBe(false);
  expect(host.textContent).toContain("Rule saved. The fee is still off.");
  // Revalidation with the new saved rule preserves an independent no-show draft.
  await act(async () => get("no-show-configure").click());
  await typeValue(get("no-show-fee-amount"), "25");
  await act(async () => root.render(createElement(FeeAmountsCard, { ...props, lateCancel: { ...props.lateCancel, mode: "percent", percentBp: 7500 } })));
  expect(get<HTMLInputElement>("no-show-fee-amount").value).toBe("25");
});

it("invalid text is quiet until submit, keeps the draft on refusal, and a failed request does not claim success", async () => {
  const { get, host } = await mount();
  await typeValue(get("late-cancel-fee-amount"), "999");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => get("late-cancel-fee-save").click());
  expect(h.save).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("$200.00");
  await typeValue(get("late-cancel-fee-amount"), "25");
  h.save.mockResolvedValue({ ok: false, error: "changed elsewhere" });
  await act(async () => get("late-cancel-fee-save").click());
  expect(get<HTMLInputElement>("late-cancel-fee-amount").value).toBe("25");
  expect(host.textContent).toContain("changed elsewhere");
  expect(host.textContent).not.toContain("Rule saved.");
});

it("an unconfigured no-show is collapsed; unknown currency cannot save or enable fixed amounts", async () => {
  const { get, box, host } = await mount(null);
  expect(get("no-show-fee-amount")).toBeNull();
  await act(async () => get("no-show-configure").click());
  expect(get<HTMLInputElement>("no-show-fee-amount").value).toBe("");
  await typeValue(get("late-cancel-fee-amount"), "25");
  await act(async () => get("late-cancel-fee-save").click());
  expect(h.save).not.toHaveBeenCalled();
  expect(box().disabled).toBe(true);
  expect(host.textContent).toContain("Confirm your studio's payment currency");
});

it("saving a rule does not optimistically claim charging is active while server availability is unconfirmed", async () => {
  const { box, confirm, get } = await mount();
  await act(async () => box().click()); await confirm();
  expect(get("late-cancel-fee-enabled-status").textContent).toContain("Checking availability");
  expect(get("late-cancel-fee-enabled-status").textContent).not.toContain("Active.");
});

it("a new server snapshot updates the saved switch and keeps the owner's unfinished draft", async () => {
  const { root, props, get, box, host } = await mount();
  await typeValue(get("late-cancel-fee-amount"), "30");
  await act(async () => root.render(createElement(FeeAmountsCard, {
    ...props, initialLateCancelCents: 2500,
    lateCancel: { ...props.lateCancel, enabled: true, status: { saved: "Saved as on", effective: "Not active: payments are not ready" } },
  })));
  expect(box().checked).toBe(true);
  expect(get<HTMLInputElement>("late-cancel-fee-amount").value).toBe("30");
  expect(host.textContent).toContain("Your unsaved edits are preserved");
  expect(get("late-cancel-fee-enabled-status").textContent).toContain("payments are not ready");
  await act(async () => get("late-cancel-fee-save").click());
  expect(h.save).toHaveBeenLastCalledWith({ feeType: "late_cancel", mode: "fixed", valueText: "30", expected: { ...saved, enabled: true, cents: 2500 } });
  expect(h.enabled).not.toHaveBeenCalled();
});

it("a new server rule replaces a clean draft instead of leaving an out-of-date saved value", async () => {
  const { root, props, get, box } = await mount();
  await act(async () => root.render(createElement(FeeAmountsCard, {
    ...props, initialLateCancelCents: 2500, lateCancel: { ...props.lateCancel, enabled: true },
  })));
  expect(box().checked).toBe(true);
  expect(get<HTMLInputElement>("late-cancel-fee-amount").value).toBe("25.00");
  expect(get<HTMLButtonElement>("late-cancel-fee-save").disabled).toBe(true);
});

it.each(["fixed", "percent"] as const)("saving the other calculation preserves an edited %s draft through the server refresh", async (draftMode) => {
  const { root, props, get, box, host } = await mount();
  const startProps = { ...props, lateCancel: { ...props.lateCancel, mode: draftMode, percentBp: 7500 } };
  await act(async () => root.render(createElement(FeeAmountsCard, startProps)));
  const draftTestId = `late-cancel-fee-${draftMode === "fixed" ? "amount" : "percent"}`;
  const draftText = draftMode === "fixed" ? "30" : "60";
  const saveMode: "fixed" | "percent" = draftMode === "fixed" ? "percent" : "fixed";
  await typeValue(get(draftTestId), draftText);
  await act(async () => get(`late-cancel-fee-mode-${saveMode}`).click());
  await typeValue(get(`late-cancel-fee-${saveMode === "fixed" ? "amount" : "percent"}`), saveMode === "fixed" ? "25" : "80");
  await act(async () => get("late-cancel-fee-save").click());
  expect(h.save).toHaveBeenCalledTimes(1);
  expect(box().checked).toBe(false);
  expect(h.enabled).not.toHaveBeenCalled();
  // The successful save refreshes only the submitted mode/value. The hidden draft was never submitted.
  const newProps = { ...startProps, initialLateCancelCents: saveMode === "fixed" ? 2500 : 5000,
    lateCancel: { ...startProps.lateCancel, mode: saveMode, percentBp: saveMode === "percent" ? 8000 : 7500 } };
  await act(async () => root.render(createElement(FeeAmountsCard, newProps)));
  const lateGuardCalls = h.guard.mock.calls.filter(([key]) => key === "payment-fees-late-cancel");
  const refreshedText = host.textContent;
  expect(get<HTMLButtonElement>("late-cancel-fee-save").disabled).toBe(true);
  await act(async () => get(`late-cancel-fee-mode-${draftMode}`).click());
  expect(get<HTMLInputElement>(draftTestId).value).toBe(draftText);
  expect(lateGuardCalls.at(-1)).toEqual(["payment-fees-late-cancel", true]);
  expect(refreshedText).toContain(`Your ${draftMode === "fixed" ? "fixed amount" : "percentage"} draft is unsaved.`);
  expect(get<HTMLButtonElement>("late-cancel-fee-save").disabled).toBe(false);
  expect(h.save).toHaveBeenCalledTimes(1);
});

it("formatting an unchanged amount does not leave a navigation warning with no saveable change", async () => {
  const { get } = await mount();
  await typeValue(get("late-cancel-fee-amount"), "50.0");
  expect(get<HTMLButtonElement>("late-cancel-fee-save").disabled).toBe(true);
  const lateGuardCalls = h.guard.mock.calls.filter(([key]) => key === "payment-fees-late-cancel");
  expect(lateGuardCalls.at(-1)).toEqual(["payment-fees-late-cancel", false]);
});
