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
  { prefix: "/clients/[id]/sessions", why: "authenticated app route nested under a client; the segment is a session row id and the client id above it is equally not a credential" },
  { prefix: "/e2e-fault", why: "E2E fault-injection harness, not a production surface" },
];

/** Next route-group segment: `(app)`, `(auth)` — on disk, absent from the URL. */
function isRouteGroup(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

/**
 * Next PARALLEL-ROUTE slot: `@modal`, `@sidebar`. On disk, absent from the URL,
 * exactly like a route group.
 *
 * Treating it as a normal segment produced a FICTIONAL prefix — a bearer route
 * at `app/@modal/opening/[token]` was reported as `/@modal/opening` when the
 * real URL is `/opening`. The gate did fail, but the remediation it named was
 * the trap: registering `/@modal/opening` turns this file green while the
 * actual `/opening/<token>` receives neither the privacy headers nor Sentry
 * canonicalization. A guard that names the wrong fix is worse than one that
 * stays silent, because someone will follow it.
 */
function isParallelSlot(segment: string): boolean {
  return segment.startsWith("@");
}

/**
 * Next INTERCEPTING-ROUTE marker: `(.)photo`, `(..)photo`, `(...)photo`.
 *
 * Same class of problem, found while fixing the slot case. These render at the
 * INTERCEPTED path, which is not where the directory sits, so this walker
 * cannot compute their public URL at all — `(.)opening` under `app/feed/`
 * produced `/feed/(.)opening`, another path that does not exist.
 *
 * Rather than guess, the scan REFUSES: an intercepting route carrying a dynamic
 * segment fails the gate with a message saying the mapping is unavailable. That
 * is the file's standing rule — unattributable gets the stricter treatment,
 * never the convenient one — applied to a segment type nobody had considered.
 *
 * Note the ordering dependency: a route GROUP also starts with "(", so this
 * must be tested before `isRouteGroup`, or `(.)x` would be silently swallowed
 * as a group and vanish from the URL entirely.
 */
function isInterceptingRoute(segment: string): boolean {
  return /^\(\.{1,3}\)/.test(segment);
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
 * Whether any descendant of this directory is a dynamic segment.
 *
 * Used to keep the interceptor refusal narrow: only an interceptor that could
 * carry a bearer credential is the gate's business. A static one is somebody
 * else's feature.
 */
function containsDynamicSegment(absDir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    const abs = join(absDir, entry);
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    if (isPrivate(entry)) continue;
    if (isDynamic(entry)) return true;
    if (containsDynamicSegment(abs)) return true;
  }
  return false;
}

/** A dynamic route whose public URL this walker cannot compute. */
type UnmappableRoute = { dir: string; why: string };

const unmappable: UnmappableRoute[] = [];

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

      if (isInterceptingRoute(entry)) {
        // Renders at the INTERCEPTED path, which is not this directory, so any
        // prefix built from here would be fiction and the walker must not
        // descend normally.
        //
        // BUT ONLY REPORT IT IF IT ACTUALLY CARRIES A BEARER-SHAPED SEGMENT.
        // The first version refused every interceptor on sight, which failed
        // the gate for a perfectly ordinary static route like
        // `app/feed/(.)photo/page.tsx` — no dynamic segment, no credential,
        // nothing this file has any stake in. A guard that blocks work it has
        // no interest in gets worked around, and then it protects nothing.
        if (containsDynamicSegment(abs)) {
          unmappable.push({
            dir: `app/${rel}`,
            why: "intercepting route containing a dynamic segment — it renders at the intercepted path, which this scan cannot resolve",
          });
        }
        continue;
      }

      if (isDynamic(entry)) {
        // The dynamic segment itself is the credential slot, if it is one at
        // all. The prefix is everything above it.
        found.push({ dir: `app/${rel}`, publicPrefix: `/${urlSegments.join("/")}` });
        // KEEP THE DYNAMIC ANCESTOR IN THE PATH when descending. An earlier
        // version passed `urlSegments` through unchanged, which was wrong in
        // both directions and was confirmed by experiment:
        //
        //   app/book/[slug]/[token]         collapsed to  /book
        //     -> inherited /book's non-bearer classification and passed
        //        silently, though its segment is a bearer credential;
        //   app/book/[slug]/invite/[token]  became        /book/invite
        //     -> a path that does not exist, so the gate reported a route
        //        nobody could find.
        //
        // Carrying `[slug]` through yields /book/[slug] and
        // /book/[slug]/invite: the real patterns, neither of which any
        // classification covers, so both fail closed.
        walk(abs, [...urlSegments, entry], rel);
        continue;
      }

      // Route groups and parallel slots exist on disk and contribute NOTHING
      // to the URL.
      const contributesToUrl = !isRouteGroup(entry) && !isParallelSlot(entry);
      walk(abs, contributesToUrl ? [...urlSegments, entry] : urlSegments, rel);
    }
  }

  unmappable.length = 0;
  walk(APP_DIR, [], "");
  return found;
}

function isRegisteredBearer(prefix: string): boolean {
  return TOKEN_ROUTE_PREFIXES.some(
    (p) => prefix === p || prefix.startsWith(`${p}/`),
  );
}

/**
 * EXACT MATCH ONLY. Deliberately not `startsWith`.
 *
 * The permissive direction must be narrow. Review found that a subtree match
 * blessed unreviewed descendants: classifying `/clients` silently exempted a
 * future `app/clients/share/[token]`, which is discovered as `/clients/share`
 * and would have shipped without the privacy headers or Sentry
 * canonicalization. Confirmed by adding that route and watching the file stay
 * green.
 *
 * So a nested dynamic route gets its own reviewed line or it fails. `/clients`
 * and `/clients/sessions` are two separate entries below for exactly this
 * reason — a person looked at each.
 *
 * `isRegisteredBearer` keeps its prefix match, and the asymmetry is the point:
 * there, matching a subtree means MORE protection (the registry's `:token*`
 * pattern already covers suffix segments), so a broad match errs safe. Here it
 * would mean less.
 */
function isClassifiedNonBearer(prefix: string): boolean {
  return CLASSIFIED_NON_BEARER.some((e) => prefix === e.prefix);
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
    // The nested route keeps its dynamic ancestor rather than collapsing.
    expect(prefixes).toContain("/clients/[id]/sessions");
    expect(prefixes).not.toContain("/clients/sessions");
    expect(discovered.length).toBeGreaterThanOrEqual(10);
  });

  it("a route whose public URL cannot be computed FAILS rather than guessing", () => {
    // An intercepting route renders at the intercepted path, so no prefix built
    // from its directory is real. Emitting one would name a fictional route and
    // invite someone to register it — protecting nothing while turning this
    // file green. Refusing is the stricter treatment, which is this file's
    // standing rule for anything unattributable.
    discoverDynamicRoutes();
    expect(
      unmappable,
      `A dynamic route sits under a segment whose public URL this scan cannot ` +
        `resolve, so it can be neither registered nor classified honestly. ` +
        `Either move it to a literal path, or extend this walker to map it ` +
        `deliberately. Offending: ${JSON.stringify(unmappable, null, 2)}`,
    ).toEqual([]);
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

  it("a nested dynamic route is NOT blessed by its parent's classification", () => {
    // The specific defect, pinned as a property rather than a scenario: no
    // classified entry may be a strict ancestor of another discovered route's
    // prefix unless that descendant is itself classified or registered.
    const prefixes = discoverDynamicRoutes().map((r) => r.publicPrefix);
    const blessedByAncestor = prefixes.filter(
      (p) =>
        !isClassifiedNonBearer(p) &&
        !isRegisteredBearer(p) &&
        CLASSIFIED_NON_BEARER.some((e) => p.startsWith(`${e.prefix}/`)),
    );
    expect(
      blessedByAncestor,
      `These routes sit under a non-bearer classification but are not ` +
        `classified themselves. A parent's line must never vouch for a child: ` +
        `classify or register each one. Offending: ${JSON.stringify(blessedByAncestor)}`,
    ).toEqual([]);
  });

  it("a bearer route under a DYNAMIC ancestor fails closed — the registry cannot express it", () => {
    // TOKEN_ROUTE_PREFIXES holds literal path prefixes, because next.config.ts
    // turns each into a `source` pattern and the Sentry scrubber builds a regex
    // from the same strings. Neither can represent `/book/[slug]`, so a bearer
    // route sitting under a dynamic ancestor CANNOT be protected by the current
    // registry at all.
    //
    // The honest response is to refuse rather than to pretend. Such a route is
    // unclassifiable here, so it lands in the failing branch above and the
    // author has to either restructure the route to a literal prefix or extend
    // the registry deliberately. This assertion states the constraint so the
    // failure message is not a mystery.
    const dynamicAncestor = discovered.filter((r) => r.publicPrefix.includes("["));
    for (const r of dynamicAncestor) {
      expect(
        isRegisteredBearer(r.publicPrefix),
        `${r.dir} sits under a dynamic ancestor, so its prefix ` +
          `"${r.publicPrefix}" cannot appear in TOKEN_ROUTE_PREFIXES — those ` +
          `are literal paths consumed by next.config.ts and the Sentry ` +
          `scrubber. It must be classified non-bearer with a reason, or the ` +
          `route restructured so its prefix is literal.`,
      ).toBe(false);
    }
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
      (e) => !prefixes.has(e.prefix),
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

describe("segment classification — which directories reach the URL", () => {
  // The walker's correctness rests entirely on these. Two segment types were
  // missed in turn, and both produced a FICTIONAL prefix rather than an obvious
  // failure — a bearer route at app/@modal/opening/[token] was reported as
  // /@modal/opening when the real URL is /opening, so following the gate's own
  // remediation would have registered a path that does not exist and left
  // /opening/<token> unprotected. They are pinned directly here rather than
  // only through on-disk fixtures.

  it("route groups and parallel slots contribute NOTHING to the URL", () => {
    expect(isRouteGroup("(app)")).toBe(true);
    expect(isRouteGroup("(auth)")).toBe(true);
    expect(isParallelSlot("@modal")).toBe(true);
    expect(isParallelSlot("@sidebar")).toBe(true);
  });

  it("an ordinary directory contributes to the URL", () => {
    expect(isRouteGroup("clients")).toBe(false);
    expect(isParallelSlot("clients")).toBe(false);
    expect(isInterceptingRoute("clients")).toBe(false);
  });

  it("intercepting markers are recognised at all three depths", () => {
    expect(isInterceptingRoute("(.)photo")).toBe(true);
    expect(isInterceptingRoute("(..)photo")).toBe(true);
    expect(isInterceptingRoute("(...)photo")).toBe(true);
  });

  it("ORDER MATTERS: an interceptor must not be read as a route group", () => {
    // A route group also starts with "(" — but `(.)photo` does not END with
    // ")", so isRouteGroup happens to reject it. That is a coincidence of the
    // current implementation, not a guarantee, so the walker tests for an
    // interceptor FIRST. If it did not, `(.)photo` would be swallowed as a
    // group and vanish from the URL entirely — a fiction in the other
    // direction.
    expect(isInterceptingRoute("(.)photo")).toBe(true);
    expect(isRouteGroup("(.)photo")).toBe(false);
    // And a real group is not an interceptor.
    expect(isInterceptingRoute("(app)")).toBe(false);
  });

  it("containsDynamicSegment keeps the interceptor refusal narrow", () => {
    // The gate's business is bearer credentials. A STATIC intercepting route —
    // app/feed/(.)photo/page.tsx — carries none, and failing it would block a
    // feature this file has no stake in. A guard that obstructs unrelated work
    // gets worked around, and then it protects nothing.
    //
    // Directories that genuinely exist, so the helper is exercised against real
    // trees rather than a mock: app/(app)/clients holds [id]; app/demo holds no
    // dynamic segment at any depth.
    expect(containsDynamicSegment(join(APP_DIR, "(app)", "clients"))).toBe(true);
    expect(containsDynamicSegment(join(APP_DIR, "demo"))).toBe(false);
    // A path that does not exist is not a reason to throw mid-scan.
    expect(containsDynamicSegment(join(APP_DIR, "no-such-directory"))).toBe(false);
  });

  it("a dynamic segment is none of the above", () => {
    for (const seg of ["[token]", "[...slug]", "[[...slug]]"]) {
      expect(isDynamic(seg)).toBe(true);
      expect(isRouteGroup(seg)).toBe(false);
      expect(isParallelSlot(seg)).toBe(false);
      expect(isInterceptingRoute(seg)).toBe(false);
    }
  });
});
