import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// Phase B2.3-c — the WORKER ACTIVATION GATE.
//
// B2.3-c1 ships the real event-operation layer (serializer, deterministic
// identity, stale fence, create/update/delete operations, transactional link
// transitions) as a DORMANT operations map. This gate proves the map is present
// but UNWIRED: no app route imports or invokes it, /api/cron/calendar-sync does
// not exist, no calendar worker cron is registered, and no code activates the
// worker or a studio flag. Each former string prerequisite is now backed by a
// DIRECT behavioural test (asserted to exist below).

const ROOT = process.cwd();
// The ONE approved dormant operations module (present-but-unwired).
const APPROVED_OPS_MODULE = join("lib", "google-calendar", "sync", "operations.ts");

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

describe("B2.3-c worker activation gate", () => {
  it("the ONLY module wiring a live operations map is the approved dormant ops module", () => {
    const offenders: string[] = [];
    for (const rel of [...walk("app"), ...walk("lib")]) {
      if (/\.(test|spec)\.(ts|tsx)$/.test(rel)) continue;
      const src = readFileSync(join(ROOT, rel), "utf8");
      if (/["']event\.(create|update|delete)["']\s*:\s*(async|\()/.test(src)) offenders.push(rel);
    }
    // Exactly the approved dormant module — nothing else may carry an ops map.
    expect(offenders).toEqual([APPROVED_OPS_MODULE]);
  });

  it("NO app route imports or invokes the dormant operations map", () => {
    const appImporters: string[] = [];
    for (const rel of walk("app")) {
      if (/\.(test|spec)\.(ts|tsx)$/.test(rel)) continue;
      const src = readFileSync(join(ROOT, rel), "utf8");
      if (/sync\/operations|createCalendarSyncOperations/.test(src)) appImporters.push(rel);
    }
    expect(appImporters).toEqual([]);
  });

  it("the worker-drain route (/api/cron/calendar-sync) does NOT exist yet", () => {
    expect(existsSync(join(ROOT, "app", "api", "cron", "calendar-sync", "route.ts"))).toBe(false);
    expect(walk(join("app", "api", "cron")).filter((f) => /calendar-sync/.test(f))).toEqual([]);
  });

  it("no calendar worker cron is registered", () => {
    const vercel = readFileSync(join(ROOT, "vercel.json"), "utf8");
    expect(vercel).not.toMatch(/calendar-sync/);
    expect(vercel).not.toMatch(/calendar-reconcile/);
  });

  it("no production module activates the worker or a studio sync flag", () => {
    const offenders: string[] = [];
    for (const rel of [...walk("app"), ...walk("lib")]) {
      if (/\.(test|spec)\.(ts|tsx)$/.test(rel)) continue;
      const src = readFileSync(join(ROOT, rel), "utf8");
      if (/worker_enabled\s*[:=]\s*true/.test(src)) offenders.push(rel);
      if (/google_calendar_(outbound_sync|inbound_busy|two_way_updates)_enabled\s*[:=]\s*true/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("each activation prerequisite is backed by a DIRECT behavioural test (not 'inherits coverage')", () => {
    const required = [
      "tests/lib/google-calendar/sync/event-id.test.ts", // deterministic id + marker
      "tests/lib/google-calendar/sync/serializer.test.ts", // v1 allow-list + no PHI
      "tests/lib/google-calendar/sync/stale-fence.test.ts", // stale/completion-proof fence
      "tests/lib/google-calendar/sync/operations.test.ts", // MOCKED-operation unit: create-and-bind, replay, rotate, delete, conflict, response-validation, store-error, 401
      "tests/lib/google-calendar/sync/operations-transport.test.ts", // ACTUAL REST transport composition (fake fetch): URL/sendUpdates/If-Match/marker/409/412
      "tests/db/google-calendar-c1-link-transition.db.test.ts", // transactional RPC fences + rotation + enqueue semantics
    ];
    for (const f of required) expect(existsSync(join(ROOT, f))).toBe(true);
  });

  it("the design doc records the placeholder=event.update create-and-bind contract", () => {
    const doc = readFileSync(join(ROOT, "docs", "integrations", "google-calendar-sync.md"), "utf8");
    expect(doc).toMatch(/event\.update/);
    expect(doc).toMatch(/create-and-bind/i);
    expect(doc).not.toMatch(/re-drive.{0,40}create/i);
  });
});
