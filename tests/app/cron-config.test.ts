import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  APPOINTMENT_REMINDER_CRON_SCHEDULE,
  MATERIALIZE_RECURRING_BREAKS_CRON_SCHEDULE,
  windowCoversAllOffsets,
} from "@/lib/cron/reminder-schedule";

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

describe("vercel.json schedules every active cron route", () => {
  const crons = VERCEL.crons ?? [];
  const byPath = new Map(crons.map((c) => [c.path, c.schedule]));

  it("schedules appointment-reminders at the shared */15 cadence", () => {
    expect(byPath.get("/api/cron/appointment-reminders")).toBe(
      APPOINTMENT_REMINDER_CRON_SCHEDULE,
    );
  });

  it("schedules materialize-recurring-breaks daily", () => {
    expect(byPath.get("/api/cron/materialize-recurring-breaks")).toBe(
      MATERIALIZE_RECURRING_BREAKS_CRON_SCHEDULE,
    );
  });

  it("does NOT schedule no-show-check (intentionally disabled), and the route documents why", () => {
    expect(byPath.has("/api/cron/no-show-check")).toBe(false);
    expect(NO_SHOW).toMatch(/DISABLED|non-mutating/i);
  });

  it("crons is non-empty (the reported empty-crons bug is fixed)", () => {
    expect(crons.length).toBeGreaterThanOrEqual(2);
  });
});

describe("the scheduled cadence covers the 2h reminder window", () => {
  it("the */N cadence in vercel.json makes the 2h window lose no appointment offsets", () => {
    const schedule = (VERCEL.crons ?? []).find(
      (c) => c.path === "/api/cron/appointment-reminders",
    )?.schedule;
    const m = schedule?.match(/^\*\/(\d+) \* \* \* \*$/);
    expect(m).not.toBeNull();
    const periodMin = Number(m![1]);
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
    // error — only studio/appointment ids + reminder type/attempt metadata.
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
