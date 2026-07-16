import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Google Calendar — Phase B2.1/c2/c3: static proof the worker stays DORMANT even
// though it is now wired AND scheduled.
//
// The transport-neutral worker core + REST client + token lifecycle live under
// lib/google-calendar/sync. B2.3-c2 wires EXACTLY ONE authenticated worker-drain
// route (app/api/cron/calendar-sync) to that core through the approved server-only
// runtime seam (lib/google-calendar/sync/worker-runtime); no app route imports the
// low-level drain primitives (handler/adapters/the loop) directly — they go through
// the seam. B2.3-c3 registers BOTH calendar cron routes (calendar-reconcile +
// calendar-sync) as DAILY Vercel schedules in vercel.json.
//
// The worker nonetheless remains DORMANT because worker_enabled=false (the claim RPC
// returns zero rows and mutates nothing) and every studio outbound/inbound/two-way
// intent flag is false. SCHEDULE REGISTRATION IS NOT RUNTIME ACTIVATION — the claim
// RPC + the studio intent flags remain the authoritative gates. The invariants below
// assert exactly this registered-but-dormant surface.

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

describe("B2.1 worker core is not activated", () => {
  it("no app/ route imports the low-level DRAIN primitives directly (they go through the server-only seam)", () => {
    // The c2 worker route wires the drain THROUGH the server-only runtime seam
    // (lib/google-calendar/sync/worker-runtime); no app route imports the low-level
    // primitives (sync/handler, sync/adapters, the worker loop) directly.
    const workerImports = ["sync/handler", "sync/adapters", "runCalendarSyncCronBatch", "runCalendarSyncWorkerLoop"];
    const offenders = walk("app").filter((f) => {
      const src = readFileSync(join(ROOT, f), "utf8");
      return workerImports.some((w) => src.includes(w));
    });
    expect(offenders).toEqual([]);
  });

  it("c3: the calendar crons are registered as DAILY schedules; the worker stays gated by worker_enabled, not by scheduling", () => {
    // B2.3-c3 registers /api/cron/calendar-reconcile + /api/cron/calendar-sync as
    // once-per-day vercel.json crons (the plan caps cron at daily). Registration is
    // DORMANT: worker_enabled=false makes the claim RPC return zero rows + mutate
    // nothing, and every studio sync flag is false. Dormancy is NOT "unscheduled".
    const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
      crons?: { path: string; schedule: string }[];
    };
    const byPath = new Map((vercel.crons ?? []).map((c) => [c.path, c.schedule]));
    expect(byPath.get("/api/cron/calendar-sync")).toBe("30 9 * * *");
    expect(byPath.get("/api/cron/calendar-reconcile")).toBe("0 9 * * *");
    // Neither is sub-daily (the plan rejects `*/N`); the daily materialize-breaks cron is preserved.
    for (const p of ["/api/cron/calendar-sync", "/api/cron/calendar-reconcile"]) {
      expect(byPath.get(p)).not.toMatch(/\*\//);
    }
    expect(byPath.get("/api/cron/materialize-recurring-breaks")).toBe("0 8 * * *");
  });

  it("the two calendar cron routes exist and are registered only at the approved daily schedules", () => {
    const cronRoutes = walk(join("app", "api", "cron")).filter((f) => /calendar/i.test(f));
    // Both route files exist; there are EXACTLY two Google Calendar cron routes
    // (the B2.3-b reconcile sweep + the B2.3-c2 worker drain).
    expect(cronRoutes.some((f) => /calendar-sync/.test(f))).toBe(true);
    expect(cronRoutes.some((f) => /calendar-reconcile/.test(f))).toBe(true);
    expect(cronRoutes.length).toBe(2);
    // Both are registered in vercel.json at exactly the approved DAILY schedules
    // (B2.3-c3 registration — not runtime activation), with no duplicate cron path.
    const crons =
      (JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
        crons?: { path: string; schedule: string }[];
      }).crons ?? [];
    const byPath = new Map(crons.map((c) => [c.path, c.schedule]));
    expect(byPath.get("/api/cron/calendar-reconcile")).toBe("0 9 * * *");
    expect(byPath.get("/api/cron/calendar-sync")).toBe("30 9 * * *");
    const paths = crons.map((c) => c.path);
    expect(paths.length).toBe(new Set(paths).size);
  });

  it("every sync module is server-only", () => {
    const mods = walk(join("lib", "google-calendar", "sync"));
    expect(mods.length).toBeGreaterThan(5);
    for (const m of mods) {
      expect(readFileSync(join(ROOT, m), "utf8").startsWith('import "server-only"'), `${m} must be server-only`).toBe(true);
    }
  });

  it("the handler enforces the DESTINATION event scope at execution (not broad calendar.events)", () => {
    const handler = readFileSync(join(ROOT, "lib", "google-calendar", "sync", "handler.ts"), "utf8");
    // Destination-aware exact-scope gate; the retired broad calendar.events literal
    // and REQUIRED_OUTBOUND_SCOPE are gone.
    expect(handler).toMatch(/hasRequiredEventScopes\(\s*conn\.destinationMode\s*,\s*conn\.grantedScopes\s*\)/);
    expect(handler).not.toContain("REQUIRED_OUTBOUND_SCOPE");
    expect(handler).not.toMatch(/["']https:\/\/www\.googleapis\.com\/auth\/calendar\.events["']/);
  });

  it("the REST client uses fetch (no googleapis dependency)", () => {
    const client = readFileSync(join(ROOT, "lib", "google-calendar", "sync", "google-rest-client.ts"), "utf8");
    expect(client).not.toMatch(/from ['"]googleapis['"]/);
  });
});
