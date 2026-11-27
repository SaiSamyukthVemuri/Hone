// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// HON-109, Codex P2 x2: the form must show what is APPLIED after every navigation, and a cancelled native navigation must not lock it.
const nav = { path: "/financials/analytics/clients", search: "" };
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { PendingGetForm, PendingSubmit } from "@/components/pending-get-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

const form = (native: boolean) =>
  createElement(PendingGetForm, { action: "/x", native } as never, createElement("select", { name: "period", defaultValue: "month_to_date" }, createElement("option", { value: "month_to_date" }, "Month to date"), createElement("option", { value: "previous_month" }, "Previous month")), createElement(PendingSubmit, { children: "Show" }));
const tree = (native = false) =>
  createElement(PathnameContext.Provider, { value: nav.path }, createElement(SearchParamsContext.Provider, { value: new URLSearchParams(nav.search) as never }, form(native)));
const select = () => host.querySelector("select") as HTMLSelectElement;
const button = () => host.querySelector("button") as HTMLButtonElement;
const choose = (v: string) => { select().value = v; };

describe("every navigation resets unsubmitted filter edits", () => {
  // The kinds of navigation Clients offers: sort header, chip, page link, series/tab, back/forward (all change the applied address).
  const kinds: [string, string][] = [
    ["sort header", "sort=visits"],
    ["chip", "chip=no_next_booking"],
    ["page link", "page=2"],
    ["sort and page together", "sort=visits&page=3"],
    ["series toggle", "series=visits"],
    ["Back to the bare address", ""],
  ];
  for (const [kind, search] of kinds) {
    it(`${kind}: an edited-but-unsubmitted Period shows the applied one again`, () => {
      nav.search = kind === "Back to the bare address" ? "page=2" : "";
      act(() => root.render(tree()));
      choose("previous_month");
      expect(select().value).toBe("previous_month");
      nav.search = search;
      act(() => root.render(tree()));
      expect(select().value, kind).toBe("month_to_date");
    });
  }
  it("a re-render at the SAME address does not discard what the person is choosing", () => {
    nav.search = "sort=visits";
    act(() => root.render(tree()));
    choose("previous_month");
    act(() => root.render(tree()));
    expect(select().value).toBe("previous_month");
  });
});

describe("a cancelled native navigation does not lock the form", () => {
  const submit = () => act(() => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  it("Escape clears the pending state", () => {
    act(() => root.render(tree(true))); submit();
    expect(button().disabled).toBe(true);
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(button().disabled).toBe(false);
  });
  it("an edit inside the form clears it", () => {
    act(() => root.render(tree(true))); submit();
    expect(button().disabled).toBe(true);
    act(() => { select().dispatchEvent(new Event("input", { bubbles: true })); });
    expect(button().disabled).toBe(false);
  });
  it("it clears by itself after the timeout (Stop button: no event reaches the page)", () => {
    vi.useFakeTimers();
    act(() => root.render(tree(true))); submit();
    expect(button().disabled).toBe(true);
    act(() => { vi.advanceTimersByTime(15_001); });
    expect(button().disabled).toBe(false);
  });
  it("a second submit is not swallowed", () => {
    act(() => root.render(tree(true)));
    const first = new Event("submit", { bubbles: true, cancelable: true });
    act(() => { host.querySelector("form")!.dispatchEvent(first); });
    const second = new Event("submit", { bubbles: true, cancelable: true });
    act(() => { host.querySelector("form")!.dispatchEvent(second); });
    expect(second.defaultPrevented).toBe(false);
  });
});
