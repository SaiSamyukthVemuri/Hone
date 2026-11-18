import { describe, expect, it } from "vitest";
import { shouldInterceptClick } from "@/lib/sessions/use-unsaved-guard";

const click = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
const here = { origin: "https://app.test", pathname: "/clients/1", search: "" };
const a = (href: string, extra: Record<string, string> = {}) => ({ href, target: "", download: "", ...extra });

describe("shouldInterceptClick", () => {
  it("holds a same-origin link to another page while dirty", () => {
    expect(shouldInterceptClick(true, click, a("https://app.test/clients"), here)).toBe(true);
  });
  it("never holds when clean", () => {
    expect(shouldInterceptClick(false, click, a("https://app.test/clients"), here)).toBe(false);
  });
  it("ignores modified clicks, other buttons and handled clicks", () => {
    for (const c of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
      expect(shouldInterceptClick(true, { ...click, ...c }, a("https://app.test/x"), here)).toBe(false);
    }
  });
  it("ignores external links, new tabs, downloads, hash jumps and non-anchors", () => {
    expect(shouldInterceptClick(true, click, a("https://other.test/"), here)).toBe(false);
    expect(shouldInterceptClick(true, click, a("https://app.test/x", { target: "_blank" }), here)).toBe(false);
    expect(shouldInterceptClick(true, click, a("https://app.test/x", { download: "f" }), here)).toBe(false);
    expect(shouldInterceptClick(true, click, a("https://app.test/clients/1#notes"), here)).toBe(false);
    expect(shouldInterceptClick(true, click, null, here)).toBe(false);
  });
});
