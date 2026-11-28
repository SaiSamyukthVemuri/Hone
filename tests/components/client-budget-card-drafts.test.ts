// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// HON-130 out-of-family threads on #1879: (5) a budget reset must not re-autosave after a discard; (17) "Use theirs" must not lose the local version.
const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { ClientBudgetCard } = await import("@/components/client-budget-card");
const { endIdentity } = await import("@/lib/note-drafts/draft-registry");

const C = "33333333-3333-4333-8333-333333333333";
const G1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const G2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const key = { clientId: C, kind: "budget" as const, target: "current" };
afterEach(() => endIdentity());

async function mount(draft: unknown, save: (i: unknown) => Promise<unknown>, discard: () => Promise<{ ok: boolean }> = async () => ({ ok: true })) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(ClientBudgetCard, {
        clientId: C, initial: { budgetLevel: null, budgetNotes: "" }, action: async () => ({ ok: true as const }),
        draft: draft as never, draftActions: { scope: "p:s", save: save as never, discard: discard as never, peek: async () => ({ ok: true, draft: null }) },
      }),
    ),
  );
  return { host, root };
}
const btn = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLElement | undefined;

describe("thread 5: a discard does not start an autosave", () => {
  it("discarding a draft that had a level resets the chip and sends NOTHING; a real chip press afterwards DOES autosave", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => ({ status: "ok", revision: 3, savedAt: "t", generation: G1 }));
    const stored = { key, fields: { budget_level: "somewhat_limited", budget_notes: "n" }, revision: 2, savedAt: "t", generation: G1 };
    const { host, root } = await mount(stored, save);
    await act(async () => { btn(host, "Discard draft")?.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(save).not.toHaveBeenCalled(); // the reset moved the chip, which is not a typed change
    await act(async () => { btn(host, "No stated limit")?.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(save).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await act(async () => root.unmount());
  });
});

describe("thread 17: Use theirs keeps the local version recoverable", () => {
  it("after Use theirs the person's own version stays on screen until dismissed", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => ({ status: "conflict", revision: 4, fields: { budget_level: "no_stated_limit", budget_notes: "THEIR NOTES" }, savedAt: "t", generation: G2 }));
    const { host, root } = await mount(null, save);
    const area = host.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(area, "MY LOCAL NOTES");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    await act(async () => { btn(host, "Use theirs")?.click(); });
    await act(async () => { [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Use theirs").pop()?.click(); }); // confirm
    const kept = host.querySelector('[data-testid="budget-draft-your-version"]');
    expect(kept?.textContent).toContain("MY LOCAL NOTES");
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("THEIR NOTES");
    await act(async () => { (btn(host, "Dismiss"))?.click(); });
    expect(host.querySelector('[data-testid="budget-draft-your-version"]')).toBeNull();
    vi.useRealTimers();
    await act(async () => root.unmount());
  });
});

describe("sign-out ends the draft identity", () => {
  it.each(["app/(app)/AccountMenu.tsx", "app/(app)/MobileMenu.tsx"])("%s calls endIdentity() in the sign-out form's onSubmit (not an onClick)", (file) => {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    expect(src).toMatch(/endIdentity\(\)/);
    // Inside the hidden sign-out form's onSubmit handler (SIGNOUT-01: the form submits natively, no onClick), after the handler opens.
    const i = src.indexOf("onSubmit={");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 900)).toContain("endIdentity()");
    expect(src).not.toMatch(/onClick=\{[^}]*endIdentity/);
  });
});
