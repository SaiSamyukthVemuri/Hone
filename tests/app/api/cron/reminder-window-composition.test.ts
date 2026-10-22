import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CRON_INTERVAL_MINUTES,
  REMINDER_WINDOW_MINUTES,
  windowCoversAllOffsets,
} from "@/lib/cron/reminder-schedule";

// 0186 — the ~24h / ~2h window email, COMPOSED.
//
// This file is the SOURCE CONTRACT for the six-case law. It proves the route
// SAYS the right thing and, critically, says it in the right ORDER. The
// behavioural half — that one claim really does stop two overlapping runs, that
// a plain reminder really does leave the intake-link counters alone — runs
// against the real migrated database in
// tests/db/reminder-window-composition.db.test.ts. Neither is sufficient
// alone: source text cannot prove a race, and a behavioural test cannot prove
// that a live re-read was written rather than a cached value reused.

const ROUTE = readFileSync(
  path.resolve(__dirname, "../../../../app/api/cron/appointment-reminders/route.ts"),
  "utf8",
);
const codeOnly = (src: string) =>
  src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const CODE = codeOnly(ROUTE);

// Scope the ordering assertions to the composed pass so the SMS pass cannot
// satisfy them.
const START = CODE.indexOf("async function sendReminderPass");
const END = CODE.indexOf("async function sendSmsReminderPass");
const PASS = CODE.slice(START, END > START ? END : undefined);

it("the pass slice is real (guards every assertion below from passing vacuously)", () => {
  expect(START).toBeGreaterThan(-1);
  expect(END).toBeGreaterThan(START);
  expect(PASS.length).toBeGreaterThan(500);
});

// ---------------------------------------------------------------------------
// The retired 7d/3d cadence
// ---------------------------------------------------------------------------
describe("the 7d/3d intake cadence is retired, not reinterpreted", () => {
  it("the route no longer reads or writes ANY 7d/3d intake send-state", () => {
    expect(CODE).not.toMatch(/intake_reminder_7d/);
    expect(CODE).not.toMatch(/intake_reminder_3d/);
  });

  it("the separate intake pass and its windows are gone", () => {
    expect(CODE).not.toMatch(/sendIntakeReminderPass/);
    expect(CODE).not.toMatch(/intakeReminderWindowIso/);
  });
});

// Composition moved into one fresh governed DB projection; the existing fake
// renderer tests exercise its three wire shapes. DB concurrency remains UNRUN.
describe("0247 composition has one governed authority", () => {
  it("uses the shared reminder purpose and no legacy writer fallback", () => {
    expect(PASS).toContain('opts.kind === "24h" ? "reminder_24h" : "reminder_2h"');
    expect(PASS.match(/await sendAppointmentReminderOperation\(/g)).toHaveLength(1);
    expect(PASS).not.toMatch(/claimEmailSend|recordEmailResult|readLatestIntake|generateIntakeLinkUrl/);
  });
  it("does not reconstruct current content from cached joins", () => {
    expect(PASS).not.toMatch(/appt\.client|appt\.service|appt\.practitioner|appt\.studio\./);
    expect(PASS).toContain('result.kind === "held"');
    expect(PASS).toContain('stats.skipped += 1; return;');
  });
  it("stamps a carried intake link only for confirmed current acceptance", () => {
    expect(PASS).toContain('result.observation.kind === "accepted"');
    expect(PASS).toContain('result.persistence === "recorded" && result.projection === "current" && result.intakeId');
    expect(PASS).toContain('stampIntakeLinkIssued(admin, result.intakeId, { emailed: true })');
  });
  it("preserves the cap and only calls exhaustion for definite refusal", () => {
    expect(CODE).toContain('const MAX_ATTEMPTS = 3;');
    expect(CODE).toContain('.lt(opts.attemptsColumn, MAX_ATTEMPTS)');
    expect(PASS).toContain('result.observation.kind === "definite_refusal"');
    expect(PASS).toContain('intakeCtaIncluded: result.intakeId !== null');
  });
  it("reports unconfirmed accounting without a private payload or retry", () => {
    expect(PASS).toContain('result.persistence === "unconfirmed"');
    expect(PASS).toContain('event: "reminder_email_accounting_failed"');
    expect(PASS).not.toMatch(/console\.|recordEmailAttempt/);
  });
});

// ---------------------------------------------------------------------------
// Windows: reused, not reinvented
// ---------------------------------------------------------------------------
describe("windows come from the shared, already-proven module", () => {
  it("the route computes only the 24h and 2h reminder windows", () => {
    const driver = readFileSync(path.resolve(__dirname, "../../../../lib/cron/reminder-scan-coordinator.ts"), "utf8");
    expect(CODE).toContain("runReminderScanBatch({");
    expect(driver).toContain('return reminderWindowIso(pass.endsWith("24h") ? "24h" : "2h", now);');
    expect(CODE).not.toMatch(/INTAKE_REMINDER_WINDOW_MINUTES/);
  });

  it("both windows still cover every appointment minute offset at the shipped cadence", () => {
    expect(windowCoversAllOffsets("24h", CRON_INTERVAL_MINUTES)).toBe(true);
    expect(windowCoversAllOffsets("2h", CRON_INTERVAL_MINUTES)).toBe(true);
    expect(REMINDER_WINDOW_MINUTES["24h"]).toEqual({ start: 23 * 60, end: 25 * 60 });
    expect(REMINDER_WINDOW_MINUTES["2h"]).toEqual({ start: 105, end: 135 });
  });
});

// ---------------------------------------------------------------------------
// Log safety
// ---------------------------------------------------------------------------
describe("logging carries ids and kinds only", () => {
  it("never logs a token, a link, a client address or intake answers", () => {
    expect(PASS).not.toMatch(/console\.[a-z]+\([^)]*(client\.email|client\.name|intakeUrl|token|responses)/);
    expect(PASS).toMatch(/logEmailFailure\(\{[\s\S]*?appointmentId: appt\.id/);
  });

  it("the run stats expose an aggregate CTA count, never per-client detail", () => {
    expect(PASS).toMatch(/stats\.intakeCtaIncluded \+= 1;/);
    expect(CODE).toMatch(/type EmailRunStats = RunStats & \{ intakeCtaIncluded: number \};/);
  });
});

// ---------------------------------------------------------------------------
// SMS: the same composition, through the existing SMS channel
// ---------------------------------------------------------------------------
const SMS_START = CODE.indexOf("async function sendSmsReminderPass");
const SMS_END = CODE.indexOf("export async function GET");
const SMS_PASS = CODE.slice(SMS_START, SMS_END > SMS_START ? SMS_END : undefined);

it("the SMS pass slice is real", () => {
  expect(SMS_START).toBeGreaterThan(-1);
  expect(SMS_END).toBeGreaterThan(SMS_START);
  expect(SMS_PASS.length).toBeGreaterThan(500);
});

describe("intake SMS reuses the existing SMS channel and its authority", () => {
  it("enabling send_intake_reminders can NEVER open a new SMS channel", () => {
    // The window's own SMS toggle is checked FIRST and `continue`s, so a studio
    // with SMS reminders off sends no intake SMS whatever the intake setting
    // says. There is deliberately no standalone intake SMS.
    const toggleAt = SMS_PASS.indexOf("[studioToggle]");
    const intakeAt = SMS_PASS.indexOf("send_intake_reminders");
    expect(toggleAt).toBeGreaterThan(-1);
    expect(intakeAt).toBeGreaterThan(toggleAt);
    expect(SMS_PASS).not.toMatch(/sendIntakeReminderToClient/);
  });

  it("keeps every consent prerequisite ahead of the intake read", () => {
    const intakeAt = SMS_PASS.indexOf("send_intake_reminders");
    for (const gate of [
      "if (!appt.client.phone) return;",
      "if (!appt.client.sms_consent_at) return;",
      "if (appt.client.sms_opted_out_at) return;",
    ]) {
      const at = SMS_PASS.indexOf(gate);
      expect(at, `missing gate: ${gate}`).toBeGreaterThan(-1);
      expect(at).toBeLessThan(intakeAt);
    }
  });

  it("re-checks the appointment is still confirmed BEFORE deciding the CTA", () => {
    const statusAt = SMS_PASS.indexOf("freshSms.status !== \"confirmed\"");
    const intakeAt = SMS_PASS.indexOf("send_intake_reminders");
    expect(statusAt).toBeGreaterThan(-1);
    expect(intakeAt).toBeGreaterThan(statusAt);
  });

  it("reads intake LIVE, in its own query, never the email pass's result", () => {
    expect(SMS_PASS).toMatch(
      /const smsIntake =\s*\n?\s*appt\.studio\.send_intake_reminders !== false\s*\n?\s*\? await readLatestIntake\(admin, appt\.studio\.id, appt\.client_id\)\s*\n?\s*: null;/,
    );
    expect(SMS_PASS).toMatch(
      /const smsIntakeUrl =\s*\n?\s*smsIntake\?\.status === "in_progress"/,
    );
  });

  it("sends exactly ONE SMS per appointment per window", () => {
    expect(SMS_PASS.match(/await sendFn\(/g) ?? []).toHaveLength(1);
    expect(SMS_PASS).toMatch(/intakeUrl: smsIntakeUrl,/);
  });

  it("does not touch the SMS claim, consent gate or Twilio contract", () => {
    // The pass adds a body ingredient; idempotency stays where it was.
    expect(SMS_PASS).not.toMatch(/claimSmsSend|claim_sms_send|record_sms_result/);
  });
});

describe("intake-link accounting stays truthful PER CHANNEL", () => {
  it("the SMS pass stamps only for an accepted or POSSIBLY-SENT SMS that carried the link", () => {
    // Codex P2 4232680581: an ambiguous answer is recorded as sent and never
    // retried, so a link it carried may be in the client's hands. What the
    // message carried comes from the send helper. The behaviour, with its
    // refusal and skip controls, is driven through the real route in
    // reminder-sms-intake-stamp.test.ts.
    expect(SMS_PASS).toMatch(/if \(result\.ok\) \{[\s\S]*?linkMayHaveGone = result\.intakeLinkIncluded;/);
    expect(SMS_PASS).toMatch(/linkMayHaveGone = result\.possiblySent === true && result\.intakeLinkIncluded;/);
    expect(SMS_PASS).toMatch(
      /if \(linkMayHaveGone && smsIntake\) \{\s*await stampIntakeLinkIssued\(admin, smsIntake\.id, \{ emailed: false \}\);/,
    );
    expect(SMS_PASS.match(/stampIntakeLinkIssued\(/g) ?? []).toHaveLength(1);
  });

  it("an SMS never claims the link was EMAILED", () => {
    // intake_link_last_sent_at renders as "Intake link emailed ..." in the
    // practitioner UI, so only the email pass may set it.
    expect(SMS_PASS).toMatch(/\{ emailed: false \}/);
    expect(SMS_PASS).not.toMatch(/\{ emailed: true \}/);
    expect(PASS).toMatch(/\{ emailed: true \}/);
    expect(PASS).not.toMatch(/\{ emailed: false \}/);
  });

  it("counts the two channels separately", () => {
    expect(CODE).toMatch(/type SmsRunStats = RunStats & \{ intakeCtaIncluded: number \};/);
    expect(SMS_PASS).toMatch(/stats\.intakeCtaIncluded \+= 1;/);
  });
});

describe("SMS logging carries ids and kinds only", () => {
  it("never logs the intake token or URL", () => {
    expect(SMS_PASS).not.toMatch(/console\.[a-z]+\([^)]*(smsIntakeUrl|intakeUrl|token|responses)/);
    expect(SMS_PASS).not.toMatch(/smsIntakeUrl[\s\S]{0,60}console/);
  });
});
