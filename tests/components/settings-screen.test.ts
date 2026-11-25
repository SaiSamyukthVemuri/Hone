// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsShell } from "@/components/settings/settings-shell";

const router = { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() };
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => router,
}));
vi.mock("@/components/pending-link", () => ({
  PendingLink: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement("a", { href }, children),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let menu: HTMLButtonElement;
let pathname: string;

const view = {
  sections: [{ name: "Services & machines", links: [
    { href: "/settings/services", label: "Services", keywords: "service colour" },
    { href: "/settings/machines", label: "Machines", keywords: "machines" },
  ] }],
  studioName: "Test Studio", roleLabel: "Owner",
  children: createElement("input", { "aria-label": "Service name" }),
};

beforeEach(async () => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  pathname = "/settings/services";
  window.history.replaceState(null, "", pathname);
  await act(async () => root.render(createElement(SettingsShell, view)));
  menu = host.querySelector('button[aria-label="Settings menu"]')!;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

it("keeps the editor mounted while the mobile menu is open or closed", async () => {
  const input = host.querySelector("input")!;
  input.value = "Unsaved service name";
  await act(async () => menu.click());
  expect(menu.getAttribute("aria-expanded")).toBe("true");
  const popup = host.querySelector("dialog[open]")!;
  expect(popup.getAttribute("aria-label")).toBe("Settings menu");
  expect(popup.querySelector('a[href="/settings/services"]')).toBeTruthy();
  await act(async () => popup.querySelector("button")!.click());
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector("input")?.value).toBe("Unsaved service name");
  expect(host.querySelector('button[aria-label="Full screen"]')).toBeNull();
});

it("opens search with slash and leaves typing inside an editor alone", async () => {
  const slash = (target: EventTarget) => act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }));
  });
  await slash(host.querySelector("input")!);
  expect(host.querySelector("dialog[open]")).toBeNull();
  await slash(document);
  const dialog = host.querySelector("dialog[open]")!;
  expect(dialog.getAttribute("aria-label")).toBe("Find a setting");
  expect(document.activeElement).toBe(dialog.querySelector('input[type="search"]'));
});

it.each([
  ["/settings/services", "/settings/machines"],
  ["/settings/services?filter=active", "/settings/services"],
])("keeps the result mounted from %s until %s commits", async (from, to) => {
  window.history.replaceState(null, "", from);
  await act(async () => root.render(createElement(SettingsShell, view)));
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true })));
  const dialog = host.querySelector<HTMLDialogElement>("dialog[open]")!;
  const link = dialog.querySelector<HTMLAnchorElement>(`a[href="${to}"]`)!;
  // Suppress jsdom's native navigation. The router commits in the next render.
  link.addEventListener("click", event => event.preventDefault(), { once: true });
  await act(async () => link.click());
  expect(dialog.open).toBe(true);
  expect(dialog.contains(link)).toBe(true);

  pathname = to;
  window.history.replaceState(null, "", to);
  await act(async () => root.render(createElement(SettingsShell, view)));
  expect(dialog.open).toBe(false);
});
