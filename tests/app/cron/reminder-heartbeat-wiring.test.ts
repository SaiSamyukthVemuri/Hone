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
const MATERIALIZE = read("app/api/cron/materialize-recurring-breaks/route.ts");

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

  it("does NOT record/alert on render — the admin page only reads + classifies (no write-on-render)", () => {
    // The health-alert recorder must not run during admin page render.
    expect(ADMIN).not.toMatch(/recordReminderSchedulerHealthAlert/);
  });
});

// ---------------------------------------------------------------------------
// PR #283. The stale/missing reminder-scheduler ops alert + its wiring onto
// the EXISTING daily materialize-recurring-breaks cron.
// ---------------------------------------------------------------------------
describe("reminder-scheduler health alert function (lib/cron/reminder-heartbeat.ts)", () => {
  it("dedupes on an UNRESOLVED ops_alerts row for the same event", () => {
    expect(HEARTBEAT).toMatch(/\.from\("ops_alerts"\)/);
    expect(HEARTBEAT).toMatch(/\.is\("resolved_at", null\)/);
  });

  it("uses the two event names with the chosen severities (stale=warning, missing=critical)", () => {
    expect(HEARTBEAT).toContain("reminder_scheduler_stale");
    expect(HEARTBEAT).toContain("reminder_scheduler_missing");
    expect(HEARTBEAT).toMatch(/severity:\s*"warning"/);
    expect(HEARTBEAT).toMatch(/severity:\s*"critical"/);
  });

  it("is best-effort/fail-open and returns a result (never throws to the caller)", () => {
    // The dedupe read is wrapped in try/catch and the function returns a
    // typed result rather than throwing.
    expect(HEARTBEAT).toMatch(/Promise<ReminderSchedulerHealthAlertResult>/);
    expect(HEARTBEAT).toMatch(/try\s*\{[\s\S]*?\}\s*catch/);
  });

  it("does NOT auto-resolve (no resolved_at write back from the health check)", () => {
    // Operator resolves manually. The function only SELECTs resolved_at; it
    // must not UPDATE/insert resolved_at.
    const code = codeOnly(HEARTBEAT);
    expect(code).not.toMatch(/resolved_at:\s/); // no resolved_at write payload
    expect(code).not.toMatch(/\.update\(/);
  });

  it("never reads CRON_SECRET or includes PII/reminder content in the alert (code, not comments)", () => {
    const code = codeOnly(HEARTBEAT);
    expect(code).not.toMatch(/process\.env\.CRON_SECRET/);
    expect(code).not.toMatch(/authorization/i);
    // safe_details builder keys are timing-only.
    expect(HEARTBEAT).toMatch(/reminderSchedulerAlertSafeDetails/);
    const builder =
      HEARTBEAT.match(
        /reminderSchedulerAlertSafeDetails\([\s\S]*?\)\s*:\s*Record<string, unknown>\s*\{[\s\S]*?\n\}/,
      )?.[0] ?? "";
    expect(builder).not.toMatch(/\bemail\b|\bphone\b|\bname\b|notes|token|reminder_text|body|message/i);
  });
});

describe("daily materialize cron runs the health check best-effort (PR #283)", () => {
  it("imports + calls recordReminderSchedulerHealthAlert", () => {
    expect(MATERIALIZE).toMatch(
      /import \{ recordReminderSchedulerHealthAlert \} from "@\/lib\/cron\/reminder-heartbeat"/,
    );
    expect(MATERIALIZE).toMatch(/await recordReminderSchedulerHealthAlert\(\)/);
  });

  it("wraps the health check in try/catch so its failure cannot break the daily cron", () => {
    expect(MATERIALIZE).toMatch(
      /try\s*\{\s*await recordReminderSchedulerHealthAlert\(\);\s*\}\s*catch/,
    );
  });

  it("runs the check AFTER the auth gate (an unauthorized 401 records nothing)", () => {
    const gate = MATERIALIZE.indexOf("isAuthorizedCronRequest(req)");
    const check = MATERIALIZE.indexOf("recordReminderSchedulerHealthAlert(");
    expect(gate).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(gate);
  });

  it("does NOT send reminders or call the appointment-reminders route", () => {
    // Code only — a comment may legitimately name the route it deliberately
    // does NOT call.
    const code = codeOnly(MATERIALIZE);
    expect(code).not.toMatch(/appointment-reminders/);
    expect(code).not.toMatch(/recordReminderRunSuccess/);
    expect(code).not.toMatch(/sendReminder|send_email|sendSms|twilio|resend/i);
  });
});
