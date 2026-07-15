import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// Phase B2.3-b §5 — the WORKER ACTIVATION GATE.
//
// The reconciliation sweep re-drives a CURRENT UPSERT intent for a confirmed
// appointment with a PLACEHOLDER link (`google_event_id` null). The deployed enqueue
// trigger emits `event.update` in that case (an active link exists) — NOT
// `event.create`. No real provider update can happen (there is no provider event id),
// so activating a live worker/operations map without the correct behaviours would
// double-create or wrongly update. This static gate proves the worker drain + any
// live Google operations map remain UNWIRED until B2.4 implements + tests all of:
const B2_4_PREREQUISITES = [
  "stale earlier create work is no-op superseded (ok_noop_superseded) before a newer upsert executes",
  "an event.update for a placeholder link (null google_event_id) performs a provider CREATE-and-bind",
  "a successful create writes google_event_id back to the link",
  "a duplicate replay does not create a second provider event",
  "a partial create/link-write failure is recoverable",
  // Carried by the route/heartbeat correction: with a live worker, a sufficiently fast
  // worker could complete the operation BETWEEN the sweep's bump and its post-bump
  // verification read. Post-bump intent verification must therefore eventually accept
  // EITHER a matching current pending/processing operation OR proof that the matching
  // operation already completed and advanced the link to the resulting version. Not
  // reachable today (worker off) — an activation prerequisite, not B2.3-b transport.
  "post-bump intent verification accepts a matching pending/processing op OR proof the op already completed and advanced the link to the resulting version",
];

const ROOT = process.cwd();

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

describe("B2.4 worker activation gate", () => {
  it("lists the exact prerequisites that must be tested before worker activation", () => {
    expect(B2_4_PREREQUISITES).toHaveLength(6);
    for (const p of B2_4_PREREQUISITES) expect(p.length).toBeGreaterThan(10);
  });

  it("the worker-drain route (/api/cron/calendar-sync) does NOT exist yet", () => {
    expect(existsSync(join(ROOT, "app", "api", "cron", "calendar-sync", "route.ts"))).toBe(false);
    const cronRoutes = walk(join("app", "api", "cron")).filter((f) => /calendar-sync/.test(f));
    expect(cronRoutes).toEqual([]);
  });

  it("NO production module wires a live Google operations map into the worker handler", () => {
    // handleCalendarSyncJob dispatches an INJECTED `operations` map. B2.1 wires none; a
    // real op would appear as a create/update/delete handler keyed by the op-type in a
    // non-test module. Prove no such wiring exists outside test/mocks.
    const offenders: string[] = [];
    for (const rel of [...walk("app"), ...walk("lib")]) {
      if (/\.(test|spec)\.(ts|tsx)$/.test(rel)) continue;
      const src = readFileSync(join(ROOT, rel), "utf8");
      // A live operations map would map an op-type string literal to a handler.
      if (/["']event\.(create|update|delete)["']\s*:\s*(async|\()/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("the design doc records the placeholder=event.update UPSERT contract (not 're-drive create')", () => {
    const doc = readFileSync(join(ROOT, "docs", "integrations", "google-calendar-sync.md"), "utf8");
    // The correct contract is documented …
    expect(doc).toMatch(/event\.update/);
    expect(doc).toMatch(/create-and-bind/i);
    // … and the stale "re-drive create" claim is gone.
    expect(doc).not.toMatch(/re-drive.{0,40}create/i);
  });
});
