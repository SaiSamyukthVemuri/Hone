import { describe, expect, it } from "vitest";
import { activeSettingsItem } from "@/lib/settings/nav";
import { isLeavingNavigation } from "@/components/settings/unsaved-changes";
import { movedSectionTarget } from "@/components/settings/hash-redirect";

const here = {
  origin: "https://app.test",
  pathname: "/settings/studio",
  search: "",
};
const a = (href: string, extra: Record<string, unknown> = {}) =>
  ({
    href: `https://app.test${href}`,
    target: "",
    download: "",
    ...extra,
  }) as Pick<HTMLAnchorElement, "href" | "target" | "download">;

describe("isLeavingNavigation", () => {
  it("a hash jump on the same page is not leaving", () => {
    expect(
      isLeavingNavigation(a("/settings/studio#email-notifications"), here),
    ).toBe(false);
  });
  it("another settings page is leaving", () => {
    expect(isLeavingNavigation(a("/settings/team"), here)).toBe(true);
  });
  it("a different query on the same path is leaving", () => {
    expect(isLeavingNavigation(a("/settings/studio?x=1"), here)).toBe(true);
  });
  it("a new tab, a download and a cross-origin link are not leaving", () => {
    expect(
      isLeavingNavigation(a("/settings/team", { target: "_blank" }), here),
    ).toBe(false);
    expect(
      isLeavingNavigation(a("/settings/team", { download: "x.csv" }), here),
    ).toBe(false);
    expect(
      isLeavingNavigation(
        { href: "https://other.test/x", target: "", download: "" },
        here,
      ),
    ).toBe(false);
  });
});

describe("movedSectionTarget", () => {
  const moved = { "time-format": "/settings/calendar#time-format" };
  it("maps a moved id and ignores everything else", () => {
    expect(movedSectionTarget("#time-format", moved)).toBe(
      "/settings/calendar#time-format",
    );
    expect(movedSectionTarget("#studio-name", moved)).toBeNull();
    expect(movedSectionTarget("", moved)).toBeNull();
    expect(movedSectionTarget("#constructor", moved)).toBeNull();
    expect(movedSectionTarget("#__proto__", moved)).toBeNull();
  });
});

describe("activeSettingsItem", () => {
  const items = [{ href: "/settings/payments" }, { href: "/settings/profile" }];
  it("matches exactly, then by prefix", () => {
    expect(activeSettingsItem(items, "/settings/profile")?.href).toBe(
      "/settings/profile",
    );
    expect(activeSettingsItem(items, "/settings/payments/return")?.href).toBe(
      "/settings/payments",
    );
    expect(activeSettingsItem(items, "/settings/paymentsx")).toBeNull();
  });
});

import { isRailLinkClick } from "@/lib/settings/nav";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("narrow-screen drawer closes on a same-page section link (Codex P2)", () => {
  it("a click on a link, or on something inside one, counts", () => {
    const inside = {
      closest: (sel: string) => (sel === "a[href]" ? {} : null),
    };
    expect(isRailLinkClick(inside)).toBe(true);
  });
  it("a click that is not inside a link does not close the drawer", () => {
    expect(isRailLinkClick({ closest: () => null })).toBe(false);
    expect(isRailLinkClick(null)).toBe(false);
    expect(isRailLinkClick({})).toBe(false);
  });
  it("the shell wires the handler on the rail and also closes on hashchange", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../components/settings/settings-shell.tsx"),
      "utf8",
    );
    expect(src).toMatch(
      /onClick=\{\(e\) => \{\s*if \(isRailLinkClick\(e\.target as Element \| null\)\)\s*setDrawerOpen\(false\);/,
    );
    expect(src).toMatch(/addEventListener\("hashchange", close\)/);
  });
});

describe("Insurance #1293 follow-ups (U4, U5)", () => {
  const read = (rel: string) =>
    require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../..", rel),
      "utf8",
    ) as string;

  it("U5: Leave does not empty the dirty registry (a form that stays mounted stays guarded)", () => {
    const src = read("components/settings/unsaved-changes.tsx");
    const leave = src.slice(
      src.indexOf("function leave()"),
      src.indexOf("return (", src.indexOf("function leave()")),
    );
    expect(leave).not.toMatch(/dirtyKeys\.current\.clear\(\)/);
    expect(leave).toMatch(/router\.push\(/);
  });

  it("U4: the moved-section redirect runs before first paint", () => {
    const src = read("components/settings/hash-redirect.tsx");
    expect(src).toMatch(/useLayoutEffect\(/);
    expect(src).not.toMatch(/\buseEffect\(/);
  });
});

describe("Insurance #1297 U3: edit-then-save forms register with the unsaved guard", () => {
  const read = (rel: string) =>
    require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../..", rel), "utf8") as string;
  it.each([
    ["app/(app)/settings/profile/ProfileForm.tsx", "profile-details"],
    ["app/(app)/settings/payments/FeeAmountsCard.tsx", "payment-fees"],
    ["app/(app)/settings/team/InviteForm.tsx", "team-invite"],
    ["app/(app)/settings/tracking/TrackingProviderForm.tsx", "tracking-"],
  ])("%s registers a dirty key", (file, key) => {
    const src = read(file);
    expect(src).toMatch(/useUnsavedChangesGuard\(/);
    expect(src).toContain(key);
  });
});
