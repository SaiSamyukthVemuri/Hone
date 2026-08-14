import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Google Calendar: Phase B outbound-sync dormancy proof.
//
// PR B1 added the outbound-sync SCHEMA + queue foundation (migration 0124).
// PR B2.1 added the transport-neutral WORKER CORE + token lifecycle under
// lib/google-calendar/sync, which necessarily references the tables/RPCs, but
// it is DORMANT: nothing activates it (no app route/action imports it, no cron
// schedule, no enqueue path). The "not activated" guarantee is proven by
// tests/app/google-calendar/b2-1-worker-core-dormant.test.ts. This test keeps the
// remaining dormancy invariants: NO application (app/) path references the
// outbound-sync surface, no enqueue call sites exist, and the row types stay
// inert. The B2.1 worker-core directory is the ONE allowed home for the runtime
// references (alongside the inert types file) and is excluded below.

const ROOT = process.cwd();
const NEW_SYMBOLS = [
  "calendar_event_links",
  "calendar_sync_outbox",
  "claim_calendar_sync_op",
  "record_calendar_sync_result",
];

// Runtime source roots. Two locations are the allowed homes for the outbound-sync
// surface and are excluded from the "no reference" scan: lib/types/database.ts
// (inert row types) and lib/google-calendar/sync (the B2.1 dormant worker core).
const SCAN_DIRS = ["app", "lib", "components"];
const ALLOWED_TYPE_FILE = join("lib", "types", "database.ts");
const WORKER_CORE_DIR = join("lib", "google-calendar", "sync");

function walk(dir: string): string[] {
  const abs = join(ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const rel = join(dir, name);
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      out.push(...walk(rel));
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(rel);
    }
  }
  return out;
}

describe("PR B1: outbound sync is dormant (no runtime behavior)", () => {
  it("no runtime module OUTSIDE the dormant worker core references the tables or RPCs", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const rel of walk(dir)) {
        if (rel === ALLOWED_TYPE_FILE || rel.startsWith(WORKER_CORE_DIR)) continue;
        const src = readFileSync(join(ROOT, rel), "utf8");
        for (const sym of NEW_SYMBOLS) {
          if (src.includes(sym)) offenders.push(`${rel} → ${sym}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no application (app/) route references the raw outbound-sync surface (reconcile + worker routes import the seam only)", () => {
    // Exactly TWO app routes may import the (server-only) google-calendar/sync
    // modules: B2.3-b's reconcile SWEEP route and B2.3-c2's worker-DRAIN route.
    // NEITHER may reference the raw tables/RPCs directly, those stay behind the
    // store / worker-runtime seam.
    const SEAM_ROUTES = [
      join("app", "api", "cron", "calendar-reconcile", "route.ts"),
      join("app", "api", "cron", "calendar-sync", "route.ts"),
    ];
    const offenders: string[] = [];
    for (const rel of walk("app")) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      for (const sym of NEW_SYMBOLS) {
        if (src.includes(sym)) offenders.push(`${rel} → ${sym}`);
      }
      if (!SEAM_ROUTES.includes(rel) && src.includes("google-calendar/sync")) {
        offenders.push(`${rel} → google-calendar/sync`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the inert row types exist in lib/types/database.ts (schema-only, no runtime use)", () => {
    const types = readFileSync(join(ROOT, ALLOWED_TYPE_FILE), "utf8");
    // Types are declared (so B2 can consume them) …
    expect(types).toMatch(/export (type|interface) CalendarEventLink\b/);
    expect(types).toMatch(/export (type|interface) CalendarSyncOutbox\b/);
    // … and only ever appear as type declarations here, never as a table string
    // literal used in a query (which would imply a runtime read/write).
    expect(types).not.toMatch(/\.from\(\s*["'`]calendar_(event_links|sync_outbox)/);
    expect(types).not.toMatch(/\.rpc\(\s*["'`](claim_calendar_sync_op|record_calendar_sync_result)/);
  });

  it("the Phase-A Google client (outside the worker core) has no event surface", () => {
    const dir = join("lib", "google-calendar");
    for (const rel of walk(dir)) {
      if (rel.startsWith(WORKER_CORE_DIR)) continue; // the B2.1 worker core is the allowed home
      const src = readFileSync(join(ROOT, rel), "utf8");
      for (const sym of NEW_SYMBOLS) {
        expect(src.includes(sym), `${rel} must not reference ${sym}`).toBe(false);
      }
      // The Phase-A files still make no event-writing Google API calls.
      expect(src).not.toMatch(/events\.(insert|update|delete|patch)/);
      expect(src).not.toMatch(/\/calendars\/[^/]*\/events/);
    }
  });

  it("does not enqueue on appointment/booking mutations (no enqueue call sites)", () => {
    // A cheap belt-and-suspenders scan: the words that a B2 enqueue helper would
    // introduce must not exist yet anywhere in runtime source.
    const enqueueNames = ["enqueueCalendarSync", "enqueueOutbox", "enqueue_calendar_sync"];
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const rel of walk(dir)) {
        const src = readFileSync(join(ROOT, rel), "utf8");
        for (const n of enqueueNames) if (src.includes(n)) offenders.push(`${rel} → ${n}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
