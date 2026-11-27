// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// HON-124 item 11. The shared copy control: confirm only after the clipboard write succeeds; on failure (rejected write, permission
// refusal, or no clipboard API at all) say so and select the visible text. Reference control: the booking-link card.
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CopyButton } = await import("@/components/copy-button");
const { BookingLinkCard } = await import("@/app/(app)/settings/booking/BookingLinkCard");
const { copyText } = await import("@/lib/clipboard/copy-text");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounts: HTMLElement[] = [];
function render(el: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  mounts.push(host);
  act(() => createRoot(host).render(el));
  return host;
}
function setClipboard(v: unknown) {
  Object.defineProperty(navigator, "clipboard", { value: v, configurable: true });
}
const flush = async () => { await act(async () => { await Promise.resolve(); await new Promise((r) => requestAnimationFrame(() => r(null))); }); };
afterEach(() => { mounts.splice(0).forEach((m) => m.remove()); vi.restoreAllMocks(); setClipboard(undefined); });

describe("copyText", () => {
  it("true only after the write resolves; false for a rejection, a synchronous throw and a missing API", async () => {
    const w = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText: w });
    expect(await copyText("x")).toBe(true);
    expect(w).toHaveBeenCalledWith("x");
    setClipboard({ writeText: () => Promise.reject(new Error("denied")) });
    expect(await copyText("x")).toBe(false);
    setClipboard({ writeText: () => { throw new TypeError("sync"); } });
    expect(await copyText("x")).toBe(false);
    setClipboard(undefined);
    expect(await copyText("x")).toBe(false);
  });
});

describe("booking-link copy control (reference)", () => {
  const url = "https://hone.care/book/studio-one";
  it("success: 'Copied' appears only after the write, the confirmation is announced, and the accessible name says what is copied", async () => {
    let resolve!: () => void;
    setClipboard({ writeText: () => new Promise<void>((r) => { resolve = r; }) });
    const h = render(createElement(BookingLinkCard, { slug: "studio-one" }));
    const btn = h.querySelector("button")!;
    expect(btn.getAttribute("aria-label")).toBe("Copy booking link");
    await act(async () => { btn.click(); });
    expect(btn.textContent).toBe("Copy"); // pending: not confirmed yet
    await act(async () => { resolve(); await Promise.resolve(); });
    expect(btn.textContent).toBe("Copied");
    expect(h.querySelector('[role="status"]')?.textContent).toBe("Copied");
  });
  it.each([
    ["a rejected write", { writeText: () => Promise.reject(new Error("denied")) }],
    ["no clipboard API", undefined],
    ["a synchronous throw", { writeText: () => { throw new TypeError("x"); } }],
  ])("failure (%s): never says Copied, says so in a live region, and selects the visible link text", async (_n, cb) => {
    setClipboard(cb);
    const h = render(createElement(BookingLinkCard, { slug: "studio-one" }));
    const btn = h.querySelector("button")!;
    await act(async () => { btn.click(); });
    await flush();
    expect(btn.textContent).toBe("Copy");
    expect(h.querySelector('[role="status"]')?.textContent).toMatch(/Couldn’t copy/);
    const input = h.querySelector("input") as HTMLInputElement;
    expect(input.value).toContain("/book/studio-one");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });
  it("inline variant: failure selects the link text", async () => {
    setClipboard(undefined);
    const h = render(createElement(BookingLinkCard, { slug: "studio-one", variant: "inline" }));
    await act(async () => { h.querySelector("button")!.click(); });
    await flush();
    expect(window.getSelection()?.toString()).toContain("/book/studio-one");
    expect(h.textContent).toMatch(/Couldn’t copy/);
  });
});

describe("a value shown nowhere else is revealed on failure", () => {
  it("renders a read-only, selected field with the value", async () => {
    setClipboard(undefined);
    const h = render(createElement(CopyButton, { value: "https://hone.care/book/x", label: "Copy link", revealOnFail: true }));
    await act(async () => { h.querySelector("button")!.click(); });
    await flush();
    const f = h.querySelector("input[readonly]") as HTMLInputElement;
    expect(f.value).toBe("https://hone.care/book/x");
    expect(f.selectionEnd).toBe(f.value.length);
  });
});

describe("no copy site is left with a bare, throwable clipboard call", () => {
  const ROOT = path.resolve(__dirname, "../..");
  it("only the shared helper touches navigator.clipboard.writeText", () => {
    const files = [
      "app/(app)/settings/booking/BookingLinkCard.tsx", "app/(app)/dashboard/onboarding/OnboardingWizard.tsx", "app/(app)/settings/team/InviteForm.tsx",
      "app/(app)/settings/profile/CalendarFeedCard.tsx", "app/(app)/settings/import/QuickImport.tsx", "app/(app)/clients/[id]/PortalAccessCard.tsx",
      "app/(app)/clients/[id]/intake/IntakeHistoryList.tsx", "app/(app)/clients/[id]/intake/IntakeResendCard.tsx", "app/(app)/clients/[id]/intake/IntakeReissueCard.tsx",
    ];
    for (const f of files) expect(readFileSync(path.join(ROOT, f), "utf8"), f).not.toMatch(/navigator\.clipboard/);
  });
});
