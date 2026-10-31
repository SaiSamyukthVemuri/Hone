import { describe, expect, it } from "vitest";
import { activeSettingsItem } from "@/lib/settings/nav";
import { isLeavingNavigation } from "@/components/settings/unsaved-changes";
import { movedSectionTarget } from "@/components/settings/hash-redirect";

const here = { origin: "https://app.test", pathname: "/settings/studio", search: "" };
const a = (href: string, extra: Record<string, unknown> = {}) =>
  ({ href: `https://app.test${href}`, target: "", download: "", ...extra }) as Pick<
    HTMLAnchorElement,
    "href" | "target" | "download"
  >;

describe("isLeavingNavigation", () => {
  it("a hash jump on the same page is not leaving", () => {
    expect(isLeavingNavigation(a("/settings/studio#email-notifications"), here)).toBe(false);
  });
  it("another settings page is leaving", () => {
    expect(isLeavingNavigation(a("/settings/team"), here)).toBe(true);
  });
  it("a different query on the same path is leaving", () => {
    expect(isLeavingNavigation(a("/settings/studio?x=1"), here)).toBe(true);
  });
  it("a new tab, a download and a cross-origin link are not leaving", () => {
    expect(isLeavingNavigation(a("/settings/team", { target: "_blank" }), here)).toBe(false);
    expect(isLeavingNavigation(a("/settings/team", { download: "x.csv" }), here)).toBe(false);
    expect(
      isLeavingNavigation({ href: "https://other.test/x", target: "", download: "" }, here),
    ).toBe(false);
  });
});

describe("movedSectionTarget", () => {
  const moved = { "time-format": "/settings/calendar#time-format" };
  it("maps a moved id and ignores everything else", () => {
    expect(movedSectionTarget("#time-format", moved)).toBe("/settings/calendar#time-format");
    expect(movedSectionTarget("#studio-name", moved)).toBeNull();
    expect(movedSectionTarget("", moved)).toBeNull();
    expect(movedSectionTarget("#constructor", moved)).toBeNull();
    expect(movedSectionTarget("#__proto__", moved)).toBeNull();
  });
});

describe("activeSettingsItem", () => {
  const items = [{ href: "/settings/payments" }, { href: "/settings/profile" }];
  it("matches exactly, then by prefix", () => {
    expect(activeSettingsItem(items, "/settings/profile")?.href).toBe("/settings/profile");
    expect(activeSettingsItem(items, "/settings/payments/return")?.href).toBe("/settings/payments");
    expect(activeSettingsItem(items, "/settings/paymentsx")).toBeNull();
  });
});
