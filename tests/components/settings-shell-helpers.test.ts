import { describe, expect, it, vi } from "vitest";
import { activeSettingsLocation } from "@/lib/settings/nav";
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

describe("activeSettingsLocation", () => {
  const items = [
    {
      id: "payments",
      href: "/settings/payments/setup",
      base: "/settings/payments",
      children: [
        { id: "setup", href: "/settings/payments/setup" },
        { id: "fees", href: "/settings/payments/fees" },
      ],
    },
    { id: "profile", href: "/settings/profile", base: "/settings/profile", children: [] },
  ];
  it("matches a child view exactly, then a flat entry", () => {
    expect(activeSettingsLocation(items, "/settings/payments/fees")?.child?.id).toBe("fees");
    expect(activeSettingsLocation(items, "/settings/profile")?.item.id).toBe("profile");
  });
  it("a route under a group's base that is not a view keeps the group lit", () => {
    const loc = activeSettingsLocation(items, "/settings/payments/return");
    expect(loc?.item.id).toBe("payments");
    expect(loc?.child).toBeNull();
  });
  it("does not match a sibling prefix", () => {
    expect(activeSettingsLocation(items, "/settings/paymentsx")).toBeNull();
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
      /onClick=\{\(e\) => \{\s*const target = e\.target as Element \| null;\s*if \(!isRailLinkClick\(target\)\) return;\s*setDrawerOpen\(false\);/,
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

describe("Settings R2: the remaining edit-then-save forms are guarded (Insurance G1/G2)", () => {
  const read = (rel: string) =>
    require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../..", rel), "utf8") as string;
  it.each([
    ["app/(app)/settings/consent/ConsentTemplatesEditor.tsx", "consent-template-"],
    ["app/(app)/settings/import/QuickImport.tsx", "quick-import"],
    ["app/(app)/settings/booking/BookingView.tsx", "booking-window"],
    ["app/(app)/settings/booking/BookingView.tsx", "booking-link"],
    ["app/(app)/settings/booking/BookingView.tsx", "booking-new-clients"],
    ["app/(app)/settings/services/page.tsx", "service-edit-"],
    ["app/(app)/settings/services/page.tsx", "service-create"],
    ["app/(app)/settings/availability/AvailabilityClient.tsx", "availability-day"],
    ["app/(app)/settings/availability/AvailabilityClient.tsx", "availability-override"],
    ["app/(app)/settings/availability/AvailabilityClient.tsx", "availability-blockout"],
    ["app/(app)/settings/availability/PractitionerWeekEditor.tsx", "availability-week-day"],
    ["app/(app)/settings/availability/PractitionerWeekEditor.tsx", "availability-week-override"],
    ["app/(app)/settings/availability/TimedBlocksSection.tsx", "availability-timed-block"],
    ["app/(app)/settings/availability/RecurringBreaksSection.tsx", "availability-recurring-break"],
  ])("%s registers %s", (file, key) => {
    const src = read(file);
    expect(src).toMatch(/useUnsavedChangesGuard\(|<FormDirtyGuard/);
    expect(src).toContain(key);
  });
  it("G1: a successful tracking save puts the trimmed values back in the inputs", () => {
    const src = read("app/(app)/settings/tracking/TrackingProviderForm.tsx");
    expect(src).toMatch(/setPixelId\(\(cur\) => \(cur === sentRawPixel \? sent\.pixelId : cur\)\)/);
    expect(src).toMatch(/setTestCode\(\(cur\) => \(cur === sentRawTest \? sent\.testCode : cur\)\)/);
  });
});

describe("Insurance #1297 G1: the tracking form reads clean after a save with stray spaces", () => {
  const read = (rel: string) =>
    require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../..", rel), "utf8") as string;
  it("a successful save puts the trimmed values back in the inputs", () => {
    const src = read("app/(app)/settings/tracking/TrackingProviderForm.tsx");
    expect(src).toMatch(/setPixelId\(\(cur\) => \(cur === sentRawPixel \? sent\.pixelId : cur\)\)/);
    expect(src).toMatch(/setTestCode\(\(cur\) => \(cur === sentRawTest \? sent\.testCode : cur\)\)/);
  });
});

describe("Insurance #1297 / Codex: edits typed while a tracking save is in flight survive it", () => {
  it("normalizes and clears only fields still equal to what was sent, and marks saved what was sent", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../..", "app/(app)/settings/tracking/TrackingProviderForm.tsx"),
      "utf8",
    ) as string;
    expect(src).toMatch(/setPixelId\(\(cur\) => \(cur === sentRawPixel \? sent\.pixelId : cur\)\)/);
    expect(src).toMatch(/setTestCode\(\(cur\) => \(cur === sentRawTest \? sent\.testCode : cur\)\)/);
    expect(src).toMatch(/setToken\(\(cur\) => \(cur === sentRawToken \? "" : cur\)\)/);
    expect(src).toMatch(/setSaved\(sent\)/);
  });
});

describe("Codex P2: FormDirtyGuard re-baselines after a save and rolls back on a refused one", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").resolve(__dirname, "../..", "components/settings/form-dirty-guard.tsx"),
    "utf8",
  ) as string;
  it("takes a new baseline on submit and restores the old one when the redirect carries an error", () => {
    expect(src).toMatch(/previous\.current = baseline\.current;\s*baseline\.current = snapshot\(form\)/);
    expect(src).toMatch(/search\?\.has\("error"\)/);
  });
});

describe("Insurance #1301 G1-G3 (1 Nov)", () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
  it("G1: a refused save restores the pre-submit baseline EVERY time, keyed on the server response, not on the error param appearing", async () => {
    const { baselineAfterArrival } = await import("@/components/settings/form-dirty-guard");
    // first refusal and a second refusal at the same URL behave identically
    for (let i = 0; i < 2; i++) {
      expect(baselineAfterArrival({ awaiting: true, refused: true, before: "A" })).toBe("A");
    }
    // a successful save keeps the baseline taken at submit
    expect(baselineAfterArrival({ awaiting: true, refused: false, before: "A" })).toBeNull();
    // nothing pending: nothing changes
    expect(baselineAfterArrival({ awaiting: false, refused: true, before: "A" })).toBeNull();
    const src = read("components/settings/form-dirty-guard.tsx");
    expect(src).toMatch(/\[token, hasError\]/);
    expect(src).toMatch(/awaiting\.current = true/);
  });
  it.each([
    ["app/(app)/settings/booking/BookingView.tsx", 3],
    ["app/(app)/settings/services/page.tsx", 2],
  ])("G1: %s passes a per-render token to every FormDirtyGuard", (file, n) => {
    const src = read(file);
    expect(src.match(/<FormDirtyGuard [^>]*token=\{Date\.now\(\)\.toString\(36\)\}/g)?.length).toBe(n);
    expect(src.match(/<FormDirtyGuard /g)?.length).toBe(n);
  });
  it("G2: the week-override guard is keyed by practitioner id, never by name", () => {
    const src = read("app/(app)/settings/availability/PractitionerWeekEditor.tsx");
    expect(src).toContain("`availability-week-override-${practitionerId}`");
    expect(src).not.toContain("availability-week-override-${practitionerName}");
  });
  it("G3: an untouched open edit is not dirty (compared with the form as opened)", () => {
    const rec = read("app/(app)/settings/availability/RecurringBreaksSection.tsx");
    const tim = read("app/(app)/settings/availability/TimedBlocksSection.tsx");
    const day = read("app/(app)/settings/availability/AvailabilityClient.tsx");
    for (const src of [rec, tim]) {
      expect(src).toMatch(/editingId != null\s*\?\s*fieldsKey !== openedKey/);
      expect(src).not.toMatch(/editingId != null \|\|/);
    }
    expect(tim).toMatch(/const \[mountDay\] = useState\(todayLocal\)/);
    expect(tim).toMatch(/date !== mountDay/);
    expect(day).toMatch(/setOpenedDraft\(opened\)/);
    expect(day).toMatch(/draft\.open_time !== openedDraft\.open_time/);
  });
});

describe("Codex P2: no in-app entry point still targets the legacy /settings/intake route", () => {
  it.each([
    "app/(app)/settings/launch/page.tsx",
    "app/(app)/settings/payments/PaymentsSettings.tsx",
    "components/appointment/postcare-section.tsx",
  ])("%s links straight to a focused Forms view", (file) => {
    const src = require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../..", file), "utf8") as string;
    expect(src).not.toMatch(/\/settings\/intake/);
  });
});

describe("R2 Codex P2s (1 Nov): readiness remediation links and the override guard", () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
  it("booking-readiness remediation links open the editor that owns the field, never the doorway", () => {
    const readiness = read("lib/booking/readiness.ts");
    expect(readiness).not.toMatch(/href: "\/settings\/booking",/);
    expect(readiness).toMatch(/key: "booking_settings"[\s\S]*?href: "\/settings\/booking\/window"/);
    expect(readiness).toMatch(/key: "public_location"[\s\S]*?href: "\/settings\/booking\/window"/);
    expect(readiness).toMatch(/key: "booking_link"[\s\S]*?href: "\/settings\/booking\/link"/);
    const newClient = read("lib/booking/new-client-readiness.ts");
    expect(newClient).not.toMatch(/href: "\/settings\/booking"/);
    expect(newClient).toMatch(/booking_settings: \{[\s\S]*?href: "\/settings\/booking\/window"/);
    const launch = read("app/(app)/settings/launch/page.tsx");
    expect(launch).not.toMatch(/href: "\/settings\/booking"/);
    expect(launch).toMatch(/booking_settings[\s\S]{0,400}href: "\/settings\/booking\/window"/);
  });
  it("a saved practitioner override resets its fields so the guard releases", () => {
    const src = read("app/(app)/settings/availability/PractitionerWeekEditor.tsx");
    expect(src).toMatch(/function run\([\s\S]*?onOk\?: \(\) => void\)/);
    expect(src).toMatch(/onOk\?\.\(\)/);
    expect(src).toMatch(/setDate\(""\);\s*setIsOpen\(true\);\s*setOpen\("10:00"\);\s*setClose\("15:00"\);/);
  });
});

describe("R2 Codex P2 (1 Nov): setup links open the focused Studio view, never the doorway", () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
  it("the confirmation-email checklist row and the getting-started email review open the email editor", () => {
    const launch = read("app/(app)/settings/launch/page.tsx");
    expect(launch).toMatch(/title: "Client confirmation emails"[\s\S]*?href: "\/settings\/studio\/email"/);
    expect(read("lib/onboarding/getting-started.ts")).toMatch(/"emails-review"[\s\S]*?"\/settings\/studio\/email"/);
  });
  it("no readiness, launch or getting-started link points at the /settings/studio doorway", () => {
    for (const f of [
      "app/(app)/settings/launch/page.tsx",
      "lib/onboarding/getting-started.ts",
      "lib/booking/readiness.ts",
      "lib/booking/new-client-readiness.ts",
    ]) {
      expect(read(f), f).not.toMatch(/["'`]\/settings\/studio["'`]/);
    }
  });
});

describe("R2-F1 (Photos, 1 Nov): the mobile drawer navigation lands focus on the heading, not <body>", () => {
  it("focusIsNowhere is true only for null, body and the root element", async () => {
    const { focusIsNowhere } = await import("@/components/settings/focus-heading");
    const body = { id: "body" } as unknown as Element;
    const root = { id: "html" } as unknown as Element;
    const field = { id: "field" } as unknown as Element;
    expect(focusIsNowhere(null, body, root)).toBe(true);
    expect(focusIsNowhere(body, body, root)).toBe(true);
    expect(focusIsNowhere(root, body, root)).toBe(true);
    expect(focusIsNowhere(field, body, root)).toBe(false);
  });

  it("focusSettingsHeading focuses the heading without scrolling, once it exists", async () => {
    const { focusSettingsHeading } = await import("@/components/settings/focus-heading");
    const focus = vi.fn();
    const heading = { focus } as unknown as HTMLElement;
    expect(focusSettingsHeading({ querySelector: () => null }, null)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(focusSettingsHeading({ querySelector: () => heading }, null)).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focus.mockClear();
    expect(focusSettingsHeading({ querySelector: () => heading }, heading as unknown as Element)).toBe(true);
    expect(focus).not.toHaveBeenCalled();
  });

  it("the shell retries as the new view mounts, only while focus is nowhere", () => {
    const src = readFileSync(path.resolve(__dirname, "../..", "components/settings/settings-shell.tsx"), "utf8");
    expect(src).toMatch(/new MutationObserver\(retry\)/);
    expect(src).toMatch(/focusIsNowhere\(/);
    expect(src).toMatch(/observer\.disconnect\(\)/);
  });
});

describe("R2-F1 (Photos, 1 Nov): every rail view's heading carries the focus marker", () => {
  const root = path.resolve(__dirname, "../..");
  const registry = readFileSync(path.join(root, "lib/settings/nav-registry.ts"), "utf8");
  const hrefs = Array.from(new Set(Array.from(registry.matchAll(/href:\s*"(\/settings\/[a-z0-9/-]+)"/g), (m) => m[1])));
  // A group's own href is its first child's route; only leaf routes are views.
  const leaves = hrefs.filter((h) => !hrefs.some((o) => o !== h && o.startsWith(h + "/")));

  function sourcesFor(href: string): string {
    const fs = require("node:fs") as typeof import("node:fs");
    const dir = path.join(root, "app/(app)", href);
    // booking/ and payments/ render their views from a shared component in the parent folder.
    const dirs = [dir, ...(/^\/settings\/(booking|payments)\//.test(href) ? [path.dirname(dir)] : [])];
    const dyn = path.join(path.dirname(dir), "[view]");
    if (fs.existsSync(dyn)) dirs.push(dyn);
    return dirs
      .filter((d) => fs.existsSync(d))
      .flatMap((d) => fs.readdirSync(d).filter((f) => /\.tsx?$/.test(f)).map((f) => readFileSync(path.join(d, f), "utf8")))
      .join("\n");
  }

  it("finds the rail's leaf views", () => {
    expect(leaves.length).toBeGreaterThanOrEqual(20);
    expect(leaves).toContain("/settings/profile");
  });

  it.each(leaves)("%s marks its heading", (href) => {
    expect(sourcesFor(href)).toMatch(/data-settings-heading|SettingsViewHeading|focusTitle/);
  });

  it("the marked heading is programmatically focusable and not outlined", () => {
    const profile = readFileSync(path.join(root, "app/(app)/settings/profile/page.tsx"), "utf8");
    expect(profile).toMatch(/<h2 tabIndex=\{-1\} data-settings-heading/);
  });
});

describe("Reference fidelity (1 Nov): names, scope chip, same-route pick and Stay at 390", () => {
  const root = path.resolve(__dirname, "../..");
  const read = (f: string) => readFileSync(path.join(root, f), "utf8");

  it("rail items use Sam's and the artifact's names", () => {
    const reg = read("lib/settings/nav-registry.ts");
    expect(reg).toMatch(/label: "Studio details"/);
    expect(reg).not.toMatch(/label: "Details"/);
    expect(reg).toMatch(/label: "Text-message preferences"/);
    expect(reg).toMatch(/label: "Cancellation and no-show policy"/);
    expect(reg).toMatch(/label: "Personal details"/);
  });

  it("every rail leaf view that uses SettingsViewHeading is titled exactly like its rail item", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const reg = read("lib/settings/nav-registry.ts");
    const items = Array.from(reg.matchAll(/label: "([^"]+)", href: "(\/settings\/[a-z0-9/-]+)"/g), (m) => ({ label: m[1], href: m[2] }));
    expect(items.length).toBeGreaterThanOrEqual(15);
    for (const { label, href } of items) {
      const dir = path.join(root, "app/(app)", href);
      const dirs = [dir, ...(/^\/settings\/(booking|payments)\//.test(href) ? [path.dirname(dir)] : [])];
      const src = dirs
        .filter((d) => fs.existsSync(d))
        .flatMap((d) => fs.readdirSync(d).filter((f) => /\.tsx?$/.test(f)).map((f) => readFileSync(path.join(d, f), "utf8")))
        .join("\n");
      // Team's rail item is a flat link whose view is headed "Practitioners".
      if (label === "Team" || !/SettingsViewHeading/.test(src)) continue;
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/&/g, "(?:&|and)");
      expect(src, `${href} heading should read "${label}"`).toMatch(new RegExp(`(title=\\{?"${escaped}"|data-settings-heading[^>]*>${escaped}<)`));
    }
  });

  it("the scope sits in a chip beside the title", () => {
    const src = read("components/settings/view-heading.tsx");
    expect(src).toMatch(/rounded-full border/);
    expect(src).toMatch(/justify-between/);
  });

  it("a rail pick of the open view moves focus to its heading", () => {
    const src = read("components/settings/settings-shell.tsx");
    expect(src).toMatch(/anchor\.pathname === pathname/);
    expect(src).toMatch(/focusSettingsHeading\(content\.current/);
  });

  it("Stay after a held click from an OPEN phone drawer closes it and focuses the Menu button", async () => {
    const { stayFocusTarget } = await import("@/components/settings/focus-heading");
    expect(stayFocusTarget({ drawerWasOpen: true, isDesktop: false })).toBe("menu");
  });

  it("Stay after a held click from page content (drawer never open), or on desktop, returns focus to the held anchor", async () => {
    const { stayFocusTarget } = await import("@/components/settings/focus-heading");
    expect(stayFocusTarget({ drawerWasOpen: false, isDesktop: false })).toBe("anchor");
    expect(stayFocusTarget({ drawerWasOpen: false, isDesktop: true })).toBe("anchor");
    expect(stayFocusTarget({ drawerWasOpen: true, isDesktop: true })).toBe("anchor");
  });

  it("the shell reads the drawer state when the dialog appears and only closes an open drawer", () => {
    const shell = read("components/settings/settings-shell.tsx");
    const guard = read("components/settings/unsaved-changes.tsx");
    expect(shell).toMatch(/<UnsavedChangesProvider onHold=\{rememberDrawer\} onStay=\{stayOnPage\}>/);
    expect(shell).toMatch(/drawerWasOpen\.current = drawerOpenRef\.current/);
    expect(shell).toMatch(/if \(target === "menu"\) setDrawerOpen\(false\)/);
    expect(shell).toMatch(/anchor\.focus\(\{ preventScroll: true \}\)/);
    expect(guard).toMatch(/onHoldRef\.current\?\.\(anchor\)/);
    expect(guard).toMatch(/onStay\?\.\(heldAnchor\.current\)/);
  });

});

describe("Sam's decision 5 (1 Nov): PERSONAL / STUDIO category headings in the rail", () => {
  it("the labels are PERSONAL and STUDIO; the setup group has none", async () => {
    const { SETTINGS_NAV_GROUP_LABEL } = await import("@/lib/settings/nav");
    expect(SETTINGS_NAV_GROUP_LABEL.personal).toBe("Personal");
    expect(SETTINGS_NAV_GROUP_LABEL.studio).toBe("Studio");
    expect(SETTINGS_NAV_GROUP_LABEL.setup).toBeNull();
  });
  it("the shell renders them as non-interactive, uppercase headings tied to their group", () => {
    const src = readFileSync(path.resolve(__dirname, "../..", "components/settings/settings-shell.tsx"), "utf8");
    const at = src.indexOf("SETTINGS_NAV_GROUP_LABEL[group] && (");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 520);
    expect(block).toMatch(/<p\s+id=\{`\$\{railId\}-cat-\$\{group\}`\}/);
    expect(block).toMatch(/uppercase/);
    expect(block).not.toMatch(/<button|<PendingLink|tabIndex|onClick/);
    expect(src).toMatch(/role="group"/);
  });
});

describe("Studio details shows location and time zone (artifact), without a second editable source", () => {
  const src = readFileSync(path.resolve(__dirname, "../..", "app/(app)/settings/studio/details/page.tsx"), "utf8");
  it("reads the existing studio address and timezone and links to Booking window", () => {
    expect(src).toMatch(/studio\.address/);
    expect(src).toMatch(/studio\.timezone/);
    expect(src).toMatch(/href="\/settings\/booking\/window"/);
  });
  it("adds no input, no form and no action", () => {
    const tail = src.slice(src.indexOf("studio-location-heading"));
    expect(tail).not.toMatch(/<input|<select|<textarea|<form|action=/);
  });
});
