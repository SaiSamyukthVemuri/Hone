// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  save: vi.fn(),
  enable: vi.fn(),
  refresh: vi.fn(),
  guard: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh }),
}));
vi.mock("@/components/settings/unsaved-changes", () => ({
  useUnsavedChangesGuard: (...a: unknown[]) => h.guard(...a),
}));
vi.mock("@/app/(app)/settings/payments/cancellation-fee-actions", () => ({
  saveCancellationFeeRulesAction: h.save,
  setCancellationFeeRulesEnabledAction: h.enable,
}));
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CancellationFeeRulesCard: Card } = await import(
  "@/app/(app)/settings/payments/CancellationFeeRulesCard"
);
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const hash = "a".repeat(64);
const rules = {
  revision: 1,
  enabled: false,
  notice_hours: 48,
  notice_mode: "percent" as const,
  notice_value: 5000,
  same_day_mode: "percent" as const,
  same_day_value: 10000,
  policy_snapshot_hash: hash,
};
const roots: ReturnType<typeof createRoot>[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  h.save.mockResolvedValue({ ok: true, rules });
  h.enable.mockResolvedValue({
    ok: true,
    rules: { ...rules, revision: 2, enabled: true },
  });
});
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => r.unmount());
  document.body.replaceChildren();
});
async function mount(initial: typeof rules | null = null, available = true) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const props = {
    initial,
    policyText: "Less than 48 hours: 50%. Same-day: 100%.",
    policyHash: hash,
    currency: "CAD" as const,
    status: "Off",
    available,
  };
  const render = async (next = props) =>
    act(async () => root.render(createElement(Card, next)));
  await render();
  return {
    host,
    render,
    props,
    input: (id: string) => host.querySelector<HTMLInputElement>(`#${id}`)!,
    toggle: () => host.querySelector<HTMLButtonElement>('[role="switch"]')!,
    submit: () =>
      host.querySelector<HTMLButtonElement>('button[type="submit"]')!,
  };
}
async function text(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("shows two independent rates, defaults to 48 hours and OFF, and never saves on mount", async () => {
  const m = await mount();
  expect(m.input("cancellation-notice-hours").value).toBe("48");
  expect(m.toggle().getAttribute("aria-checked")).toBe("false");
  expect(m.toggle().disabled).toBe(true);
  expect(m.host.textContent).toContain("Same-day cancellation");
  expect(h.save).not.toHaveBeenCalled();
  expect(h.enable).not.toHaveBeenCalled();
});
it("requires policy review, saves 50/100 separately and keeps the fee off until confirmed", async () => {
  const m = await mount();
  await text(m.input("notice-rate-value"), "50");
  await text(m.input("same-rate-value"), "100");
  expect(m.submit().disabled).toBe(true);
  await act(async () =>
    m.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await act(async () => m.submit().click());
  expect(h.save).toHaveBeenCalledExactlyOnceWith({
    expectedRevision: 0,
    noticeHours: 48,
    noticeMode: "percent",
    noticeValue: 5000,
    sameDayMode: "percent",
    sameDayValue: 10000,
    policyHash: hash,
    policyReviewed: true,
  });
  expect(h.enable).not.toHaveBeenCalled();
  expect(m.toggle().getAttribute("aria-checked")).toBe("false");
  await act(async () => m.toggle().click());
  expect(m.host.textContent).toContain("50% with less than 48 hours");
  expect(m.host.textContent).toContain("100% on the same day");
  expect(h.enable).not.toHaveBeenCalled();
  await act(async () =>
    m.host
      .querySelector<HTMLButtonElement>(
        '[data-testid="confirm-dialog-confirm"]',
      )!
      .click(),
  );
  expect(h.enable).toHaveBeenCalledExactlyOnceWith({
    expectedRevision: 1,
    enabled: true,
  });
  expect(m.host.textContent).not.toMatch(/\bActive\b/); // wait for server-derived readiness
});
it("never enables a dirty rule and preserves drafts when another tab refreshes settings", async () => {
  const m = await mount(rules);
  await text(m.input("notice-rate-value"), "25");
  expect(m.toggle().disabled).toBe(true);
  await m.render({
    ...m.props,
    initial: { ...rules, revision: 3, notice_value: 6000 },
  });
  expect(m.input("notice-rate-value").value).toBe("25");
  expect(h.guard).toHaveBeenLastCalledWith("cancellation-fee-tiers", true);
});
it("an unavailable schema or changed policy cannot activate fees", async () => {
  const m = await mount(rules, false);
  expect(m.toggle().disabled).toBe(true);
  expect(m.host.querySelector("form")).toBeNull();
  await m.render({ ...m.props, available: true, policyHash: "b".repeat(64) });
  expect(m.toggle().disabled).toBe(true);
});
it("a refused enable keeps OFF and shows the failure", async () => {
  const m = await mount(rules);
  h.enable.mockResolvedValue({ ok: false, error: "Changed elsewhere" });
  await act(async () => m.toggle().click());
  await act(async () =>
    m.host
      .querySelector<HTMLButtonElement>(
        '[data-testid="confirm-dialog-confirm"]',
      )!
      .click(),
  );
  expect(m.toggle().getAttribute("aria-checked")).toBe("false");
  expect(m.host.textContent).toContain("Changed elsewhere");
});
