import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #265. Source-grep pins for the reminder-scheduler status signal:
//   * the cron route records the success heartbeat ONLY on the authorized
//     path (after the CRON_SECRET gate), so an unauthorized 401 records
//     nothing, and only after the passes complete (inside the try, so a
//     thrown run records cron_route_failed instead);
//   * the heartbeat payload + module carry NO secret / PII (no CRON_SECRET,
//     email, phone, name, token, notes);
//   * the heartbeat is best-effort/fail-open and reuses Upstash (no migration,
//     no new dependency);
//   * the admin console surfaces the status (operator-only).

const REPO_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string =>
  readFileSync(path.join(REPO_ROOT, rel), "utf8");

const ROUTE = read("app/api/cron/appointment-reminders/route.ts");
const HEARTBEAT = read("lib/cron/reminder-heartbeat.ts");
const ADMIN = read("app/admin/page.tsx");

// Strip comments so doc-comments that ENUMERATE forbidden fields (e.g. "never
// store email/phone/notes") don't trip the PII checks below.
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

describe("cron route records the heartbeat on the authorized success path only", () => {
  it("calls recordReminderRunSuccess after the auth gate (401 records nothing)", () => {
    const gate = ROUTE.indexOf("isAuthorizedCronRequest(req)");
    const hb = ROUTE.indexOf("recordReminderRunSuccess(");
    expect(gate).toBeGreaterThan(-1);
    expect(hb).toBeGreaterThan(gate);
  });

  it("records the heartbeat before the ok:true return, after the passes", () => {
    const hb = ROUTE.indexOf("recordReminderRunSuccess(");
    const okReturn = ROUTE.indexOf("ok: true");
    expect(hb).toBeGreaterThan(-1);
    expect(okReturn).toBeGreaterThan(hb);
  });

  it("the heartbeat payload carries only non-sensitive aggregate counts", () => {
    const block =
      ROUTE.match(/recordReminderRunSuccess\(\{[\s\S]*?\}\);/)?.[0] ?? "";
    expect(block).not.toBe("");
    expect(block).toMatch(/\bat:/);
    // Aggregate counts only.
    expect(block).toMatch(/emailAttempted|smsAttempted/);
    // No PII / secret leaks in the payload.
    expect(block).not.toMatch(/email\b|phone|\bname\b|notes|token|CRON_SECRET|client/i);
  });
});

describe("heartbeat module is fail-open, secret-free, and migration-free", () => {
  it("reuses Upstash (no new dependency, no DB migration)", () => {
    expect(HEARTBEAT).toMatch(/@upstash\/redis/);
    expect(HEARTBEAT).toMatch(/UPSTASH_REDIS_REST_URL/);
    expect(HEARTBEAT).toMatch(/UPSTASH_REDIS_REST_TOKEN/);
  });

  it("is best-effort/fail-open (write + read wrapped, never throws)", () => {
    expect(HEARTBEAT).toMatch(/try\s*\{[\s\S]*?\}\s*catch/);
    // The write helper returns early when Upstash is unconfigured.
    expect(HEARTBEAT).toMatch(/if \(!redis\) return/);
  });

  it("never reads the CRON_SECRET value or references client PII (code, not comments)", () => {
    const code = codeOnly(HEARTBEAT);
    expect(code).not.toMatch(/process\.env\.CRON_SECRET/);
    expect(code).not.toMatch(/\bemail\b|\bphone\b|\bnotes\b|cancellation_token/i);
  });

  it("derives the stale threshold from the shared cadence constant", () => {
    expect(HEARTBEAT).toMatch(/CRON_INTERVAL_MINUTES/);
    expect(HEARTBEAT).toMatch(/REMINDER_STALE_AFTER_MINUTES/);
  });
});

describe("admin console surfaces the scheduler status (operator-only)", () => {
  it("reads the heartbeat and renders the status card", () => {
    expect(ADMIN).toMatch(/readReminderHeartbeat/);
    expect(ADMIN).toMatch(/computeReminderSchedulerStatus/);
    expect(ADMIN).toMatch(/ReminderSchedulerCard/);
  });

  it("classifies healthy/stale/missing and names the external scheduler", () => {
    expect(ADMIN).toMatch(/healthy/);
    expect(ADMIN).toMatch(/stale/);
    expect(ADMIN).toMatch(/missing/);
    expect(ADMIN).toMatch(/external scheduler/i);
  });
});
