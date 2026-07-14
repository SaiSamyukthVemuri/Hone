import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Google Calendar — Phase B2.1: static proof the worker core is DORMANT.
// The transport-neutral core + REST client + token lifecycle exist under
// lib/google-calendar/sync, but nothing activates them: no app route/action
// imports the worker, no cron schedule is registered, and the modules are
// server-only. (Enqueue is B2.3; event operations + a live cron are B2.4/B2.5.)

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
  it("no app/ route or action imports the sync worker", () => {
    const offenders = walk("app").filter((f) => readFileSync(join(ROOT, f), "utf8").includes("google-calendar/sync"));
    expect(offenders).toEqual([]);
  });

  it("no cron schedule references calendar-sync (no production cron in this PR)", () => {
    for (const cfg of ["vercel.json", "vercel.ts"]) {
      let text = "";
      try {
        text = readFileSync(join(ROOT, cfg), "utf8");
      } catch {
        continue;
      }
      expect(text.includes("calendar-sync")).toBe(false);
      expect(text.includes("calendar_sync")).toBe(false);
    }
  });

  it("no app/api/cron route exists for calendar sync", () => {
    const cronRoutes = walk(join("app", "api", "cron")).filter((f) => /calendar/i.test(f));
    expect(cronRoutes).toEqual([]);
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
