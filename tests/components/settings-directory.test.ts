// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SettingsDirectory } from "@/components/settings/settings-directory";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/components/pending-link", () => ({
  PendingLink: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));

it("opens matching controls directly and restores all categories and focus when cleared", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  document.body.append(host);
  try {
    act(() => root.render(createElement(SettingsDirectory, { sections: [
      { name: "Services & machines", links: [{ href: "/settings/services", label: "Services", keywords: "Service colour picker" }] },
      { name: "Booking & availability", links: [{
        href: "/settings/availability", label: "Availability", keywords: "Holiday hours",
        controls: [{ href: "/settings/availability#special-hours", label: "Special hours", keywords: "Holiday hours" }],
      }] },
    ] })));
    const search = (value: string) => {
      const input = host.querySelector("input")!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    expect(host.textContent).toContain("Services & machines");
    expect(host.querySelector('a[href*="#"]')).toBeNull();
    search("holiday hours");
    expect(Array.from(host.querySelectorAll("a"), (a) => a.getAttribute("href"))).toEqual(["/settings/availability#special-hours"]);
    expect(host.textContent).not.toContain("Services & machines");
    search("availability");
    expect(Array.from(host.querySelectorAll("a"), (a) => a.getAttribute("href"))).toEqual(["/settings/availability"]);
    for (const term of ["service colors", "service colours", "colour picker"]) {
      search(term);
      expect(Array.from(host.querySelectorAll("a"), (a) => a.getAttribute("href"))).toEqual(["/settings/services"]);
      expect(host.querySelector('[role="status"]')?.textContent).toBe("1 matching setting");
    }
    search("nothing like this");
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/No settings match/);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!.click());
    expect(document.activeElement).toBe(host.querySelector("input"));
    expect(host.querySelectorAll("a")).toHaveLength(2);
    expect(host.textContent).toContain("Services & machines");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
