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
// the invitation. That is the property `lib/security/token-routes.ts` exists
// for, and its registry drives two protections a route needs BOTH of —
// `Referrer-Policy: no-referrer` + `X-Robots-Tag` from next.config.ts, and
// credential canonicalization in the Sentry scrubber.
//
// THE ROUTE DOES NOT EXIST YET, AND THIS FILE DOES NOT PRETEND IT DOES.
// Registering a prefix for a route nobody has written would make a green test
// that protects nothing, and would leave a permanent decoy in a registry whose
// entire value is that every entry is real. So no prefix is added here.
//
// ===========================================================================
// WHY THIS ENUMERATES EVERY DYNAMIC ROUTE INSTEAD OF LOOKING FOR A NAME
// ===========================================================================
//
// The first version of this gate matched directory paths against
// /invit|waitlist/ and asked whether those were registered. Review found the
// hole, and it was CONFIRMED by experiment rather than argued: adding
// `app/opening/[token]/page.tsx` — an unregistered bearer route by any
// reasonable reading — left the scan empty and every assertion green.
//
// A guard whose whole purpose is to fire when a route appears under a name
// nobody predicted cannot itself depend on predicting the name. So the default
// is inverted. EVERY public dynamic route is enumerated, and each one must be
// either:
//
//   * REGISTERED in TOKEN_ROUTE_PREFIXES — it carries a bearer credential; or
//   * explicitly CLASSIFIED NON-BEARER below, with the reason written down.
//
// A dynamic route that is neither FAILS. That is the same "unattributable code
// fails safe to the stricter treatment, never the narrower one" rule CLAUDE.md
// §3 already applies to browser coverage, and it means a future
// `/opening/[token]`, `/wait-list/[token]` or anything else lands in the
// failing branch by default rather than sliding through a name filter.
//
// tests/lib/security/token-route-parity.test.ts guards registry <-> CONSUMERS.
// This file guards ROUTE <-> registry, the direction nothing covered: a
// perfectly consistent registry that simply never heard about a new route
// passes every parity check while the route leaks.

const ROOT = process.cwd();
const APP_DIR = join(ROOT, "app");

/**
 * Dynamic routes whose segment is NOT a bearer credential.
 *
 * Each entry is a claim that possession of the URL grants nothing on its own —
 * either the segment is an opaque row id behind authentication, or it is
 * deliberately public information. Adding a line here is the reviewed act of
 * saying so; it is not a way to silence the gate, and a route that genuinely
 * carries a credential belongs in TOKEN_ROUTE_PREFIXES instead.
 */
const CLASSIFIED_NON_BEARER: ReadonlyArray<{ prefix: string; why: string }> = [
  { prefix: "/admin/studios", why: "platform-operator surface behind isAdmin; the segment is a studio row id, not a credential" },
  { prefix: "/book", why: "public booking page keyed by the studio's PUBLIC slug — the slug is meant to be shared" },
  { prefix: "/calendar", why: "authenticated app route; the segment is an appointment row id" },
  { prefix: "/clients", why: "authenticated app route; the segment is a client row id" },
  { prefix: "/clients/sessions", why: "authenticated app route; the segment is a session row id" },
  { prefix: "/e2e-fault", why: "E2E fault-injection harness, not a production surface" },
];

/** Next route-group segment: `(app)`, `(auth)` — on disk, absent from the URL. */
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
  /** Directory path relative to the repo root, for the failure message. */
  dir: string;
  /** Public URL prefix that PRECEDES the dynamic segment. */
  publicPrefix: string;
};

/**
 * Every public dynamic route under `app/`.
 *
 * `publicPrefix` is the URL path up to but NOT including the dynamic segment,
 * which is exactly the shape TOKEN_ROUTE_PREFIXES holds ("/portal/verify",
 * "/intake", …).
 */
function discoverDynamicRoutes(): DiscoveredRoute[] {
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
        // The dynamic segment itself is the credential slot, if it is one at
        // all. The prefix is everything above it.
        found.push({ dir: `app/${rel}`, publicPrefix: `/${urlSegments.join("/")}` });
        // Keep walking: a nested dynamic segment sits under the same prefix.
        walk(abs, urlSegments, rel);
        continue;
      }

      walk(abs, isRouteGroup(entry) ? urlSegments : [...urlSegments, entry], rel);
    }
  }

  walk(APP_DIR, [], "");
  return found;
}

function isRegisteredBearer(prefix: string): boolean {
  return TOKEN_ROUTE_PREFIXES.some(
    (p) => prefix === p || prefix.startsWith(`${p}/`),
  );
}

function isClassifiedNonBearer(prefix: string): boolean {
  return CLASSIFIED_NON_BEARER.some(
    (e) => prefix === e.prefix || prefix.startsWith(`${e.prefix}/`),
  );
}

describe("every dynamic route is classified, so a bearer route cannot arrive unnoticed", () => {
  const discovered = discoverDynamicRoutes();

  it("finds the dynamic routes that actually exist", () => {
    // A scan that silently returns nothing looks identical to a scan that is
    // broken. Anchoring on routes known to exist proves the walker works, which
    // is what makes every assertion below meaningful.
    const prefixes = discovered.map((r) => r.publicPrefix);
    expect(prefixes).toContain("/intake");
    expect(prefixes).toContain("/portal/verify");
    expect(prefixes).toContain("/clients");
    expect(discovered.length).toBeGreaterThanOrEqual(10);
  });

  it("UNKNOWN dynamic route => FAIL (this is the gate)", () => {
    const unclassified = discovered.filter(
      (r) => !isRegisteredBearer(r.publicPrefix) && !isClassifiedNonBearer(r.publicPrefix),
    );
    expect(
      unclassified,
      `A public dynamic route is neither registered in ` +
        `lib/security/token-routes.ts nor classified non-bearer in this file.\n\n` +
        `If its segment is a BEARER CREDENTIAL — anyone holding the URL can act ` +
        `— add its prefix to TOKEN_ROUTE_PREFIXES in the SAME change that adds ` +
        `the route, or it ships without Referrer-Policy: no-referrer, ` +
        `X-Robots-Tag and Sentry canonicalization.\n\n` +
        `If it is an authenticated row id or deliberately public, add it to ` +
        `CLASSIFIED_NON_BEARER with the reason.\n\n` +
        `Offending: ${JSON.stringify(unclassified, null, 2)}`,
    ).toEqual([]);
  });

  it("no route is BOTH registered and classified non-bearer", () => {
    // The two lists answer the same question and must not disagree. A prefix in
    // both means someone recorded a route as harmless while also protecting it,
    // and the next reader cannot tell which claim is current.
    const both = discovered
      .map((r) => r.publicPrefix)
      .filter((p) => isRegisteredBearer(p) && isClassifiedNonBearer(p));
    expect(both).toEqual([]);
  });

  it("every CLASSIFIED_NON_BEARER entry still corresponds to a real route", () => {
    // Keeps the allowlist from accumulating entries for routes that were
    // deleted or renamed, which is how an allowlist quietly stops describing
    // the system it is supposed to describe.
    const prefixes = new Set(discovered.map((r) => r.publicPrefix));
    const stale = CLASSIFIED_NON_BEARER.filter(
      (e) => ![...prefixes].some((p) => p === e.prefix || p.startsWith(`${e.prefix}/`)),
    ).map((e) => e.prefix);
    expect(stale).toEqual([]);
  });

  it("every CLASSIFIED_NON_BEARER entry states a reason", () => {
    for (const e of CLASSIFIED_NON_BEARER) {
      expect(e.why.trim().length, `${e.prefix} needs a reason`).toBeGreaterThan(20);
    }
  });
});

describe("no decoy prefix is registered ahead of a real route", () => {
  it("REVERSE: a waitlist/invitation prefix requires a waitlist/invitation route", () => {
    // This keeps the gate above honest. Without it, the cheapest way to make a
    // future waitlist route pass would be to register its prefix early —
    // protecting nothing, and putting an entry in a registry whose worth
    // depends on every entry being real.
    const discovered = discoverDynamicRoutes();
    const waitlistPrefixes = TOKEN_ROUTE_PREFIXES.filter((p) =>
      /invit|waitlist/i.test(p),
    );
    const waitlistRoutes = discovered.filter((r) => /invit|waitlist/i.test(r.dir));
    if (waitlistRoutes.length === 0) {
      expect(
        waitlistPrefixes,
        `TOKEN_ROUTE_PREFIXES contains a waitlist/invitation prefix but no such ` +
          `route exists under app/. A prefix for a route nobody has written ` +
          `protects nothing. Remove it, or land the route in the same change.`,
      ).toEqual([]);
    } else {
      expect(waitlistPrefixes.length).toBeGreaterThan(0);
    }
  });
});
