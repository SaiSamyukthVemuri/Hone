import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Google Calendar — Phase B, PR B1. POSITIVE dormancy proof.
//
// PR B1 adds the outbound-sync SCHEMA + queue foundation (migration 0124) and
// nothing else. There must be NO runtime behavior: no application code path
// reads, writes, enqueues to, or drains the new tables/RPCs; the only place the
// new names appear in TypeScript is the inert row types in lib/types/database.ts
// (declared for a future phase, imported by nothing yet). This test fails the
// moment any runtime module starts referencing the outbound-sync surface — that
// is Phase B2's PR, not B1's.

const ROOT = process.cwd();
const NEW_SYMBOLS = [
  "calendar_event_links",
  "calendar_sync_outbox",
  "claim_calendar_sync_op",
  "record_calendar_sync_result",
];

// Runtime source roots. lib/types/database.ts is the ONE allowed home for the
// (inert, unused) row types, so it is excluded from the "no reference" scan and
// asserted separately.
const SCAN_DIRS = ["app", "lib", "components"];
const ALLOWED_TYPE_FILE = join("lib", "types", "database.ts");

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

describe("PR B1 — outbound sync is dormant (no runtime behavior)", () => {
  it("no runtime module references the outbound-sync tables or RPCs", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const rel of walk(dir)) {
        if (rel === ALLOWED_TYPE_FILE) continue;
        const src = readFileSync(join(ROOT, rel), "utf8");
        for (const sym of NEW_SYMBOLS) {
          if (src.includes(sym)) offenders.push(`${rel} → ${sym}`);
        }
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

  it("the deployed Google client has no outbound enqueue/claim/drain surface", () => {
    const dir = join("lib", "google-calendar");
    for (const rel of walk(dir)) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      for (const sym of NEW_SYMBOLS) {
        expect(src.includes(sym), `${rel} must not reference ${sym} in PR B1`).toBe(false);
      }
      // No event-writing Google API calls yet (Phase B2+).
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
