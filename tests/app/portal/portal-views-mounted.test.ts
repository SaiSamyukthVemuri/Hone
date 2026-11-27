// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PortalViews } from "@/app/portal/PortalViews";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement;
let root: Root;
beforeEach(() => {
  history.replaceState(null, "", "/portal");
  Element.prototype.scrollIntoView = vi.fn();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
function mount() {
  act(() => root.render(createElement(PortalViews, { panels: {
    overview: { label: "Overview", body: createElement("a", { href: "/portal?view=records#portal-tasks", "data-portal-nav": true }, "Start forms") },
    records: { label: "Forms", body: createElement("section", { id: "portal-tasks" }, createElement("input", { id: "forms-to-sign", "aria-label": "Signature" })) },
  } })));
}
function press(text: string) {
  const el = [...host.querySelectorAll("a")].find(link => link.textContent === text)!;
  act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles:true, cancelable:true })); });
}
it("opens existing #forms-to-sign links, puts focus on the form, and preserves unsaved text when switching views", () => {
  history.replaceState(null, "", "/portal#forms-to-sign");
  mount();
  const field = host.querySelector<HTMLInputElement>("#forms-to-sign")!;
  expect(document.activeElement).toBe(field);
  field.value = "Sample client";
  press("Overview");
  expect(location.search).toBe("");
  expect(field.closest("[hidden]")).not.toBeNull();
  press("Start forms");
  expect(location.search).toBe("?view=records");
  expect(document.activeElement?.id).toBe("portal-tasks");
  expect(host.querySelector<HTMLInputElement>("#forms-to-sign")?.value).toBe("Sample client");
});
it("uses browser history and leaves the right navigation item current", () => {
  mount();
  press("Forms");
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe("Forms");
  history.replaceState(null, "", "/portal");
  act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe("Overview");
  expect(document.activeElement?.id).toBe("view-overview");
});
