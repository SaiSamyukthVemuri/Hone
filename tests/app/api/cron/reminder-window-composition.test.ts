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

// ---------------------------------------------------------------------------
// ONE CLAIM OWNS THE WINDOW
// ---------------------------------------------------------------------------
describe("at most one email per appointment per window", () => {
  it("claims the single reminder_24h / reminder_2h slot, whatever it composes", () => {
    expect(PASS).toMatch(
      /const emailType: ClaimableEmailType =\s*\n?\s*opts\.kind === "24h" \? "reminder_24h" : "reminder_2h";/,
    );
    expect(PASS).toMatch(/const claimed = await claimEmailSend\(admin, appt\.id, emailType\)/);
    expect(PASS).toMatch(/if \(!claimed\)/);
  });

  it("has exactly ONE claim call and ONE success-recording call site", () => {
    expect(PASS.match(/claimEmailSend\(/g) ?? []).toHaveLength(1);
    expect(
      PASS.match(/recordEmailResult\(admin, appt\.id, emailType, result\.ok\)/g) ?? [],
    ).toHaveLength(1);
  });

  it("has exactly ONE provider send per iteration: reminder OR standalone, never both", () => {
    // Two mutually exclusive branches assigning the same `result`.
    expect(PASS).toMatch(/let result: EmailSendResult;/);
    expect(PASS).toMatch(/if \(wantsReminder\) \{/);
    expect(PASS).toMatch(/result = await sendFn\(\{/);
    expect(PASS).toMatch(/result = await sendIntakeReminderToClient\(\{/);
    expect(PASS.match(/result = await /g) ?? []).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The six cases
// ---------------------------------------------------------------------------
describe("the six-case law", () => {
  it("reads the two settings independently", () => {
    expect(PASS).toMatch(
      /const wantsReminder =\s*\n?\s*\(appt\.studio as unknown as Record<string, boolean>\)\[studioToggle\] === true;/,
    );
    // Absent column (pre-0186 row) must read as ENABLED: the column defaults true.
    expect(PASS).toMatch(
      /const intakeEnabled = appt\.studio\.send_intake_reminders !== false;/,
    );
  });

  it("CASE 6 (both off) short-circuits before any intake read or claim", () => {
    expect(PASS).toMatch(/if \(!wantsReminder && !intakeEnabled\) continue;/);
    const case6 = PASS.indexOf("if (!wantsReminder && !intakeEnabled) continue;");
    expect(case6).toBeGreaterThan(-1);
    expect(case6).toBeLessThan(PASS.indexOf("claimEmailSend("));
    expect(case6).toBeLessThan(PASS.indexOf("readLatestIntake("));
  });

  it("CASE 5 (reminder off, intake complete) never claims and never bumps an attempt", () => {
    // The pre-claim probe exists ONLY in the !wantsReminder branch.
    expect(PASS).toMatch(/if \(!wantsReminder\) \{[\s\S]*?const probe = await readLatestIntake\(/);
    expect(PASS).toMatch(/if \(probe\?\.status !== "in_progress"\) \{[\s\S]*?stats\.skipped \+= 1;[\s\S]*?continue;/);
    const probeAt = PASS.indexOf("const probe = await readLatestIntake(");
    expect(probeAt).toBeGreaterThan(-1);
    expect(probeAt).toBeLessThan(PASS.indexOf("claimEmailSend("));
  });

  it("CASE 3 (intake off) never reads intake at all", () => {
    expect(PASS).toMatch(
      /const intake = intakeEnabled\s*\n?\s*\? await readLatestIntake\(admin, appt\.studio\.id, appt\.client_id\)\s*\n?\s*: null;/,
    );
  });

  it("CASE 4 sends the standalone intake reminder for this window's kind", () => {
    expect(PASS).toMatch(/sendIntakeReminderToClient\(\{\s*\n?\s*kind: opts\.kind,/);
  });

  it("a CASE 4 -> 5 flip after the claim sends nothing and clears the claim", () => {
    expect(PASS).toMatch(
      /if \(!wantsReminder && !intakeIncomplete\) \{[\s\S]*?await recordEmailResult\(admin, appt\.id, emailType, false\);[\s\S]*?stats\.skipped \+= 1;[\s\S]*?continue;/,
    );
  });
});

// ---------------------------------------------------------------------------
// LIVE state at the send decision
// ---------------------------------------------------------------------------
describe("nothing is inferred from an earlier cron query", () => {
  it("re-reads appointment status after the claim and before the decision", () => {
    expect(PASS).toMatch(/\.from\("appointments"\)\s*\n?\s*\.select\("status"\)/);
    expect(PASS).toMatch(/if \(!fresh \|\| fresh\.status !== "confirmed"\)/);
    expect(PASS.indexOf("claimEmailSend(")).toBeLessThan(
      PASS.indexOf('.select("status")'),
    );
  });

  it("re-reads intake LIVE after the status re-check, as a SECOND query", () => {
    // Two distinct readLatestIntake call sites: the pre-claim probe (cases
    // 4/5 only) and the live read. Reusing the probe would be inference.
    expect(PASS.match(/readLatestIntake\(/g) ?? []).toHaveLength(2);
    const statusAt = PASS.indexOf('.select("status")');
    const liveAt = PASS.indexOf("const intake = intakeEnabled");
    expect(statusAt).toBeGreaterThan(-1);
    expect(liveAt).toBeGreaterThan(statusAt);
  });

  it("decides the CTA from the LIVE read, and sends after deciding", () => {
    expect(PASS).toMatch(/const intakeIncomplete = intake\?\.status === "in_progress";/);
    const liveAt = PASS.indexOf("const intakeIncomplete =");
    expect(liveAt).toBeGreaterThan(-1);
    expect(liveAt).toBeLessThan(PASS.indexOf("result = await "));
  });

  it("resolves the intake studio + client scoped, reading id and status only", () => {
    expect(CODE).toMatch(/\.from\("client_intake_forms"\)\s*\n?\s*\.select\("id, status"\)/);
    expect(CODE).toMatch(/\.eq\("studio_id", studioId\)/);
    expect(CODE).toMatch(/\.eq\("client_id", clientId\)/);
    expect(CODE).toMatch(/\.is\("deleted_at", null\)/);
  });

  it("an intake read failure degrades to no-CTA instead of throwing", () => {
    // Destructures `data` only: an error yields null, never a throw, so the
    // appointment reminder still goes out.
    expect(CODE).toMatch(
      /async function readLatestIntake\([\s\S]*?const \{ data \} = await admin[\s\S]*?return \(data as \{ id: string; status: string \} \| null\) \?\? null;/,
    );
    expect(CODE).not.toMatch(/readLatestIntake[\s\S]{0,400}throw new Error/);
  });
});

// ---------------------------------------------------------------------------
// Secure link + link accounting
// ---------------------------------------------------------------------------
describe("intake link minting and stamping", () => {
  it("mints a FRESH link only when the live read says incomplete", () => {
    expect(PASS).toMatch(
      /const intakeUrl =\s*\n?\s*intakeIncomplete && intake\s*\n?\s*\? generateIntakeLinkUrl\(intake\.id, appOrigin\)\s*\n?\s*: null;/,
    );
  });

  it("stamps intake-link metadata ONLY on a successful send that carried a link", () => {
    expect(PASS).toMatch(
      /if \(result\.ok\) \{[\s\S]*?if \(intakeUrl && intake\) \{[\s\S]*?await stampIntakeLinkIssued\(admin, intake\.id, \{ emailed: true \}\)/,
    );
    expect(PASS.match(/stampIntakeLinkIssued\(/g) ?? []).toHaveLength(1);
  });

  it("a plain appointment reminder cannot stamp intake-link use", () => {
    // The only stamp is inside the `intakeUrl && intake` guard, which is null
    // for cases 2 and 3.
    const stampAt = PASS.indexOf("stampIntakeLinkIssued(");
    const guardAt = PASS.indexOf("if (intakeUrl && intake) {");
    expect(guardAt).toBeGreaterThan(-1);
    expect(stampAt).toBeGreaterThan(guardAt);
  });
});

// ---------------------------------------------------------------------------
// Retry / exhaustion semantics
// ---------------------------------------------------------------------------
describe("retry and exhaustion semantics are preserved", () => {
  it("keeps the 3-strike cap on the window query", () => {
    expect(ROUTE).toMatch(/const MAX_ATTEMPTS = 3;/);
    expect(CODE).toMatch(/\.lt\(opts\.attemptsColumn, MAX_ATTEMPTS\)/);
  });

  it("records the provider outcome and alerts on exhaustion", () => {
    expect(PASS).toMatch(/await recordEmailResult\(admin, appt\.id, emailType, result\.ok\)/);
    expect(PASS).toMatch(/await alertIfReminderExhausted\(\{/);
  });

  it("the exhaustion alert says whether the lost email carried an intake CTA", () => {
    expect(CODE).toMatch(/intake_cta_included: opts\.intakeCtaIncluded,/);
    expect(PASS).toMatch(/intakeCtaIncluded: intakeUrl !== null,/);
  });
});

// ---------------------------------------------------------------------------
// Windows: reused, not reinvented
// ---------------------------------------------------------------------------
describe("windows come from the shared, already-proven module", () => {
  it("the route computes only the 24h and 2h reminder windows", () => {
    expect(CODE).toMatch(/reminderWindowIso\("24h", now\)/);
    expect(CODE).toMatch(/reminderWindowIso\("2h", now\)/);
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
      "if (!appt.client.phone) continue;",
      "if (!appt.client.sms_consent_at) continue;",
      "if (appt.client.sms_opted_out_at) continue;",
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
  it("the SMS pass stamps only on a successful SMS that carried the link", () => {
    expect(SMS_PASS).toMatch(
      /if \(result\.ok\) \{[\s\S]*?if \(smsIntakeUrl && smsIntake\) \{[\s\S]*?await stampIntakeLinkIssued\(admin, smsIntake\.id, \{ emailed: false \}\)/,
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
