// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RecipientChooser } from "@/components/waitlist/recipient-chooser";
import type { Candidate } from "@/lib/waitlist/recipient-chooser";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Real events against the mounted component: the wiring, not just the reducer.
const many = (n: number): Candidate[] => Array.from({ length: n }, (_, i) => ({ entryId: `e${i}`, name: `Person ${i}` }));
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});
function mount(n: number, props: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement("form", null, createElement(RecipientChooser, { candidates: many(n), ...props }))));
  return host;
}
const typeInto = (el: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
const button = (h: HTMLElement, label: RegExp) => [...h.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""))!;
const posted = (h: HTMLElement) => [...h.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="entryId"]')].map((i) => i.value);

describe("RecipientChooser, mounted", () => {
  it("Enter in the search box is default-prevented, so it can never submit the form", () => {
    const h = mount(20);
    const search = h.querySelector<HTMLInputElement>('input[type="search"]')!;
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => void search.dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(true);
    const other = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    act(() => void search.dispatchEvent(other));
    expect(other.defaultPrevented).toBe(false);
  });
  it("Select all N matching posts every FILTERED id, not just the visible page", () => {
    const h = mount(300);
    typeInto(h.querySelector<HTMLInputElement>('input[type="search"]')!, "1");
    const expected = many(300).filter((c) => c.name.includes("1")).map((c) => c.entryId);
    expect(expected.length).toBeGreaterThan(50);
    expect(h.querySelectorAll('li input[type="checkbox"]')).toHaveLength(50);
    click(button(h, new RegExp(`Select all ${expected.length} matching`)));
    const ids = posted(h);
    expect(ids.sort()).toEqual([...expected].sort());
    expect(h.querySelector('[data-testid="chooser-count"]')!.textContent).toContain(`${expected.length} selected in all`);
  });
  it("Select this page selects only the visible page, and the selection survives going to the next page", () => {
    const h = mount(120);
    click(button(h, /Select this page/));
    expect(posted(h)).toHaveLength(50);
    click(button(h, /^Next$/));
    expect(h.querySelectorAll('li input[type="checkbox"]:checked')).toHaveLength(0);
    expect(posted(h)).toHaveLength(50);
    click(button(h, /Select all 120 listed/));
    expect(posted(h)).toHaveLength(120);
  });
  it("browsing and selecting never submit the form", () => {
    const h = mount(120);
    let submitted = 0;
    h.querySelector("form")!.addEventListener("submit", (e) => {
      submitted += 1;
      e.preventDefault();
    });
    for (const label of [/Select this page/, /Clear this page/, /Select all 120 listed/, /Clear everything/, /^Next$/]) click(button(h, label));
    expect(submitted).toBe(0);
  });
});
