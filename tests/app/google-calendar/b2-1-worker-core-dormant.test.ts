import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Google Calendar — Phase B2.1: static proof the worker core is DORMANT.
// The transport-neutral core + REST client + token lifecycle exist under
// lib/google-calendar/sync, but nothing activates the DRAIN WORKER: no app route
// imports handler/adapters, no cron schedule is registered, and the modules are
// server-only. (Event operations are B2.3-c1 — dormant; a live cron is B2.3-c2.)
//
// B2.3-b adds the reconciliation SWEEP route (app/api/cron/calendar-reconcile) +
// its server-only reconcile modules. That route is enqueue-side (it orchestrates
// the existing repair RPCs) and is itself dormant: it is NOT cron-registered, and
// the claim-side drain worker (handler/adapters) remains unwired until B2.3-c.
// These invariants are updated below to permit exactly that new surface.

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
  it("no app/ route or action imports the DRAIN WORKER (handler/adapters)", () => {
    // The reconcile SWEEP route may import the reconcile modules; the claim-side
    // drain worker (sync/handler, sync/adapters, the worker loop) stays unwired.
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

  it("the two calendar cron ROUTES (reconcile sweep + B2.3-c2 worker drain) exist as files; neither is cron-registered", () => {
    const cronRoutes = walk(join("app", "api", "cron")).filter((f) => /calendar/i.test(f));
    // B2.3-c2 adds the worker-DRAIN route (/api/cron/calendar-sync); it is present
    // but UNSCHEDULED (the no-cron-registration invariant is asserted above).
    expect(cronRoutes.some((f) => /calendar-sync/.test(f))).toBe(true);
    // B2.3-b's reconcile SWEEP route remains present.
    expect(cronRoutes.some((f) => /calendar-reconcile/.test(f))).toBe(true);
    expect(cronRoutes.length).toBe(2);
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
