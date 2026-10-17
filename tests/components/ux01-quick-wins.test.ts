import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// UX-01 Quick Wins — the four repairs, pinned where a browser cannot look.
//
// The BEHAVIOURAL proof is e2e/ux01-quick-wins.spec.ts: computed contrast,
// rendered box heights, real Escape and real focus. This file pins the three
// things that proof is bad at — WHICH mechanism was used, whether the slice
// stayed inside its boundary, and the call sites a browser fixture would be
// disproportionately expensive to reach.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// LINE comments before BLOCK comments: a `//` line containing `/*` otherwise
// leaves the block stripper eating to the next `*/`, removing real code and
// making every "does not contain" assertion vacuously true.
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const DASH = "app/(app)/dashboard/page.tsx";
const RECORDS = "app/(app)/records/page.tsx";
const LAYOUT = "app/(app)/layout.tsx";
const NAVLINK = "app/(app)/PrimaryNavLink.tsx";
const HOOK = "components/use-dialog-keyboard.ts";
const SEND = "app/(app)/calendar/PostcareSendButton.tsx";
const HELPERS = "app/(app)/settings/studio/PostcareEditingHelpers.tsx";
const VIEWTOGGLE = "app/(app)/calendar/ViewToggle.tsx";
const QUICKBOOK = "app/(app)/calendar/QuickBookDrawer.tsx";

describe("UX-01 QW4 · both postcare dialogs adopt ONE keyboard mechanism", () => {
  it("each dialog uses the shared hook rather than its own handler", () => {
    for (const f of [SEND, HELPERS]) {
      const code = codeOnly(read(f));
      expect(code, f).toContain("useDialogKeyboard");
      // Not a second, drifting implementation per file.
      expect(code, f).not.toContain('addEventListener("keydown"');
      expect(code, f).toContain("ref={panelRef}");
      // The panel must be a programmatic focus target, or focus has nowhere to
      // land and the trap has nowhere to park.
      expect(code, f).toContain("tabIndex={-1}");
    }
  });

  it("the SEND dialog gates Escape on its in-flight request; the PREVIEW does not", () => {
    // Confirm on the send dialog hands an email to a provider and the panel is
    // the only place the outcome is reported, so Escape must not abandon it.
    // The preview sends nothing — its own trigger says so — and gating it there
    // would be cargo-culted ceremony.
    expect(codeOnly(read(SEND))).toContain("busy: pending");
    expect(codeOnly(read(HELPERS))).not.toContain("busy:");
  });

  it("the hook suppresses Escape while busy, and restores focus on close", () => {
    const code = codeOnly(read(HOOK));
    expect(code).toContain('if (e.key === "Escape")');
    expect(code).toContain("if (!busy) onClose();");
    expect(code).toContain("opener.focus()");
    // A detached opener is a silent no-op that drops the user at <body>.
    expect(code).toContain("opener.isConnected");
  });

  it("it does NOT weaken the server-safe primitive boundary", () => {
    // components/ui/ is the server-compatible set and has its own guard. This
    // is a client hook by necessity, so it lives beside use-return-focus.ts.
    expect(read(HOOK)).toContain('"use client"');
    expect(() => read("components/ui/use-dialog-keyboard.ts")).toThrow();
  });
});

describe("UX-01 QW3 · the flagship actions use the canonical Button", () => {
  it("both adopt buttonClasses rather than a hand-rolled box", () => {
    expect(codeOnly(read(DASH))).toContain('buttonClasses({ variant: "primary" })');
    expect(codeOnly(read(RECORDS))).toContain('buttonClasses({ variant: "secondary"');
  });

  it("Button itself was not redesigned", () => {
    // The audit's verdict is that Hone's Button is better-reasoned than the
    // Astryx candidate and the problem is ADOPTION. This slice adopts it.
    const btn = read("components/ui/button.tsx");
    expect(btn).toContain("CONTROL_MIN_TOUCH");
    expect(btn).toContain("export function buttonClasses");
  });

  it("the records control keeps its layout role", () => {
    // `ml-auto` is what pushes Print / Export to the trailing edge of the nav
    // row. It is layout, not geometry, and must survive the primitive swap.
    expect(codeOnly(read(RECORDS))).toContain('className: "ml-auto"');
  });
});

describe("UX-01 QW5 · the off-system radius left the product", () => {
  it("no file carries rounded-[5px]", () => {
    for (const f of [VIEWTOGGLE, QUICKBOOK]) {
      expect(codeOnly(read(f)), f).not.toContain("rounded-[5px]");
    }
  });

  it("the slice did NOT start control-geometry or tab work", () => {
    // Retiring the seven tab dialects is UX-03; collapsing control heights is
    // UX-04. Neither is scheduled and neither is started here.
    const toggle = codeOnly(read(VIEWTOGGLE));
    expect(toggle).toContain("PendingLink");
    expect(toggle).not.toContain("SegmentedControl");
    expect(toggle).not.toContain("@/components/ui/tabs");
  });
});

describe("UX-01 QW1 · the current day is not painted as disabled", () => {
  const code = codeOnly(read(DASH));

  it("the current segment has its OWN token", () => {
    expect(code).toContain("DAY_NAV_SEGMENT_CURRENT");
    expect(code).toContain("DAY_NAV_SEGMENT_CURRENT + DAY_NAV_DIVIDE");
  });

  it("the disabled token no longer dresses the current segment", () => {
    // The defect was one token serving two meanings. The genuinely disabled
    // arrows keep it — they ARE disabled and are contrast-exempt — so the fix
    // is separation, not deletion.
    expect(code).toContain("DAY_NAV_SEGMENT_DISABLED");
    expect(
      code.match(/aria-current="page"[\s\S]{0,160}?DAY_NAV_SEGMENT_DISABLED/),
    ).toBeNull();
  });

  it("the current state changes no text metric", () => {
    // The file promises the two arrows do not move under the thumb between
    // days. `font-*` on the current segment would change its advance width and
    // break that, so the state is carried by fill and ink only.
    const token = code.match(/const DAY_NAV_SEGMENT_CURRENT =\s*\n?\s*"([^"]+)"/)?.[1] ?? "";
    expect(token, "current-day token").not.toBe("");
    expect(token).not.toMatch(/font-(medium|semibold|bold)/);
    expect(token).not.toMatch(/\btext-(xs|base|lg)\b/);
    expect(token).toContain("min-h-[44px]");
    expect(token).toContain("px-3");
    expect(token).toContain("text-sm");
  });
});

describe("UX-01 QW2 · bounded, and provably not UX-03", () => {
  const nav = codeOnly(read(NAVLINK));
  const layout = codeOnly(read(LAYOUT));

  it("adds no provider, context or global route-progress", () => {
    expect(nav).not.toContain("createContext");
    expect(nav).not.toContain("useContext");
    expect(nav).not.toContain("Provider");
    // A global progress bar is UX-03's to propose, not this slice's to ship.
    expect(nav).not.toContain("NProgress");
    expect(nav).not.toContain("router.events");
  });

  it("the shell stays a SERVER component", () => {
    // The whole reason the state lives in a leaf: a `"use client"` shell would
    // start hydrating every authenticated page.
    expect(layout).not.toContain('"use client"');
  });

  it("introduces no tab primitive", () => {
    expect(nav).not.toContain("role=\"tab\"");
    expect(nav).not.toContain("SegmentedControl");
  });

  it("only the five SECTION links moved; the wordmark and bell did not", () => {
    expect(layout).toContain('data-testid="nav-wordmark"');
    expect(layout).toContain('data-testid="nav-notifications"');
    expect(layout.match(/<PrimaryNavLink[\s>]/g) ?? []).toHaveLength(5);
  });

  it("exactly one rule decides 'current', and Dashboard is exact", () => {
    expect(nav).toContain("export function isCurrentSection");
    expect(nav.match(/aria-current/g) ?? []).toHaveLength(1);
    expect(layout).toMatch(/href="\/dashboard"\s+match="exact"/);
  });

  it("a section match requires a path boundary", () => {
    // Without the `/`, `/records` would also claim a sibling like
    // `/records-archive`.
    expect(nav).toContain("path.startsWith(`${target}/`)");
  });
});

describe("UX-01 QW2 · the matching rule itself", () => {
  // `isCurrentSection` is exported precisely so the rule can be exercised
  // directly rather than inferred from rendered output.

  it("lights the section it is on, and its subtree", async () => {
    const { isCurrentSection } = await import("@/app/(app)/PrimaryNavLink");
    expect(isCurrentSection("/clients", "/clients", "section")).toBe(true);
    expect(isCurrentSection("/clients/abc", "/clients", "section")).toBe(true);
    expect(isCurrentSection("/calendar", "/clients", "section")).toBe(false);
  });

  it("does not let one section claim a prefix-sharing sibling", async () => {
    const { isCurrentSection } = await import("@/app/(app)/PrimaryNavLink");
    expect(isCurrentSection("/records-archive", "/records", "section")).toBe(false);
  });

  it("keeps Dashboard and Business apart", async () => {
    const { isCurrentSection } = await import("@/app/(app)/PrimaryNavLink");
    expect(isCurrentSection("/dashboard/capacity", "/dashboard", "exact")).toBe(false);
    expect(
      isCurrentSection("/dashboard/capacity", "/dashboard/capacity", "section"),
    ).toBe(true);
  });

  it("tolerates a trailing slash, which this app does NOT canonicalise", async () => {
    // Codex P2. `next.config.ts` sets `skipTrailingSlashRedirect: true`, so
    // `/dashboard/` is served as-is and a raw equality check left the dashboard
    // with no current state while the dashboard was on screen.
    const { isCurrentSection } = await import("@/app/(app)/PrimaryNavLink");
    expect(isCurrentSection("/dashboard/", "/dashboard", "exact")).toBe(true);
    expect(isCurrentSection("/clients/", "/clients", "section")).toBe(true);
    // And the normalisation must not turn root into the empty string.
    expect(isCurrentSection("/", "/dashboard", "exact")).toBe(false);
  });

  it("the config premise is real, not assumed", async () => {
    // If this ever flips, the normalisation above is dead weight and should be
    // re-justified rather than left as cargo.
    expect(read("next.config.ts")).toContain("skipTrailingSlashRedirect: true");
  });
});

describe("UX-01 QW4 · the trap has no open edge", () => {
  it("treats focus outside the tabbable set as a boundary in BOTH directions", () => {
    // Codex P2. On open, focus rests on the PANEL, which carries
    // `tabIndex={-1}` and is excluded from FOCUSABLE by design — so the first
    // Shift+Tab after opening matched neither the `first` nor the `last`
    // branch, no handler fired, and focus followed the browser's default order
    // out of the dialog, past an `aria-modal` that had already hidden that
    // content from assistive technology.
    const code = codeOnly(read(HOOK));
    expect(code).toContain("!focusables.includes(active as HTMLElement)");
    expect(code).toContain("(e.shiftKey ? last : first).focus();");
  });
});
