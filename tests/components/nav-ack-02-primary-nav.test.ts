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
const NAVLINK = "app/(app)/PrimaryNavLink.tsx";
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
const navCode = codeOnly(read(NAVLINK));

/** The seven anchors, and the form each one must take. */
const ANCHORS = [
  { testId: "nav-wordmark", href: "/dashboard", form: "label", attr: "data-testid" },
  { testId: "nav-dashboard", href: "/dashboard", form: "label", attr: "testId" },
  { testId: "nav-clients", href: "/clients", form: "label", attr: "testId" },
  { testId: "nav-calendar", href: "/calendar", form: "label", attr: "testId" },
  { testId: "nav-records", href: "/records", form: "label", attr: "testId" },
  { testId: "nav-business", href: "/dashboard/capacity", form: "label", attr: "testId" },
  { testId: "nav-notifications", href: "/notifications", form: "container", attr: "data-testid" },
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
    // UX-01 QW2 moved the five SECTION links into `PrimaryNavLink`, a client
    // leaf that renders `PendingLink` itself (it needs `usePathname`, which a
    // server layout cannot call). The count below therefore treats a
    // `<PrimaryNavLink>` as what it is — one label-form acknowledging anchor —
    // rather than reading a smaller number and calling it a pass. The wordmark
    // is still a direct `PendingLink` here; the bell is still the container.
    //
    // The delegation is proved, not assumed: `PrimaryNavLink` must itself
    // render the shipped primitive, asserted below.
    const labels = code.match(/<PendingLink[\s>]/g) ?? [];
    const sections = code.match(/<PrimaryNavLink[\s>]/g) ?? [];
    const containers = code.match(/<PendingContainerLink[\s>]/g) ?? [];
    expect(labels.length + sections.length).toBe(6);
    expect(containers).toHaveLength(1);
  });

  it("the section leaf really delegates to the shipped primitive", () => {
    // Without this, the count above could be satisfied by a component that
    // renders a bare <a> and acknowledges nothing.
    expect(navCode).toContain('from "@/components/pending-link"');
    expect(navCode.match(/<PendingLink[\s>]/g) ?? []).toHaveLength(1);
    expect(navCode).not.toMatch(/from\s*"next\/link"/);
    expect(navCode).not.toMatch(/<Link[\s>]/);
    expect(navCode).toContain("pendingLabel={pendingLabel}");
  });

  for (const anchor of ANCHORS) {
    it(`${anchor.testId} is present, addressable and points at ${anchor.href}`, () => {
      // The five section links pass their id through `PrimaryNavLink`'s
      // `testId` prop, which that component spreads onto the rendered anchor as
      // `data-testid`; the wordmark and bell still set the DOM attribute
      // directly. Both spellings are the same fact, so the table names which
      // one each anchor uses rather than accepting either.
      expect(code).toContain(`${anchor.attr}="${anchor.testId}"`);
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

  // SUPERSEDED, deliberately and by owner decision — not quietly.
  //
  // This assertion used to read `expect(code).not.toContain("aria-current")`,
  // and its reason was sound: adding a current-section state inside an
  // ACKNOWLEDGEMENT slice would have been a product change riding in on
  // unrelated work. NAV-ACK-02 correctly refused it.
  //
  // UX-01 QW2 is that product change, made deliberately and authorized on its
  // own terms. The old assertion is replaced rather than deleted, because
  // leaving it would have passed for the wrong reason: QW2 puts `aria-current`
  // in `PrimaryNavLink.tsx`, so a scan of `layout.tsx` alone would have gone on
  // reporting "no active-state semantics" while the product had them.
  //
  // What replaces it keeps the part that still matters — the state is bounded,
  // exactly one section can claim it, and it arrived without a provider.
  it("marks the current section, and marks exactly one", () => {
    expect(navCode).toContain('aria-current={current ? "page" : undefined}');
    // One source of truth for "am I current", so two anchors cannot both claim
    // it and none can drift to a different rule.
    expect(navCode.match(/aria-current/g) ?? []).toHaveLength(1);
    expect(navCode).toContain("isCurrentSection");
  });

  it("the current-section rule distinguishes Dashboard from Business", () => {
    // `/dashboard` and `/dashboard/capacity` are two DIFFERENT nav entries, so
    // a bare prefix match lights both on the capacity page. Dashboard is
    // therefore `exact` and every other section owns its subtree.
    expect(code).toMatch(/href="\/dashboard"\s+match="exact"/);
    expect(code).toMatch(/href="\/dashboard\/capacity"\s+match="section"/);
    expect(code).toMatch(/href="\/clients"\s+match="section"/);
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
