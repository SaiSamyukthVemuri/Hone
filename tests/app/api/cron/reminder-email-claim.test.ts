import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #189. The email reminder pass previously did select -> send ->
// record with no reservation between the select and the send, so two
// overlapping cron runs could both email the same appointment. These
// tests pin the claimed shape of the cron route: claim BEFORE send,
// skip on a lost claim, record via record_email_result (which clears
// the claim and does not double-increment attempts).

const ROUTE = readFileSync(
  path.resolve(
    __dirname,
    "../../../../app/api/cron/appointment-reminders/route.ts",
  ),
  "utf8",
);

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const CODE = codeOnly(ROUTE);

// The appointment email pass is sendReminderPass only; scope assertions there
// so the SMS pass (which has its own claim_sms_send slot) cannot satisfy them.
// Since 0186 the separate intake-reminder pass is gone - the intake nudge is
// composed INTO this pass under this pass's single claim - so the slice now
// ends at the SMS pass. The lookup is kept tolerant of either name so the
// slice can never silently become the whole file.
const EMAIL_PASS_END = Math.min(
  ...[
    CODE.indexOf("async function sendIntakeReminderPass"),
    CODE.indexOf("async function sendSmsReminderPass"),
  ].filter((i) => i > -1),
);
const EMAIL_PASS = CODE.slice(
  CODE.indexOf("async function sendReminderPass"),
  EMAIL_PASS_END,
);

describe("email reminder pass: claim before send", () => {
  it("imports claimEmailSend + recordEmailResult from the email module", () => {
    expect(ROUTE).toMatch(/claimEmailSend,/);
    expect(ROUTE).toMatch(/recordEmailResult,/);
    expect(ROUTE).toMatch(/from "@\/lib\/email\/send-appointment"/);
  });

  it("every send is claimed first: claim call precedes the send dispatch", () => {
    const claimIdx = EMAIL_PASS.indexOf(
      "await claimEmailSend(admin, appt.id, emailType)",
    );
    const sendIdx = EMAIL_PASS.indexOf("result = await sendFn(");
    expect(claimIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(claimIdx);
  });

  it("a lost claim skips the row without sending", () => {
    expect(EMAIL_PASS).toMatch(
      /if \(!claimed\) \{\s*\n?\s*stats\.skipped \+= 1;\s*\n?\s*continue;\s*\n?\s*\}/,
    );
  });

  it("the claim also precedes the missing-token failure record", () => {
    const claimIdx = EMAIL_PASS.indexOf("await claimEmailSend(");
    const tokenIdx = EMAIL_PASS.indexOf("if (!token) {");
    expect(tokenIdx).toBeGreaterThan(claimIdx);
  });

  it("outcomes are recorded via record_email_result, never record_email_attempt", () => {
    // recordEmailAttempt increments attempts; the claim already did.
    // Using it after a claim would double-count, so the claimed pass
    // must not reference it at all.
    expect(EMAIL_PASS).toMatch(
      /await recordEmailResult\(admin, appt\.id, emailType, false\);/,
    );
    expect(EMAIL_PASS).toMatch(
      /await recordEmailResult\(admin, appt\.id, emailType, result\.ok\);/,
    );
    expect(EMAIL_PASS).not.toMatch(/recordEmailAttempt/);
    expect(CODE).not.toMatch(/recordEmailAttempt/);
  });

  it("duplicate cron passes cannot double-send: no send path bypasses the claim", () => {
    // Exactly one sendFn dispatch exists in the email pass and exactly
    // one claim call guards it (asserted in order above). If a second
    // unclaimed dispatch is ever added, this count catches it.
    const sends = EMAIL_PASS.match(/await sendFn\(/g) ?? [];
    expect(sends.length).toBe(1);
    const claims = EMAIL_PASS.match(/await claimEmailSend\(/g) ?? [];
    expect(claims.length).toBe(1);
  });
});

describe("email reminder pass: preserved behavior", () => {
  it("the selection query is unchanged (sent-is-null + attempts cap + window)", () => {
    expect(CODE).toMatch(/\.is\(opts\.notSentColumn, null\)/);
    expect(CODE).toMatch(/\.lt\(opts\.attemptsColumn, MAX_ATTEMPTS\)/);
  });

  it("attempt numbering for failure logs is unchanged", () => {
    expect(EMAIL_PASS).toMatch(
      /const attemptNumber = \(appt\[attemptsColumn\] as number\) \+ 1;/,
    );
  });

  it("the cheap row guards are all evaluated before any claim", () => {
    // Since 0186 the studio reminder toggle is no longer a SKIP - it is an
    // input to which email gets composed, because a studio with the reminder
    // off may still owe a standalone intake reminder. What must not regress is
    // that nothing claims a slot before the cheap in-memory guards have run:
    // a claim costs an attempt off the 3-strike cap.
    const toggleIdx = EMAIL_PASS.indexOf("[studioToggle]");
    const emailIdx = EMAIL_PASS.indexOf("if (!appt.client?.email) continue;");
    const claimIdx = EMAIL_PASS.indexOf("await claimEmailSend(");
    expect(toggleIdx).toBeGreaterThan(-1);
    expect(emailIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(toggleIdx);
    expect(claimIdx).toBeGreaterThan(emailIdx);
    // A row that can produce no email at all never reaches the claim.
    expect(EMAIL_PASS).toMatch(
      /if \(!wantsReminder && !intakeEnabled\) continue;/,
    );
  });

  it("the SMS pass still uses its own claim (claim_sms_send path untouched)", () => {
    const smsPass = CODE.slice(CODE.indexOf("async function sendSmsReminderPass"));
    expect(smsPass).toMatch(/send24hReminderSmsToClient/);
    expect(ROUTE).not.toMatch(/claim_sms_send"/);
  });

  it("response keys reminder_24h / reminder_2h are unchanged", () => {
    expect(CODE).toMatch(/reminder_24h,\s*\n?\s*reminder_2h,/);
  });
});

describe("PR #189 boundaries (cron route)", () => {
  it("no payment / Stripe code", () => {
    expect(CODE).not.toMatch(
      /paymentIntents|refunds\.create|charges\.create|checkout\.sessions|STRIPE_ALLOW_LIVE_MODE/,
    );
  });

  it("cron auth gate unchanged", () => {
    expect(CODE).toMatch(/if \(!isAuthorizedCronRequest\(req\)\)/);
  });
});
