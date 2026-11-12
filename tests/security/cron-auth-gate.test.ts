import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";

// ===========================================================================
// The /api/cron/* authorization gate — behaviour, not just wiring
// ===========================================================================
//
// Five scheduled routes are reachable without a session: lib/supabase/middleware.ts
// allowlists them, so `isAuthorizedCronRequest` is the ONLY thing between the public
// internet and an admin-client run. One of them has been probed unauthenticated in
// production (tests/app/cron-config.test.ts records the 401).
//
// WHAT WAS NOT PROVEN BEFORE THIS FILE. The gate itself had no test. The single
// reference to it anywhere under tests/ is
// tests/app/google-calendar/calendar-reconcile-route.test.ts:27, which mocks it to
// return true — so every existing cron test runs with the gate stubbed open. Its two
// load-bearing behaviours were therefore unasserted:
//
//   * it FAILS CLOSED when CRON_SECRET is unset, rather than comparing against the
//     string "Bearer undefined" — the probe its own comment names;
//   * it length-checks BEFORE timingSafeEqual, which throws on unequal-length
//     buffers. Without that check a short header turns a 401 into a 500, and the
//     difference between "rejected" and "crashed" is the difference between a gate
//     and an outage.
//
// And the ordering property — the gate runs before any side effect — was pinned for
// exactly ONE of the five routes (appointment-reminders). A new cron route, or a
// refactor that moved a read above the gate in the other four, would pass CI.
//
// This file closes both gaps. It executes the real helper and reads the real routes;
// nothing is mocked.

const ROOT = process.cwd();
const CRON_DIR = join(ROOT, "app/api/cron");

function req(authorization?: string): Request {
  return new Request("https://example.invalid/api/cron/x", {
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe("isAuthorizedCronRequest — the gate's own behaviour", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts the exact bearer secret", () => {
    vi.stubEnv("CRON_SECRET", "s3cr3t-value");
    expect(isAuthorizedCronRequest(req("Bearer s3cr3t-value"))).toBe(true);
  });

  it("FAILS CLOSED when CRON_SECRET is UNSET — 'Bearer undefined' must not authorize", () => {
    // The env var must be DELETED, not set to "". That distinction is the whole
    // test. With the variable merely empty, the expected value is "Bearer " and
    // the Headers layer trims a trailing space, so a missing fail-closed guard is
    // masked by the length check and this assertion passes either way.
    //
    // Unset is different: `Bearer ${undefined}` interpolates to the literal string
    // "Bearer undefined", which a caller can present verbatim. That is the probe
    // lib/cron/auth.ts names in its own comment, and it is the case that decides
    // whether the guard is load-bearing.
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      expect(isAuthorizedCronRequest(req("Bearer undefined"))).toBe(false);
      expect(isAuthorizedCronRequest(req("Bearer anything"))).toBe(false);
      expect(isAuthorizedCronRequest(req())).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = saved;
    }
  });

  it("FAILS CLOSED when CRON_SECRET is present but empty", () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(isAuthorizedCronRequest(req("Bearer "))).toBe(false);
    expect(isAuthorizedCronRequest(req("Bearer undefined"))).toBe(false);
    expect(isAuthorizedCronRequest(req())).toBe(false);
  });

  it("rejects a missing Authorization header", () => {
    vi.stubEnv("CRON_SECRET", "s3cr3t-value");
    expect(isAuthorizedCronRequest(req())).toBe(false);
  });

  it("rejects a wrong secret of THE SAME LENGTH", () => {
    // Same length reaches timingSafeEqual, so this is the case that proves the
    // comparison itself rejects rather than the length pre-check.
    vi.stubEnv("CRON_SECRET", "s3cr3t-value");
    expect(isAuthorizedCronRequest(req("Bearer s3cr3t-valuX"))).toBe(false);
  });

  it("rejects a wrong-length token by RETURNING FALSE, never by throwing", () => {
    // timingSafeEqual throws on unequal-length buffers. If the length pre-check is
    // ever removed, this stops being a 401 and becomes a 500.
    vi.stubEnv("CRON_SECRET", "s3cr3t-value");
    for (const header of ["Bearer x", "Bearer s3cr3t-value-and-then-some", "Bearer", ""]) {
      expect(() => isAuthorizedCronRequest(req(header))).not.toThrow();
      expect(isAuthorizedCronRequest(req(header))).toBe(false);
    }
  });

  it("rejects a correct secret presented without the Bearer scheme", () => {
    vi.stubEnv("CRON_SECRET", "s3cr3t-value");
    expect(isAuthorizedCronRequest(req("s3cr3t-value"))).toBe(false);
    expect(isAuthorizedCronRequest(req("bearer s3cr3t-value"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Every cron route is gated, and the gate runs first.
//
// Enumerated from the filesystem rather than listed, so a NEW route under
// app/api/cron is covered the moment it is added instead of the next time someone
// remembers this file.
// ---------------------------------------------------------------------------

/**
 * calendar-sync is the one route with no local gate: it delegates to
 * handleWorkerRoute, whose gate is lib/google-calendar/sync/worker-runtime.ts:549,
 * and it guards its own side effect on `status !== 401`. Named explicitly with its
 * seam so the exemption is a recorded decision, not a silent hole.
 */
const DELEGATED: Record<string, { seam: string; statusGuard: string }> = {
  "calendar-sync": {
    seam: "lib/google-calendar/sync/worker-runtime.ts",
    statusGuard: "status !== 401",
  },
};

function cronRoutes(): Array<{ name: string; src: string }> {
  return readdirSync(CRON_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      name: d.name,
      src: readFileSync(join(CRON_DIR, d.name, "route.ts"), "utf8"),
    }));
}

describe("every /api/cron route is gated before it does any work", () => {
  const routes = cronRoutes();

  it("finds the cron routes at all", () => {
    // Without this the loops below are vacuous.
    expect(routes.length).toBeGreaterThanOrEqual(5);
  });

  for (const { name, src } of cronRoutes()) {
    const delegated = DELEGATED[name];

    it(`${name}: authorization is reached before any side effect`, () => {
      if (delegated) {
        // The gate is in the seam; the route must still refuse to act on a 401.
        const seam = readFileSync(join(ROOT, delegated.seam), "utf8");
        expect(seam).toContain("isAuthorizedCronRequest");
        expect(src).toContain(delegated.statusGuard);
        return;
      }

      const handlerAt = src.search(/export async function (GET|POST)/);
      expect(handlerAt, `${name} exposes no GET/POST handler`).toBeGreaterThan(-1);
      const handler = src.slice(handlerAt);

      const gate = handler.indexOf("isAuthorizedCronRequest(");
      expect(gate, `${name} never calls isAuthorizedCronRequest`).toBeGreaterThan(-1);

      // Anything that reaches the database, a provider, or durable state must come
      // after the gate. An unauthorized probe has to be free of consequence.
      for (const sideEffect of [
        "createAdminClient(",
        "createClient(",
        "recordOpsAlert(",
        "fetch(",
        ".rpc(",
        ".from(",
      ]) {
        const at = handler.indexOf(sideEffect);
        if (at > -1) {
          expect(at, `${name}: ${sideEffect} appears before the auth gate`).toBeGreaterThan(gate);
        }
      }
    });
  }

  it("no cron route reads a caller-supplied tenant identifier", () => {
    // A scheduled job derives its own scope. Accepting a studio or client id from
    // the request would let an authorized-but-generic caller aim the job.
    for (const { name, src } of routes) {
      const handlerAt = src.search(/export async function (GET|POST)/);
      if (handlerAt < 0) continue;
      const handler = src.slice(handlerAt);
      for (const param of ["studio_id", "studioId", "client_id", "clientId"]) {
        expect(
          handler.includes(`searchParams.get("${param}")`),
          `${name} reads ${param} from the request`,
        ).toBe(false);
      }
    }
  });
});
