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

  it("no cron schedule references calendar-sync OR calendar-reconcile (nothing cron-registered)", () => {
    for (const cfg of ["vercel.json", "vercel.ts"]) {
      let text = "";
      try {
        text = readFileSync(join(ROOT, cfg), "utf8");
      } catch {
        continue;
      }
      expect(text.includes("calendar-sync")).toBe(false);
      expect(text.includes("calendar_sync")).toBe(false);
      expect(text.includes("calendar-reconcile")).toBe(false); // sweep route stays dormant (no schedule)
    }
  });

  it("the calendar-sync DRAIN route is absent; the only calendar cron route is the reconcile sweep", () => {
    const cronRoutes = walk(join("app", "api", "cron")).filter((f) => /calendar/i.test(f));
    // The worker-drain route (/api/cron/calendar-sync) is B2.3-c — still absent.
    expect(cronRoutes.some((f) => /calendar-sync/.test(f))).toBe(false);
    // The reconcile SWEEP route is the single allowed B2.3-b calendar cron route.
    expect(cronRoutes.length).toBe(1);
    expect(cronRoutes.every((f) => /calendar-reconcile/.test(f))).toBe(true);
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
