import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { safeInAppHref } from "@/lib/notifications/safe-href";

describe("safeInAppHref", () => {
  it.each([
    ["absolute https URL", "https://evil.example/phish"],
    ["protocol-relative", "//evil.example/phish"],
    ["javascript scheme", "javascript:alert(1)"],
    ["backslash variant", "/\\evil.example/phish"],
    ["backslash after slash-slash", "\\\\evil.example"],
    ["tab inside", "/\t/evil.example"],
    ["empty", ""],
    ["relative without slash", "clients/1"],
  ])("rejects %s", (_n, href) => {
    expect(safeInAppHref(href)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(safeInAppHref(null)).toBeNull();
    expect(safeInAppHref(undefined)).toBeNull();
  });

  it.each(["/calendar", "/clients/abc?tab=notes#top", "/"])("keeps %s", (h) => {
    expect(safeInAppHref(h)).toBe(h);
  });

  it("the notifications page routes the row href through it", () => {
    const src = readFileSync("app/(app)/notifications/page.tsx", "utf8");
    expect(src).toContain("safeInAppHref(notification.href)");
    expect(src).not.toMatch(/href=\{notification\.href\}/);
  });
});
