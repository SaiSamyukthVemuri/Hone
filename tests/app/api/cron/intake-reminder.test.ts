import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  INTAKE_REMINDER_WINDOW_MINUTES,
  intakeReminderWindowIso,
  intakeWindowCoversAllOffsets,
  CRON_INTERVAL_MINUTES,
} from "@/lib/cron/reminder-schedule";

// PR #306. Intake-form reminder cron: reuses the appointment-reminder
// claim-before-send idempotency, sends only for in_progress intakes, mints a
// fresh link, and stamps the PR #303 metadata. Source-grep the route (the cron
// isn't DOM/DB-run in the node env) + unit-test the window helpers.

const ROUTE = readFileSync(
  path.resolve(__dirname, "../../../../app/api/cron/appointment-reminders/route.ts"),
  "utf8",
);
const codeOnly = (src: string) =>
  src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const CODE = codeOnly(ROUTE);
// Scope assertions to the intake pass so the appointment/SMS passes can't
// satisfy them.
const START = CODE.indexOf("async function sendIntakeReminderPass");
const END = CODE.indexOf("async function sendSmsReminderPass");
const INTAKE_PASS = CODE.slice(START, END > START ? END : undefined);

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
describe("intake reminder windows", () => {
  it("7d and 3d windows are centered on the target day", () => {
    expect(INTAKE_REMINDER_WINDOW_MINUTES["7d"]).toEqual({
      start: 7 * 24 * 60 - 60,
      end: 7 * 24 * 60 + 60,
    });
    expect(INTAKE_REMINDER_WINDOW_MINUTES["3d"]).toEqual({
      start: 3 * 24 * 60 - 60,
      end: 3 * 24 * 60 + 60,
    });
  });

  it("both windows are >= the cron cadence so no appointment offset is missed", () => {
    expect(intakeWindowCoversAllOffsets("7d", CRON_INTERVAL_MINUTES)).toBe(true);
    expect(intakeWindowCoversAllOffsets("3d", CRON_INTERVAL_MINUTES)).toBe(true);
  });

  it("intakeReminderWindowIso maps to now + offset", () => {
    const now = Date.parse("2026-07-01T00:00:00.000Z");
    const w = intakeReminderWindowIso("3d", now);
    expect(w.startIso).toBe(new Date(now + (3 * 24 * 60 - 60) * 60_000).toISOString());
    expect(w.endIso).toBe(new Date(now + (3 * 24 * 60 + 60) * 60_000).toISOString());
  });
});

// ---------------------------------------------------------------------------
// Cron pass shape
// ---------------------------------------------------------------------------
describe("sendIntakeReminderPass shape", () => {
  it("keys off the intake_reminder_7d/3d sent + attempts columns", () => {
    expect(INTAKE_PASS).toMatch(/intake_reminder_7d_sent_at/);
    expect(INTAKE_PASS).toMatch(/intake_reminder_3d_sent_at/);
    expect(INTAKE_PASS).toMatch(/intake_reminder_7d_send_attempts/);
  });

  it("resolves the latest intake (studio+client scoped) BEFORE claiming", () => {
    expect(INTAKE_PASS).toMatch(/\.from\("client_intake_forms"\)/);
    expect(INTAKE_PASS).toMatch(/\.eq\("studio_id", appt\.studio\.id\)/);
    expect(INTAKE_PASS).toMatch(/\.eq\("client_id", appt\.client_id\)/);
    const intakeIdx = INTAKE_PASS.indexOf("client_intake_forms");
    const claimIdx = INTAKE_PASS.indexOf("claimEmailSend");
    expect(intakeIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(intakeIdx); // intake read precedes claim
  });

  it("sends ONLY when intake status is in_progress (skips submitted/reviewed/missing)", () => {
    expect(INTAKE_PASS).toMatch(/!intake \|\| intake\.status !== "in_progress"/);
  });

  it("skips when the client has no email", () => {
    expect(INTAKE_PASS).toMatch(/if \(!appt\.client\?\.email\) continue;/);
  });

  it("claims before send + records the result (idempotency)", () => {
    expect(INTAKE_PASS).toMatch(/const claimed = await claimEmailSend\(admin, appt\.id, emailType\)/);
    expect(INTAKE_PASS).toMatch(/if \(!claimed\)/);
    expect(INTAKE_PASS).toMatch(/await recordEmailResult\(admin, appt\.id, emailType, result\.ok\)/);
  });

  it("mints a FRESH link and stamps intake metadata with emailed:true only on success", () => {
    expect(INTAKE_PASS).toMatch(/generateIntakeLinkUrl\(intake\.id, appOrigin\)/);
    // Stamp is inside the result.ok branch.
    expect(INTAKE_PASS).toMatch(/if \(result\.ok\) \{[\s\S]*?stampIntakeLinkIssued\(admin, intake\.id, \{ emailed: true \}\)/);
  });

  it("logs only ids/kinds — no raw token, no client PII", () => {
    // The pass never logs the token, the client email/name, or intake responses.
    expect(INTAKE_PASS).not.toMatch(/intakeUrl[\s\S]{0,40}console|console[\s\S]{0,60}intakeUrl/);
    expect(INTAKE_PASS).not.toMatch(/console\.[a-z]+\([^)]*(client\.email|client\.name|token|responses)/);
    // logEmailFailure carries appointmentId + studioId + kind only.
    expect(INTAKE_PASS).toMatch(/logEmailFailure\(\{[\s\S]*?appointmentId: appt\.id/);
  });
});

describe("intake passes wired into the GET handler", () => {
  it("computes 7d/3d windows and runs both passes", () => {
    expect(CODE).toMatch(/intakeReminderWindowIso\("7d", now\)/);
    expect(CODE).toMatch(/intakeReminderWindowIso\("3d", now\)/);
    expect(CODE).toMatch(/const intake_reminder_7d = await sendIntakeReminderPass/);
    expect(CODE).toMatch(/const intake_reminder_3d = await sendIntakeReminderPass/);
  });
  it("includes intake counts in the heartbeat + response", () => {
    expect(CODE).toMatch(/intake_reminder_7d\.attempted/);
    expect(CODE).toMatch(/intake_reminder_7d,\s*\n?\s*intake_reminder_3d,/);
  });
});
