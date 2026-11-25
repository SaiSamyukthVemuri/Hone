// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsShell } from "@/components/settings/settings-shell";

const router = { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() };
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/services",
  useRouter: () => router,
}));
vi.mock("@/components/pending-link", () => ({
  PendingLink: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement("a", { href }, children),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let expand: HTMLButtonElement;
let screen: HTMLDivElement;
let menu: HTMLButtonElement;

beforeEach(async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const view = {
    items: [],
    account: { name: "Owner", roleLabel: "Owner" },
    children: createElement("input", { "aria-label": "Service name" }),
  };
  await act(async () => root.render(createElement(SettingsShell, view)));
  screen = host.querySelector("[data-settings-screen]")!;
  expand = host.querySelector('button[aria-label="Full screen"]')!;
  menu = host.querySelector('button[aria-label="Settings menu"]')!;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(document, "fullscreenEnabled");
  Reflect.deleteProperty(document, "fullscreenElement");
  Reflect.deleteProperty(document, "exitFullscreen");
});

const click = (button: HTMLButtonElement) => act(async () => button.click());
const escape = () => act(async () => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
});

it.each(["unavailable", "denied"])("retains edits and navigation when native fullscreen is %s", async (state) => {
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: state === "denied" });
  const request = vi.fn().mockRejectedValue(new Error("Blocked by embedder"));
  screen.requestFullscreen = request;
  const input = host.querySelector("input")!;
  input.value = "Unsaved service name";
  await click(expand);
  expect(request).toHaveBeenCalledTimes(state === "denied" ? 1 : 0);
  expect(expand.getAttribute("aria-label")).toBe("Exit expanded view");
  expect(screen.dataset.settingsExpanded).toBe("true");
  await click(menu);
  expect(menu.getAttribute("aria-expanded")).toBe("true");
  await escape();
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  expect(screen.dataset.settingsExpanded).toBe("true");
  await escape();
  expect(screen.dataset.settingsExpanded).toBe("false");
  expect(document.activeElement).toBe(expand);
  expect(host.querySelector("input")?.value).toBe("Unsaved service name");
});

it("follows native fullscreen changes, including a browser-driven exit", async () => {
  let element: Element | null = null;
  const change = (next: Element | null) => {
    element = next;
    document.dispatchEvent(new Event("fullscreenchange"));
  };
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => element });
  screen.requestFullscreen = vi.fn(async () => change(screen));
  document.exitFullscreen = vi.fn(async () => change(null));
  await click(expand);
  expect(document.fullscreenElement).toBe(screen);
  expect(expand.getAttribute("aria-label")).toBe("Exit full screen");
  await click(expand);
  expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
  expect(screen.dataset.settingsExpanded).toBe("false");
  await click(expand);
  act(() => change(null));
  expect(expand.getAttribute("aria-label")).toBe("Full screen");
  expect(screen.dataset.settingsExpanded).toBe("false");
});
