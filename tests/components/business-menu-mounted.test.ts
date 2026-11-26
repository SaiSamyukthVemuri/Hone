// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The real BusinessMenu, mounted. Only its two framework seams are stood in for: the pathname (a variable the test moves, as a
// committed navigation would) and the link (a plain anchor that records the click and never navigates, so a "slow page" is simply
// a pathname that has not changed YET).
const state = { path: "/dashboard" };
vi.mock("next/navigation", () => ({ usePathname: () => state.path }));
vi.mock("@/components/pending-link", () => ({
  PendingLink: ({ children, pendingLabel: _p, ...rest }: Record<string, unknown> & { children: unknown }) =>
    createElement(
      "a",
      { ...rest, onClick: (e: Event) => { e.preventDefault(); (rest.onClick as ((e: Event) => void) | undefined)?.(e); } },
      children as never,
    ),
}));

import { BusinessMenu } from "@/app/(app)/BusinessMenu";

let root: Root | null = null;
let host: HTMLElement | null = null;
let outside: HTMLButtonElement | null = null;

function mount() {
  host = document.createElement("div");
  outside = document.createElement("button");
  outside.textContent = "elsewhere";
  document.body.append(host, outside);
  root = createRoot(host);
  act(() => root!.render(createElement(BusinessMenu)));
}
const rerender = () => act(() => root!.render(createElement(BusinessMenu)));
const trigger = () => host!.querySelector<HTMLButtonElement>('[data-testid="nav-business"]')!;
const panel = () => host!.querySelector('[role="group"]');
const links = () => [...host!.querySelectorAll<HTMLAnchorElement>("a")];
const link = (label: string) => links().find((a) => a.textContent === label)!;
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
const key = (target: Element | Window, k: string) =>
  act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));

beforeEach(() => {
  state.path = "/dashboard";
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  outside?.remove();
  root = null;
  host = null;
  outside = null;
});

describe("the Business menu, mounted", () => {
  it("is closed to begin with, and the button opens it to exactly the three links", () => {
    mount();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();
    click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(links().map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Capacity", "/dashboard/capacity"],
      ["Statements", "/financials/statement"],
      ["Analytics", "/financials/analytics"],
    ]);
  });

  it("Escape closes it and returns focus to the button", () => {
    mount();
    click(trigger());
    link("Capacity").focus();
    key(window, "Escape");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("Tab out closes it: focus moving to something outside the menu", () => {
    mount();
    click(trigger());
    const last = link("Analytics");
    last.focus();
    act(() => void last.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside })));
    expect(panel()).toBeNull();
  });

  it("Analytics reads as the current page on its Overview, Clients and Print screens, and on nothing outside its subtree", () => {
    for (const path of ["/financials/analytics", "/financials/analytics/clients", "/financials/analytics/print"]) {
      state.path = path;
      mount();
      expect(trigger().getAttribute("aria-current"), path).toBe("page");
      click(trigger());
      expect(link("Analytics").getAttribute("aria-current"), path).toBe("page");
      expect(link("Statements").getAttribute("aria-current"), path).toBeNull();
      act(() => root?.unmount());
      host?.remove();
      outside?.remove();
    }
    state.path = "/financials/analytics-archive";
    mount();
    expect(trigger().getAttribute("aria-current")).toBeNull();
  });

  it("focus moving between the menu's own controls does NOT close it", () => {
    mount();
    click(trigger());
    act(() => void trigger().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: link("Capacity") })));
    expect(panel()).not.toBeNull();
  });

  it("a press outside closes it, and a press inside does not", () => {
    mount();
    click(trigger());
    act(() => void link("Capacity").dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(panel()).not.toBeNull();
    act(() => void outside!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(panel()).toBeNull();
  });

  it("choosing another page keeps the link mounted (so its Opening mark stays visible) until the navigation commits, then closes", () => {
    mount();
    click(trigger());
    click(link("Statements"));
    // THE SLOW PAGE: the click has happened, the pathname has not changed yet. The link that carries the acknowledgement is still
    // there. Closing on the click (the earlier behaviour) unmounted it and left the owner with no feedback.
    expect(panel()).not.toBeNull();
    expect(link("Statements")).toBeTruthy();
    // The navigation commits.
    state.path = "/financials/statement";
    rerender();
    expect(panel()).toBeNull();
    expect(trigger().getAttribute("aria-current")).toBe("page");
  });

  it("choosing the page you are already on closes it at once, since the path will never change", () => {
    state.path = "/dashboard/capacity";
    mount();
    click(trigger());
    expect(link("Capacity").getAttribute("aria-current")).toBe("page");
    click(link("Capacity"));
    expect(panel()).toBeNull();
  });

  it("does not pop open by itself when you come back to the page it was opened on (Back)", () => {
    mount();
    click(trigger());
    click(link("Capacity"));
    state.path = "/dashboard/capacity";
    rerender();
    expect(panel()).toBeNull();
    // Back: the pathname returns to where the menu was opened. It must still be closed.
    state.path = "/dashboard";
    rerender();
    expect(panel()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });
});
