// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enabled: vi.fn(),
  mode: vi.fn(),
  percent: vi.fn(),
}));
vi.mock("@/app/(app)/settings/payments/fee-settings-actions", () => ({
  setManualFeeEnabledAction: (...a: unknown[]) => h.enabled(...a),
  setManualFeeModeAction: (...a: unknown[]) => h.mode(...a),
  setManualFeePercentAction: (...a: unknown[]) => h.percent(...a),
}));
vi.mock("@/app/(app)/settings/payments/fee-amounts-actions", () => ({ updateStudioFeeAmountsAction: vi.fn() }));
vi.mock("@/components/settings/unsaved-changes", () => ({ useUnsavedChangesGuard: () => {} }));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { FeeAmountsCard } = await import("@/app/(app)/settings/payments/FeeAmountsCard");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const type = (enabled: boolean) => ({ enabled, mode: "fixed" as const, percentBp: null, status: { saved: "Saved as off", effective: "Not active" } });
beforeEach(() => { h.enabled.mockReset(); h.mode.mockReset(); h.percent.mockReset(); });

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(FeeAmountsCard, { initialLateCancelCents: 5000, initialNoShowCents: null, lateCancel: type(false), noShow: type(false), currencyLabel: "CAD" }));
  });
  const box = () => host.querySelector<HTMLInputElement>('[data-testid="late-cancel-fee-enabled"]')!;
  return { host, root, box };
}

it("the checkbox shows the value that was saved, and the next save sends it as expectedEnabled (no re-read after the await)", async () => {
  let release!: (v: { ok: true }) => void;
  h.enabled.mockImplementationOnce(() => new Promise((r) => { release = r; }));
  h.enabled.mockResolvedValue({ ok: true });
  const { root, box } = await mount();
  try {
    expect(box().checked).toBe(false);
    // toggle ON; the save is still in flight
    await act(async () => { box().click(); });
    expect(h.enabled).toHaveBeenLastCalledWith({ feeType: "late_cancel", enabled: true, expectedEnabled: false });
    // the save resolves AFTER React has restored the controlled box to the old value
    await act(async () => { release({ ok: true }); });
    expect(box().checked).toBe(true);
    // toggle OFF: the request must say we are changing from ON (the value that was saved), to OFF
    await act(async () => { box().click(); });
    expect(h.enabled).toHaveBeenLastCalledWith({ feeType: "late_cancel", enabled: false, expectedEnabled: true });
    expect(box().checked).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

it("a refused save leaves the box at the saved value", async () => {
  h.enabled.mockResolvedValue({ ok: false, error: "changed elsewhere" });
  const { root, box } = await mount();
  try {
    await act(async () => { box().click(); });
    expect(box().checked).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});
