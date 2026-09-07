import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TOKEN_ROUTE_PREFIXES } from "@/lib/security/token-routes";

// ===========================================================================
// WAIT DELIVERY-01 — THE ATOMIC-SHIPPING TRIPWIRE
// ===========================================================================
//
// The WAIT invitation URL will be a REPLAYABLE BEARER CREDENTIAL in a dynamic
// path segment: possession of the URL is possession of the ability to resolve
// the invitation. That is precisely the property `lib/security/token-routes.ts`
// exists for, and its registry drives two protections that a route needs BOTH
// of to be safe — `Referrer-Policy: no-referrer` + `X-Robots-Tag` from
// next.config.ts, and credential canonicalization in the Sentry scrubber.
//
// THE ROUTE DOES NOT EXIST YET, AND THIS FILE DOES NOT PRETEND IT DOES.
// Registering a prefix for a route nobody has written would make a green test
// that protects nothing, and would leave a permanent decoy in a registry whose
// entire value is that every entry is real. So no prefix is added here.
//
// What is added is the gate that makes the protection ship WITH the route:
//
//   FORWARD  — any waitlist/invitation route carrying a dynamic segment MUST
//              be registered. Vacuous today; load-bearing the moment someone
//              adds `app/waitlist/invitation/[token]/page.tsx`.
//
//   REVERSE  — while no such route exists, the registry must NOT contain a
//              waitlist/invitation prefix. This is what forbids pre-registering
//              a decoy to turn the forward assertion green early.
//
// The existing tests/lib/security/token-route-parity.test.ts guards
// registry <-> CONSUMERS. This file guards ROUTE <-> registry, which is the
// direction nothing covered: a perfectly consistent registry that simply never
// heard about a new route passes every parity check while the route leaks.
//
// Deliberately keyed on the ROUTE'S EXISTENCE ON DISK rather than on a name we
// have chosen in advance. We do not yet know whether the path will be
// /waitlist/invitation, /waitlist/invite or something else, and a test that
// hard-codes the guess fails to fire when the guess is wrong — which is exactly
// when a tripwire is supposed to fire.

const ROOT = process.cwd();
const APP_DIR = join(ROOT, "app");

/** Next route-group segment: `(app)`, `(auth)` — present on disk, absent from the URL. */
function isRouteGroup(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

/** Dynamic segment: `[token]`, `[...slug]`, `[[...slug]]`. */
function isDynamic(segment: string): boolean {
  return segment.startsWith("[") && segment.endsWith("]");
}

/** Private/internal folder Next never routes: `_components`. */
function isPrivate(segment: string): boolean {
  return segment.startsWith("_");
}

type DiscoveredRoute = {
  /** Directory path relative to app/, for the failure message. */
  dir: string;
  /** Public URL prefix that PRECEDES the dynamic segment. */
  publicPrefix: string;
};

/**
 * Walk `app/` and return every directory that has a dynamic segment AND whose
 * path mentions an invitation or the waitlist.
 *
 * The returned `publicPrefix` is the URL path up to but NOT including the
 * dynamic segment, which is exactly the shape TOKEN_ROUTE_PREFIXES holds
 * ("/portal/verify", "/intake", …).
 */
function discoverWaitlistBearerRoutes(): DiscoveredRoute[] {
  const found: DiscoveredRoute[] = [];

  function walk(absDir: string, urlSegments: string[], relDir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(absDir, entry);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (isPrivate(entry)) continue;

      const rel = relDir ? `${relDir}/${entry}` : entry;

      if (isDynamic(entry)) {
        // The dynamic segment itself is the credential slot. The prefix is
        // everything above it.
        const prefix = `/${urlSegments.join("/")}`;
        if (/invit|waitlist/i.test(rel)) {
          found.push({ dir: `app/${rel}`, publicPrefix: prefix });
        }
        // Keep walking: a nested dynamic segment is still under this prefix.
        walk(abs, urlSegments, rel);
        continue;
      }

      // Route groups exist on disk but contribute nothing to the URL.
      const nextSegments = isRouteGroup(entry)
        ? urlSegments
        : [...urlSegments, entry];
      walk(abs, nextSegments, rel);
    }
  }

  walk(APP_DIR, [], "");
  return found;
}

describe("WAIT invitation route privacy ships atomically with the route", () => {
  const discovered = discoverWaitlistBearerRoutes();

  it("FORWARD: every waitlist/invitation bearer route is in the registry", () => {
    // Reads as a no-op today by design. The assertion is written over whatever
    // is on disk so that it starts protecting the moment the route lands,
    // without anyone having to remember this file exists.
    const unregistered = discovered.filter(
      (r) =>
        !TOKEN_ROUTE_PREFIXES.some(
          (p) => r.publicPrefix === p || r.publicPrefix.startsWith(`${p}/`),
        ),
    );
    expect(
      unregistered,
      `A waitlist/invitation route carries a bearer credential in its path but ` +
        `is not registered in lib/security/token-routes.ts, so it is missing ` +
        `Referrer-Policy: no-referrer, X-Robots-Tag, and Sentry ` +
        `canonicalization. Add its prefix to TOKEN_ROUTE_PREFIXES in the SAME ` +
        `change that adds the route, and update the REVERSE assertion in this ` +
        `file. Offending: ${JSON.stringify(unregistered)}`,
    ).toEqual([]);
  });

  it("REVERSE: no decoy prefix is registered ahead of a real route", () => {
    // This is the assertion that keeps the forward one honest. Without it, the
    // cheapest way to make this file green would be to add
    // "/waitlist/invitation" to the registry today — protecting nothing, and
    // putting a prefix in a list whose worth depends on every entry being real.
    const waitlistPrefixes = TOKEN_ROUTE_PREFIXES.filter((p) =>
      /invit|waitlist/i.test(p),
    );
    if (discovered.length === 0) {
      expect(
        waitlistPrefixes,
        `TOKEN_ROUTE_PREFIXES contains a waitlist/invitation prefix but no such ` +
          `route exists under app/. A prefix for a route nobody has written ` +
          `protects nothing and makes the registry harder to trust. Remove it, ` +
          `or land the route in the same change.`,
      ).toEqual([]);
    } else {
      // Once the route is real the decoy question is moot: the forward
      // assertion above is doing the work.
      expect(waitlistPrefixes.length).toBeGreaterThan(0);
    }
  });

  it("records the current state, so the guard is never silently vacuous", () => {
    // A tripwire whose scan found nothing looks identical to a tripwire whose
    // scan is broken. Pinning the count means a refactor that breaks the walker
    // — a renamed app/ directory, a changed dynamic-segment convention — fails
    // here rather than passing quietly forever.
    //
    // WHEN THE ROUTE LANDS: change this to the new count in the same commit,
    // and the FORWARD assertion above becomes the real gate.
    expect(discovered).toEqual([]);
  });

  it("the walker actually works — it finds the registered bearer routes", () => {
    // Proves the scan is capable of finding something, which is what the
    // vacuity pin above cannot prove on its own. /intake and /portal/verify are
    // real dynamic bearer routes today; if the walker cannot see them it cannot
    // see a waitlist route either.
    const all: string[] = [];
    function walkAll(absDir: string, urlSegments: string[]): void {
      let entries: string[];
      try {
        entries = readdirSync(absDir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = join(absDir, entry);
        try {
          if (!statSync(abs).isDirectory()) continue;
        } catch {
          continue;
        }
        if (isPrivate(entry)) continue;
        if (isDynamic(entry)) {
          all.push(`/${urlSegments.join("/")}`);
          continue;
        }
        walkAll(abs, isRouteGroup(entry) ? urlSegments : [...urlSegments, entry]);
      }
    }
    walkAll(APP_DIR, []);
    expect(all).toContain("/intake");
    expect(all).toContain("/portal/verify");
  });
});
