import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  CALENDAR_RECONCILE_CRON_SCHEDULE,
  CALENDAR_SYNC_CRON_SCHEDULE,
} from "@/lib/cron/calendar-cron-schedule";

// Phase B2.3-c — the WORKER ACTIVATION GATE (updated for c2, then c3).
//
// c1 shipped the real event-operation layer as a DORMANT operations map and proved
// NO application route imported it. c2 wires the single authenticated worker-drain
// route /api/cron/calendar-sync to the c1 operations map through ONE approved
// server-only seam (lib/google-calendar/sync/worker-runtime.ts). c3 REGISTERS the
// two calendar cron routes as DAILY schedules in vercel.json — but dormancy is now
// enforced by worker_enabled=false + the studio intent flags (the claim RPC returns
// zero rows and mutates nothing), NOT by being unscheduled. This gate proves: no
// other route or browser path imports the map, the calendar crons are registered at
// the canonical daily cadence (no sub-daily, plan cap) with the existing
// materialize-breaks cron preserved, no code enables the worker or a studio flag,
// the route takes no caller-selected target, and every behaviour is backed by a
// DIRECT test.

const ROOT = process.cwd();
const APPROVED_OPS_MODULE = join("lib", "google-calendar", "sync", "operations.ts");
// The ONE server-only seam allowed to wire the live operations map.
const APPROVED_SEAM = join("lib", "google-calendar", "sync", "worker-runtime.ts");
// The ONE application route allowed to wire that seam.
const APPROVED_ROUTE = join("app", "api", "cron", "calendar-sync", "route.ts");

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
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const nonTest = (rel: string) => !/\.(test|spec)\.(ts|tsx)$/.test(rel);

describe("B2.3-c worker activation gate (c2)", () => {
  it("the ONLY module defining a live operations map literal is the approved dormant ops module", () => {
    const offenders: string[] = [];
    for (const rel of [...walk("app"), ...walk("lib")]) {
      if (!nonTest(rel)) continue;
      if (/["']event\.(create|update|delete)["']\s*:\s*(async|\()/.test(read(rel))) offenders.push(rel);
    }
    expect(offenders).toEqual([APPROVED_OPS_MODULE]);
  });

  it("the ONLY module wiring createCalendarSyncOperations is the approved server-only seam", () => {
    const wirers: string[] = [];
    for (const rel of [...walk("app"), ...walk("lib")]) {
      if (!nonTest(rel) || rel === APPROVED_OPS_MODULE) continue;
      if (/createCalendarSyncOperations\s*\(/.test(read(rel))) wirers.push(rel);
    }
    expect(wirers).toEqual([APPROVED_SEAM]);
  });

  it("the ONLY app route referencing the seam or the ops map is /api/cron/calendar-sync", () => {
    const importers: string[] = [];
    for (const rel of walk("app")) {
      if (!nonTest(rel)) continue;
      if (/sync\/worker-runtime|sync\/operations|createCalendarSyncOperations/.test(read(rel))) importers.push(rel);
    }
    expect(importers).toEqual([APPROVED_ROUTE]);
  });

  it("no browser/client path imports the seam or the operations map", () => {
    const offenders: string[] = [];
    for (const rel of [...walk("app"), ...walk("lib")]) {
      if (!nonTest(rel)) continue;
      const src = read(rel);
      const isClient = /^\s*["']use client["']/m.test(src);
      if (isClient && /sync\/worker-runtime|sync\/operations|createCalendarSyncOperations/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("the seam is server-only and wires claim -> handle -> record + the Upstash refresh coordinator + the mandatory invalidator", () => {
    const seam = read(APPROVED_SEAM);
    expect(seam).toMatch(/^import "server-only";/m);
    expect(seam).toMatch(/isAuthorizedCronRequest/); // auth is enforced in the seam
    expect(seam).toMatch(/claim_calendar_sync_op/); // claim
    expect(seam).toMatch(/handleCalendarSyncJob/); // handle
    expect(seam).toMatch(/record_calendar_sync_result/); // record
    expect(seam).toMatch(/createCalendarSyncOperations/); // c1 operations map
    expect(seam).toMatch(/createUpstashRefreshCoordinator/); // cross-process refresh mutex
    expect(seam).toMatch(/invalidateAccessToken/); // mandatory 401 invalidator
    expect(seam).toMatch(/processAccessTokenCache/); // shared cache seam
  });

  it("the production route/runtime does NOT use pg / in-process / a fake provider", () => {
    for (const rel of [APPROVED_SEAM, APPROVED_ROUTE]) {
      const src = read(rel);
      expect(src).not.toMatch(/inProcessOnlyCoordinator/);
      expect(src).not.toMatch(/createPgRefreshCoordinator/);
      expect(src).not.toMatch(/from ["']pg["']/);
      expect(src).not.toMatch(/fetchImpl\s*:/); // production REST client uses the real fetch
    }
  });

  it("the route is Node-runtime, force-dynamic, and accepts NO caller-selected tenant/provider target", () => {
    const route = read(APPROVED_ROUTE);
    expect(route).toMatch(/export const runtime = "nodejs"/);
    expect(route).toMatch(/export const dynamic = "force-dynamic"/);
    // The route delegates to the seam and reads no studio/connection/id/batch param.
    expect(route).not.toMatch(/searchParams\.get|studio_id|connection_id|batch_size|appointment_id|event_id|link_id|calendar_id/);
  });

  it("the platform ceiling is pinned as a LITERAL maxDuration in the route, NOT via vercel.json", () => {
    const route = read(APPROVED_ROUTE);
    expect(route).toMatch(/export const maxDuration = 180/); // literal integer for Next/Vercel static detection
    const vercel = read("vercel.json");
    expect(vercel).not.toMatch(/maxDuration/); // never configured through vercel.json
  });

  it("c3: the calendar cron routes are registered as DAILY schedules; dormancy is via worker_enabled/flags, not scheduling", () => {
    const vercel = JSON.parse(read("vercel.json")) as { crons?: { path: string; schedule: string }[] };
    const byPath = new Map((vercel.crons ?? []).map((c) => [c.path, c.schedule]));
    // Both calendar crons registered at the canonical daily cadence...
    expect(byPath.get("/api/cron/calendar-sync")).toBe(CALENDAR_SYNC_CRON_SCHEDULE);
    expect(byPath.get("/api/cron/calendar-reconcile")).toBe(CALENDAR_RECONCILE_CRON_SCHEDULE);
    // ...never sub-daily (the plan rejects `*/N`)...
    expect(CALENDAR_SYNC_CRON_SCHEDULE).not.toMatch(/\*\//);
    expect(CALENDAR_RECONCILE_CRON_SCHEDULE).not.toMatch(/\*\//);
    // ...the existing daily materialize-breaks cron is preserved, no duplicate paths.
    expect(byPath.get("/api/cron/materialize-recurring-breaks")).toBe("0 8 * * *");
    const paths = (vercel.crons ?? []).map((c) => c.path);
    expect(paths.length).toBe(new Set(paths).size);
  });

  it("c3: both calendar cron routes exist and are gated by isAuthorizedCronRequest (fail-closed auth)", () => {
    const worker = read(APPROVED_ROUTE); // delegates to the seam (which calls isAuthorizedCronRequest)
    const seam = read(APPROVED_SEAM);
    const reconcile = read(join("app", "api", "cron", "calendar-reconcile", "route.ts"));
    expect(existsSync(join(ROOT, "app", "api", "cron", "calendar-sync", "route.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "app", "api", "cron", "calendar-reconcile", "route.ts"))).toBe(true);
    // worker auth is enforced in the seam; reconcile enforces it directly.
    expect(worker).toMatch(/handleWorkerRoute/);
    expect(seam).toMatch(/isAuthorizedCronRequest/);
    expect(reconcile).toMatch(/isAuthorizedCronRequest/);
    // the worker route still pins maxDuration=180 (unchanged by c3).
    expect(worker).toMatch(/export const maxDuration = 180/);
  });

  it("no production module enables the worker or a studio sync flag", () => {
    const offenders: string[] = [];
    for (const rel of [...walk("app"), ...walk("lib")]) {
      if (!nonTest(rel)) continue;
      const src = read(rel);
      if (/worker_enabled\s*[:=]\s*true/.test(src)) offenders.push(rel);
      if (/google_calendar_(outbound_sync|inbound_busy|two_way_updates)_enabled\s*[:=]\s*true/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("each c2 activation prerequisite is backed by a DIRECT behavioural test (not 'inherits coverage')", () => {
    const required = [
      "tests/lib/google-calendar/sync/upstash-refresh-coordinator.test.ts", // fail-closed Upstash mutex, ownership-safe release, TTL, privacy
      "tests/lib/google-calendar/sync/worker-runtime.test.ts", // bounded drain accounting + shared-cache composition + Upstash default
      "tests/lib/google-calendar/sync/worker-heartbeat.test.ts", // fail-open PHI-free heartbeat
      "tests/app/google-calendar/calendar-sync-route.test.ts", // auth, targeting, no-work, sabotage, PHI-free response
      "tests/db/google-calendar-c2-worker-route.db.test.ts", // §23 concurrency + §24 claim->handle->record + §25 worker-off
    ];
    for (const f of required) expect(existsSync(join(ROOT, f))).toBe(true);
  });

  it("the design doc records the placeholder=event.update create-and-bind contract and the c2 route amendment", () => {
    const doc = read(join("docs", "integrations", "google-calendar-sync.md"));
    expect(doc).toMatch(/event\.update/);
    expect(doc).toMatch(/create-and-bind/i);
    expect(doc).not.toMatch(/re-drive.{0,40}create/i);
    // The c2 amendment: Upstash refresh coordinator, dormant, unscheduled.
    expect(doc).toMatch(/B2\.3-c2/);
    expect(doc).toMatch(/Upstash/);
  });
});
