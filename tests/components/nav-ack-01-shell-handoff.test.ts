import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// NAV-ACK-01 supporting guards — DESIGN.md contract 2d.
//
// The BEHAVIOURAL proof is e2e/perceived-speed.spec.ts, which holds a real RSC
// navigation open and asserts "panel gone + acknowledgement still visible".
// This file is not a second copy of it. It pins the properties a browser
// assertion is bad at localising, and one it cannot see at all:
//
//   1. THE REJECTED PATCH. Swapping these <Link>s for PendingLink compiles,
//      typechecks, lints and ships — and acknowledges NOTHING, because
//      useLinkStatus must run inside a subtree these surfaces unmount on the
//      very click that starts the navigation. A browser proof catches it only
//      if someone remembers to assert after the panel is gone. This guard
//      catches it at the source.
//   2. HOST PERSISTENCE. The acknowledgement must render OUTSIDE the `open`
//      guard. Inside it, it dies with the panel.
//   3. THE LIVE REGION. role="status" must be mounted unconditionally; a
//      status node inserted already containing its message is not reliably
//      announced (components/pending-link.tsx records that bug shipping once).
//   4. ONE VOICE. The mark must be aria-hidden, or the spinner announces
//      alongside the live region and the state is read twice.
//   5. LINK SEMANTICS. Modified clicks must reach the real href.
//   6. SCOPE. NAV-ACK-01 is bounded to two files and must not acquire a
//      dependency, a provider, or a third surface.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const MOBILE_MENU = "app/(app)/MobileMenu.tsx";
const GLOBAL_SEARCH = "app/(app)/GlobalSearch.tsx";

// Both files DISCUSS PendingLink, useLinkStatus and the withdrawn mechanisms by
// name when explaining what they refuse to do. Prose must not satisfy or trip a
// source assertion.
//
// LINE comments are stripped BEFORE block comments, deliberately. A `//` line
// that contains `/*` — a path like `next/*`, a glob — otherwise leaves the
// block stripper eating everything to the next `*/`, silently removing real
// code and making every "does not contain" assertion vacuously true.
const codeOnly = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const SURFACES = [
  { name: "MobileMenu", rel: MOBILE_MENU },
  { name: "GlobalSearch", rel: GLOBAL_SEARCH },
] as const;

describe("NAV-ACK-01 · the comment stripper itself", () => {
  // If the stripper over-eats, every assertion below passes for the wrong
  // reason. Prove it keeps real code and drops real prose.
  for (const { name, rel } of SURFACES) {
    it(`${name}: keeps code and drops prose`, () => {
      const code = codeOnly(read(rel));
      expect(code).toContain("useTransition");
      expect(code).toContain("startNav");
      expect(code).toContain('role="status"');
      // This phrase exists ONLY inside a line comment in both files.
      expect(code).not.toContain("NAV-ACK-01");
    });
  }
});

describe("NAV-ACK-01 · the rejected control-local patch cannot return", () => {
  for (const { name, rel } of SURFACES) {
    it(`${name}: does not use PendingLink / PendingContainerLink / useLinkStatus`, () => {
      const code = codeOnly(read(rel));
      expect(code).not.toContain("PendingLink");
      expect(code).not.toContain("PendingContainerLink");
      expect(code).not.toContain("useLinkStatus");
    });
  }
});

describe("NAV-ACK-01 · the acknowledgement host outlives the panel", () => {
  for (const { name, rel } of SURFACES) {
    it(`${name}: the mark and the live region render outside the open guard`, () => {
      const code = codeOnly(read(rel));
      // The panel is the only thing gated on `open` — `{open && (` in
      // MobileMenu, `const panel = open && (` in GlobalSearch.
      expect(code).toMatch(/(?:\{|=)\s*open\s*&&/);
      // The acknowledgement is gated on navPending, never on open.
      expect(code).toContain('data-nav-pending="true"');
      expect(code).not.toMatch(/open\s*&&[\s\S]{0,400}data-nav-pending/);

      // THE LIVE REGION TOO. This test's name has always claimed "and the live
      // region", but only the VISUAL mark above was ever pinned. Moving just
      // the sr-only region inside the panel leaves the spinner correct and
      // unmounts the ONE voice along with the panel — the navigation is then
      // acknowledged to a screen reader by nothing at all. That is contract
      // 2d's exact failure mode (it compiles, it ships, it announces silently
      // nothing), and it passed this file until NAV-ACK-01 was refreshed onto
      // SIGNOUT-01 and the gap was found by mutation.
      //
      // Structural, not textual: on BOTH surfaces the region is emitted before
      // the panel is introduced (`{open && (` in MobileMenu, `const panel =
      // open && (` in GlobalSearch), so "outside the guard" is exactly "before
      // the first guard".
      const status = code.search(/<span\s+role="status"/);
      const guard = code.search(/(?:\{|=)\s*open\s*&&/);
      expect(status, `${name}: the live region exists`).toBeGreaterThan(-1);
      expect(guard, `${name}: the panel is gated on open`).toBeGreaterThan(-1);
      expect(
        status,
        `${name}: role="status" must render OUTSIDE the open guard, or the acknowledgement dies with the panel`,
      ).toBeLessThan(guard);
    });

    it(`${name}: role="status" is mounted unconditionally, empty at rest`, () => {
      const code = codeOnly(read(rel));
      // Not `{navPending && <span role="status"`  — the node must always exist
      // and only its TEXT may change.
      expect(code).not.toMatch(/navPending\s*&&\s*\(?\s*<span\s+role="status"/);
      expect(code).toMatch(/<span\s+role="status"\s+className="sr-only">/);
      expect(code).toMatch(/:\s*""/);
    });

    it(`${name}: the mark is aria-hidden, so the state is announced once`, () => {
      const code = codeOnly(read(rel));
      const marks = code.split('data-nav-pending="true"').slice(1);
      expect(marks.length).toBeGreaterThan(0);
      for (const after of marks) {
        expect(after.slice(0, 120)).toContain('aria-hidden="true"');
      }
      // The announcing form of the spinner primitive would be a second voice.
      expect(code).not.toMatch(/<Spinner[^>]*\blabel=/);
    });

    it(`${name}: reduced motion comes from the spinner primitive, not a local animation`, () => {
      const code = codeOnly(read(rel));
      expect(code).toContain("spinnerClasses");
      expect(code).not.toContain("animate-spin");
    });
  }
});

describe("NAV-ACK-01 · ordinary link semantics survive", () => {
  for (const { name, rel } of SURFACES) {
    it(`${name}: modified and non-primary clicks are handed to the browser`, () => {
      const code = codeOnly(read(rel));
      for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) {
        expect(code).toContain(`e.${key}`);
      }
      expect(code).toContain("e.button !== 0");
      expect(code).toContain("e.defaultPrevented");
      // Still real anchors with a real href — not buttons calling push().
      expect(code).toContain("<Link");
      expect(code).toContain("href=");
    });

    it(`${name}: duplicate navigation is blocked by a ref, not by the pending flag`, () => {
      const code = codeOnly(read(rel));
      // `navPending` does not turn true until the next render, so it cannot
      // catch a double-tap delivering two clicks in one tick.
      expect(code).toContain("navLockRef");
      expect(code).toMatch(/if\s*\(\s*navLockRef\.current\s*\)/);
      // Released on the pending EDGE, never by a timer.
      expect(code).not.toMatch(/setTimeout\([^)]*navLock/);
      expect(code).toMatch(/if\s*\(!navPending\)\s*navLockRef\.current\s*=\s*false/);
    });

    it(`${name}: a same-route activation arms nothing, so it cannot strand`, () => {
      const code = codeOnly(read(rel));
      // React holds a transition pending until it COMMITS, and pushing the URL
      // you are already on never produces a commit. Measured: the mark stayed
      // up for a full 30s timeout before this guard existed.
      expect(code).toContain("new URL(href, window.location.href)");
      expect(code).toContain("target.pathname === window.location.pathname");
      expect(code).toContain("target.search === window.location.search");
      // And the lock must be taken AFTER that check, or the no-op path leaves
      // it armed and blocks the next real navigation.
      const body = code.slice(code.indexOf("function navigate"));
      const sameRouteAt = body.indexOf("target.pathname === window.location.pathname");
      const lockAt = body.indexOf("navLockRef.current = true");
      expect(sameRouteAt).toBeGreaterThan(-1);
      expect(lockAt).toBeGreaterThan(sameRouteAt);
    });

    it(`${name}: an anchor on the CURRENT page still navigates, and is not armed`, () => {
      const code = codeOnly(read(rel));
      // Codex P2 on #731. lib/search/navigation-registry.ts ships 34 anchored
      // destinations, so "same pathname + search" does NOT imply "nothing to
      // do". Selecting /settings/booking#buffer while already on
      // /settings/booking must still scroll to the control and update the URL
      // — this path runs AFTER preventDefault(), so returning early makes the
      // press do literally nothing.
      expect(
        code,
        `${name}: the hash must take part in the no-op decision`,
      ).toContain("target.hash !== window.location.hash");

      const body = code.slice(code.indexOf("function navigate"));
      const hashAt = body.indexOf("target.hash !== window.location.hash");
      const lockAt = body.indexOf("navLockRef.current = true");
      expect(hashAt).toBeGreaterThan(-1);
      // Pushed, but NOT armed: an in-page anchor jump commits synchronously,
      // so there is no pending interval to acknowledge and arming it could
      // strand the mark exactly as a same-route push once did.
      expect(
        lockAt,
        `${name}: the hash-only push must be issued before anything is armed`,
      ).toBeGreaterThan(hashAt);
      const hashBranch = body.slice(hashAt, lockAt);
      expect(
        hashBranch,
        `${name}: the hash-only branch must push`,
      ).toContain("router.push(href)");
      expect(
        hashBranch,
        `${name}: the hash-only branch must not arm the acknowledgement`,
      ).not.toContain("startNav(");
    });

    it(`${name}: focus is moved to a persistent control before the panel unmounts`, () => {
      const code = codeOnly(read(rel));
      expect(code).toMatch(/\.focus\(\)/);
      expect(code).toContain("close()");
    });
  }
});

describe("NAV-ACK-01 · scope stays bounded", () => {
  it("adds no dependency", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = Object.keys({
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    });
    for (const banned of [
      "nprogress",
      "@tanstack/react-router",
      "framer-motion",
      "motion",
      "react-transition-group",
    ]) {
      expect(all).not.toContain(banned);
    }
  });

  it("creates no navigation provider or global route-progress surface", () => {
    for (const { rel } of SURFACES) {
      const code = codeOnly(read(rel));
      expect(code).not.toContain("createContext");
      expect(code).not.toContain("Provider");
    }
  });

  it("MobileMenu's Business destination is unchanged (#666 is not revived)", () => {
    const code = codeOnly(read(MOBILE_MENU));
    expect(code).toContain('href: "/dashboard/capacity"');
    expect(code).not.toContain('"/business"');
  });

  it("GlobalSearch still closes AND clears its query", () => {
    const code = codeOnly(read(GLOBAL_SEARCH));
    expect(code).toMatch(/const close = \(\) => \{[\s\S]{0,120}setQuery\(""\)/);
  });

  it("MobileMenu still closes on every link tap, including the current page's", () => {
    const code = codeOnly(read(MOBILE_MENU));
    // Every nav Link routes through navigate(), and navigate() always closes.
    expect(code).not.toContain("onClick={close}\n              />");
    const navigateBody = code.slice(code.indexOf("function navigate"));
    expect(navigateBody.slice(0, 1200)).toContain("close()");
  });
});
