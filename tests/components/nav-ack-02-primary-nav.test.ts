import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// NAV-ACK-02 — the PRIMARY navigation adopts the acknowledgement contract.
//
// WHAT THIS SLICE IS. NAV-ACK-01 (#731) shipped `PendingLink` /
// `PendingContainerLink`, proved them in the browser, and adopted them in the
// mobile menu, global search and account menu. It did not touch
// `app/(app)/layout.tsx`, which holds the seven highest-frequency anchors in
// the product and still imported `next/link` directly. This file pins that they
// now use the shipped contract — and that adopting it changed nothing else.
//
// The BEHAVIOURAL proof is e2e/perceived-speed.spec.ts, which drives a real
// held RSC navigation. This file is deliberately not a second copy of it. It
// pins what a browser assertion is bad at localising, and three things it
// cannot see at all:
//
//   1. WHICH FORM. Both exports compile, typecheck, lint and ship on either
//      control. `PendingLink` on the notifications bell would wrap an icon and
//      an absolutely-positioned count badge in ONE in-flow span and fade both
//      to `opacity-0` — the bell would go blank on press. A browser proof
//      catches that only if someone remembers to assert the icon is still
//      painted mid-flight. This catches it at the source.
//   2. DESTINATIONS. An acknowledgement slice may not move an anchor. The
//      seven hrefs are pinned to the exact pre-change set.
//   3. SCOPE. The shell must stay a SERVER component. `PendingLink` is a leaf
//      client island by design; if the shell itself acquires "use client", a
//      clinical page starts hydrating and this slice has cost far more than it
//      bought.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const LAYOUT = "app/(app)/layout.tsx";
const raw = read(LAYOUT);

// The shell DISCUSSES `PendingLink`, `relative` and the rejected label form by
// name when explaining why the bell differs. Prose must not satisfy or trip a
// source assertion.
//
// LINE comments are stripped BEFORE block comments, deliberately: a `//` line
// containing `/*` — a path like `next/*`, a glob — otherwise leaves the block
// stripper eating everything to the next `*/`, silently removing real code and
// making every "does not contain" assertion vacuously true. Same ordering, and
// same reason, as tests/components/nav-ack-01-shell-handoff.test.ts.
const codeOnly = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const code = codeOnly(raw);

/** The seven anchors, and the form each one must take. */
const ANCHORS = [
  { testId: "nav-wordmark", href: "/dashboard", form: "label" },
  { testId: "nav-dashboard", href: "/dashboard", form: "label" },
  { testId: "nav-clients", href: "/clients", form: "label" },
  { testId: "nav-calendar", href: "/calendar", form: "label" },
  { testId: "nav-records", href: "/records", form: "label" },
  { testId: "nav-business", href: "/dashboard/capacity", form: "label" },
  { testId: "nav-notifications", href: "/notifications", form: "container" },
] as const;

describe("NAV-ACK-02 · the comment stripper itself", () => {
  // If the stripper over-eats, every assertion below passes for the wrong
  // reason. Prove it keeps real code and drops real prose.
  it("keeps code and drops prose", () => {
    expect(code).toContain("PendingContainerLink");
    expect(code).toContain('href="/records"');
    // This sentence exists only in a comment in the shell.
    expect(raw).toContain("the only one of the seven that needs it");
    expect(code).not.toContain("the only one of the seven that needs it");
  });
});

describe("NAV-ACK-02 · the primary navigation acknowledges", () => {
  it("imports the shipped primitive and no longer imports next/link", () => {
    expect(code).toMatch(
      /import\s*\{[\s\S]*?PendingContainerLink[\s\S]*?PendingLink[\s\S]*?\}\s*from\s*"@\/components\/pending-link"/,
    );
    // The whole point of the slice: no un-acknowledged anchor remains.
    expect(code).not.toMatch(/from\s*"next\/link"/);
    expect(code).not.toMatch(/<Link[\s>]/);
  });

  it("renders exactly seven acknowledging anchors — six labels, one container", () => {
    const labels = code.match(/<PendingLink[\s>]/g) ?? [];
    const containers = code.match(/<PendingContainerLink[\s>]/g) ?? [];
    expect(labels).toHaveLength(6);
    expect(containers).toHaveLength(1);
  });

  for (const anchor of ANCHORS) {
    it(`${anchor.testId} is present, addressable and points at ${anchor.href}`, () => {
      expect(code).toContain(`data-testid="${anchor.testId}"`);
      expect(code).toContain(`href="${anchor.href}"`);
    });
  }
});

describe("NAV-ACK-02 · the bell takes the CONTAINER form, and only it", () => {
  // THE REJECTED PATCH, pinned. `PendingLink` here compiles and ships and
  // blanks the bell: the label form wraps children in one in-flow span and
  // fades it to opacity-0, taking the icon AND the unread count with it.
  //
  // Located structurally rather than by proximity: the assertion binds to the
  // bell's own testid, so moving the component in the file cannot make it pass
  // for the wrong element.
  const bellTag = /<PendingContainerLink[\s\S]*?data-testid="nav-notifications"[\s\S]*?>/;

  it("is the container form", () => {
    expect(code).toMatch(bellTag);
  });

  it("is NOT the label form", () => {
    expect(code).not.toMatch(
      /<PendingLink[\s\S]{0,400}?data-testid="nav-notifications"/,
    );
  });

  it("does not re-declare `relative` — the primitive owns that class", () => {
    // pending-link.tsx states it owns `relative` precisely so a call site that
    // forgot it cannot let the scrim escape to a distant positioned ancestor.
    // Repeating it here would be harmless today and misleading tomorrow.
    const tag = code.match(bellTag)?.[0] ?? "";
    expect(tag).not.toMatch(/className="[^"]*\brelative\b/);
    // The badge still needs a positioned ancestor, and the primitive is it.
    expect(code).toMatch(/className="absolute -right-0\.5 -top-0\.5/);
  });
});

describe("NAV-ACK-02 · a pending label describes the REQUEST, never the outcome", () => {
  const labels = [...code.matchAll(/pendingLabel="([^"]+)"/g)].map((m) => m[1]);

  it("every anchor carries one", () => {
    expect(labels).toHaveLength(ANCHORS.length);
  });

  it("names the destination and stays in flight", () => {
    for (const label of labels) {
      // "Opening Records…", never "Opened" / "Loaded" / "Done".
      expect(label).toMatch(/^Opening .+…$/);
      expect(label).not.toMatch(/\b(Opened|Loaded|Done|Ready|Complete)\b/i);
    }
    // Distinct destinations get distinct sentences; the two /dashboard anchors
    // (wordmark + tab) legitimately share one.
    expect(new Set(labels).size).toBe(6);
  });
});

describe("NAV-ACK-02 · adopting the contract changed nothing else", () => {
  it("the shell stays a SERVER component", () => {
    // PendingLink is a leaf client island. If the shell itself hydrates, every
    // server-rendered clinical page under it pays for this slice.
    expect(raw).not.toMatch(/^"use client";/m);
  });

  it("introduces no active-state semantics", () => {
    // The primary nav has never marked a current tab. Adding `aria-current`
    // here would be a product change riding inside an acknowledgement slice —
    // and would change what a screen reader reports on every page.
    expect(code).not.toContain("aria-current");
  });

  it("keeps the accessible names the two icon/wordmark controls already had", () => {
    expect(code).toContain('aria-label="Go to Dashboard"');
    expect(code).toContain("aria-label={label}");
  });

  it("adds no dependency, provider or second mechanism", () => {
    expect(code).not.toContain("useLinkStatus");
    expect(code).not.toContain("useTransition");
    expect(code).not.toContain("useState");
    expect(code).not.toContain("onClick");
  });

  it("leaves the desktop-only mode boundary at lg, untouched", () => {
    // PR #228: the horizontal nav is desktop-only; the compact shell uses the
    // menu instead. An acknowledgement must not change WHICH shell renders.
    expect(code).toMatch(/className="hidden items-center gap-0\.5 whitespace-nowrap text-sm lg:flex lg:gap-1"/);
  });
});
