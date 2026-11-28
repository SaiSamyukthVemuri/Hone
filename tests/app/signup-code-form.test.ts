// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SignupForm } from "@/app/signup/SignupForm";
const h = vi.hoisted(() => ({ start: vi.fn(), confirm: vi.fn() }));
vi.mock("@/app/signup/actions", () => ({
  startOwnerSignIn: h.start,
  confirmOwnerCode: h.confirm,
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(vi.clearAllMocks);
it("keeps the Studio tier while an owner requests, retries, and submits the emailed code", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(createElement(SignupForm, { plan: "studio" })),
    );
    expect(host.textContent).toContain("US$99/month");
    const fill = (input: HTMLInputElement, value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const submit = () =>
      act(async () => {
        host
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
      });
    h.start.mockResolvedValue({ ok: true });
    fill(host.querySelector('input[type="email"]')!, "owner@example.test");
    await submit();
    expect(h.start).toHaveBeenCalledWith("studio", "owner@example.test");
    h.confirm.mockResolvedValue({ ok: false, error: "That code expired." });
    fill(host.querySelector('input[autocomplete="one-time-code"]')!, "123456");
    await submit();
    expect(host.textContent).toContain("That code expired.");
    expect(h.confirm).toHaveBeenCalledWith(
      "studio",
      "owner@example.test",
      "123456",
    );
    expect(host.querySelector("select")).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
