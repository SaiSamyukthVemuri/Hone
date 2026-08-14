import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  APPOINTMENT_REMINDER_CRON_SCHEDULE,
  MATERIALIZE_RECURRING_BREAKS_CRON_SCHEDULE,
  windowCoversAllOffsets,
} from "@/lib/cron/reminder-schedule";
import {
  CALENDAR_RECONCILE_CRON_SCHEDULE,
  CALENDAR_SYNC_CRON_SCHEDULE,
} from "@/lib/cron/calendar-cron-schedule";

// PR #258: cron configuration + reminder-route reliability pins. vercel.json
// must schedule every ACTIVE cron route (the empty `{ "crons": [] }` was the
// bug), the reminder cadence must cover the 2h window, and claim-before-send /
// idempotency / cron auth must stay intact.

const ROOT = path.resolve(__dirname, "../..");
function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}
function codeOnly(src: string): string {
  return src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
}

const VERCEL = JSON.parse(read("vercel.json")) as {
  crons?: { path: string; schedule: string }[];
};
const ROUTE = read("app/api/cron/appointment-reminders/route.ts");
const ROUTE_CODE = codeOnly(ROUTE);
const NO_SHOW = read("app/api/cron/no-show-check/route.ts");

describe("vercel.json cron config (fixes the reported empty-crons bug)", () => {
  const crons = VERCEL.crons ?? [];
  const byPath = new Map(crons.map((c) => [c.path, c.schedule]));

  it("schedules the daily materialize-recurring-breaks cron (allowed on every plan)", () => {
    expect(byPath.get("/api/cron/materialize-recurring-breaks")).toBe(
      MATERIALIZE_RECURRING_BREAKS_CRON_SCHEDULE,
    );
  });

  it("does NOT put appointment-reminders in vercel.json (sub-daily exceeds the current plan; fired by an external every-15m scheduler instead)", () => {
    // A `*/15` vercel.json cron is rejected by the project's plan (cron cadence
    // capped at once/day), which fails the deploy. The 2h reminder needs
    // sub-daily checks, so the route is driven externally; see docs/08 + docs/10.
    expect(byPath.has("/api/cron/appointment-reminders")).toBe(false);
  });

  it("does NOT schedule no-show-check (intentionally disabled), and the route documents why", () => {
    expect(byPath.has("/api/cron/no-show-check")).toBe(false);
    expect(NO_SHOW).toMatch(/DISABLED|non-mutating/i);
  });

  it("crons is non-empty (no longer the empty `[]` that left every route unscheduled)", () => {
    expect(crons.length).toBeGreaterThanOrEqual(1);
  });

  // B2.3-c3: the two Google Calendar cron routes are now registered as DAILY crons
  // (the plan caps cron at once/day), staggered after the 08:00 materialize-breaks
  // cron, reconciliation BEFORE the worker. Registration is DORMANT, worker_enabled
  // stays false so the claim RPC returns zero rows and mutates nothing.
  it("schedules the daily calendar-reconcile cron at the canonical (daily) cadence", () => {
    expect(byPath.get("/api/cron/calendar-reconcile")).toBe(CALENDAR_RECONCILE_CRON_SCHEDULE);
    expect(CALENDAR_RECONCILE_CRON_SCHEDULE).toMatch(/^\d+ \d+ \* \* \*$/); // once-per-day (plan-supported)
  });

  it("schedules the daily calendar-sync worker-drain cron at the canonical (daily) cadence, AFTER reconciliation", () => {
    expect(byPath.get("/api/cron/calendar-sync")).toBe(CALENDAR_SYNC_CRON_SCHEDULE);
    expect(CALENDAR_SYNC_CRON_SCHEDULE).toMatch(/^\d+ \d+ \* \* \*$/); // once-per-day (plan-supported)
    // Reconciliation fires before the worker on the same daily hour (B2.3-c3 §6 order).
    const rMin = Number(CALENDAR_RECONCILE_CRON_SCHEDULE.split(" ")[0]);
    const wMin = Number(CALENDAR_SYNC_CRON_SCHEDULE.split(" ")[0]);
    expect(wMin).toBeGreaterThan(rMin);
  });

  it("registers no sub-daily calendar cron (the plan rejects `*/N` at deploy) and no duplicate paths", () => {
    for (const c of crons) {
      if (/calendar-(sync|reconcile)/.test(c.path)) {
        expect(c.schedule).not.toMatch(/\*\//); // never a sub-daily cadence
      }
    }
    const paths = crons.map((c) => c.path);
    expect(paths.length).toBe(new Set(paths).size); // no duplicate cron paths
  });
});

describe("the required reminder cadence covers the 2h window", () => {
  it("the documented */15 external cadence loses no appointment offsets; the old hourly assumption would", () => {
    const m = APPOINTMENT_REMINDER_CRON_SCHEDULE.match(/^\*\/(\d+) \* \* \* \*$/);
    expect(m).not.toBeNull();
    const periodMin = Number(m![1]);
    expect(periodMin).toBe(15);
    expect(windowCoversAllOffsets("2h", periodMin)).toBe(true);
    // And the prior hourly assumption would NOT have covered it.
    expect(windowCoversAllOffsets("2h", 60)).toBe(false);
  });
});

describe("reminder route preserves claim-before-send, idempotency, and auth", () => {
  it("uses the shared reminder window (no inline 105/135 magic numbers)", () => {
    expect(ROUTE_CODE).toMatch(/reminderWindowIso\(/);
    expect(ROUTE_CODE).not.toMatch(/105 \* 60|135 \* 60/);
  });

  it("claims BEFORE sending and records the result AFTER", () => {
    const claimIdx = ROUTE_CODE.indexOf("claimEmailSend(");
    const sendIdx = ROUTE_CODE.indexOf("const result = await sendFn(");
    const recordIdx = ROUTE_CODE.indexOf("recordEmailResult(admin, appt.id, emailType, result.ok)");
    expect(claimIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(claimIdx);
    expect(recordIdx).toBeGreaterThan(sendIdx);
  });

  it("re-checks appointment status immediately before send in BOTH the email and SMS passes (cancellation race)", () => {
    const reChecks = ROUTE_CODE.match(/\.status !== "confirmed"/g) ?? [];
    expect(reChecks.length).toBeGreaterThanOrEqual(2);
  });

  it("alerts the operator when a reminder exhausts max attempts (safe metadata only)", () => {
    expect(ROUTE_CODE).toMatch(/reminder_send_exhausted/);
    expect(ROUTE_CODE).toMatch(/alertIfReminderExhausted\(/);
    // The alert helper's body must carry NO client PII / token / free-text
    // error, only studio/appointment ids + reminder type/attempt metadata.
    const start = ROUTE_CODE.indexOf("async function alertIfReminderExhausted");
    const end = ROUTE_CODE.indexOf("async function sendReminderPass", start);
    const body = ROUTE_CODE.slice(start, end);
    expect(body).toMatch(/reminder_type/);
    expect(body).toMatch(/attempt_count/);
    expect(body).not.toMatch(/client|cancellation_token|result\.error|\.notes/i);
  });

  it("keeps the CRON_SECRET bearer auth gate and adds no payment/stripe calls", () => {
    expect(ROUTE_CODE).toMatch(/isAuthorizedCronRequest\(req\)/);
    expect(ROUTE_CODE).not.toMatch(/paymentIntents|stripe|charges\.create/i);
  });
});

// ---------------------------------------------------------------------------
// PR OPS-01. Bounded-backlog + auth side-effect pins for the reminder route.
//
// OPS-01 recon found PER_RUN_LIMIT was implemented but pinned by NO test, so a
// future edit could silently make the reminder query unbounded. An unbounded
// SELECT is not a throughput win here: it is how one late run tries to process
// an entire backlog inside a single serverless invocation.
// ---------------------------------------------------------------------------
describe("reminder route stays bounded per run (PR OPS-01)", () => {
  it("declares an explicit per-run cap of 50", () => {
    expect(ROUTE).toMatch(/const PER_RUN_LIMIT = 50;/);
  });

  it("actually applies the cap to the window query (not just declares it)", () => {
    expect(ROUTE_CODE).toMatch(/\.limit\(PER_RUN_LIMIT\)/);
  });

  it("the only numeric-literal limits are single-row lookups, never the window cap", () => {
    // The window query must use the named constant. Elsewhere the route
    // legitimately calls .limit(1) to fetch one latest intake row, so the rule
    // is: every numeric .limit() in this file is exactly .limit(1).
    const numericLimits = ROUTE_CODE.match(/\.limit\(\s*\d+\s*\)/g) ?? [];
    for (const call of numericLimits) {
      expect(call.replace(/\s+/g, "")).toBe(".limit(1)");
    }
  });

  it("keeps the 3-strike attempt cap and applies it to the query", () => {
    expect(ROUTE).toMatch(/const MAX_ATTEMPTS = 3;/);
    expect(ROUTE_CODE).toMatch(/\.lt\(opts\.attemptsColumn, MAX_ATTEMPTS\)/);
  });

  it("orders the window by starts_at so the cap takes the soonest appointments", () => {
    expect(ROUTE_CODE).toMatch(/\.order\("starts_at", \{ ascending: true \}\)/);
  });
});

describe("an unauthorized reminder invocation is side-effect free (PR OPS-01)", () => {
  // Proven in production during the OPS-01 recon: an unauthenticated GET to
  // https://hone.care/api/cron/appointment-reminders returned
  // 401 {"ok":false,"error":"Unauthorized"}. This pins the source property that
  // makes such a probe safe, the gate is the FIRST thing in the handler, so a
  // 401 touches no admin client, no claim, no provider, no heartbeat.
  it("the auth gate is the first statement of GET, before any work", () => {
    const handler = ROUTE.slice(ROUTE.indexOf("export async function GET"));
    const gate = handler.indexOf("isAuthorizedCronRequest(req)");
    expect(gate).toBeGreaterThan(-1);
    for (const sideEffect of [
      "createAdminClient(",
      "claimEmailSend(",
      "recordEmailResult(",
      "recordReminderRunSuccess(",
      "sendReminderPass(",
      "sendSmsReminderPass(",
      "sendIntakeReminderPass(",
    ]) {
      const at = handler.indexOf(sideEffect);
      if (at > -1) expect(at).toBeGreaterThan(gate);
    }
  });

  it("returns 401 without recording an ops alert or a heartbeat", () => {
    const handler = ROUTE.slice(ROUTE.indexOf("export async function GET"));
    const unauthorizedBlock = handler.slice(0, handler.indexOf("const startedAt"));
    expect(unauthorizedBlock).toMatch(/status: 401/);
    expect(unauthorizedBlock).not.toMatch(/recordOpsAlert|recordReminderRunSuccess/);
  });
});
