import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #193. Pins the standalone critical-alert operator email module:
// the env-gated, cycle-free, never-throwing notification layer on
// top of the durable ops_alerts row.

const SOURCE = readFileSync(
  path.resolve(__dirname, "../../../lib/ops/alert-email.ts"),
  "utf8",
);

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const CODE = codeOnly(SOURCE);

describe("dependency-cycle posture", () => {
  it("imports only the bare Resend client, never the appointment email subsystem", () => {
    expect(SOURCE).toMatch(
      /import \{ resend, FROM_ADDRESS \} from "@\/lib\/email\/client"/,
    );
    expect(SOURCE).not.toMatch(/from "@\/lib\/email\/send-appointment"/);
    expect(CODE).not.toMatch(/sendEmailSafely/);
  });

  it("never calls recordOpsAlert (no alert recursion)", () => {
    expect(CODE).not.toMatch(/recordOpsAlert/);
    expect(SOURCE).not.toMatch(/from "@\/lib\/ops\/alerts"/);
  });

  it("is server-only", () => {
    expect(SOURCE).toMatch(/^import "server-only";/);
  });
});

describe("env gating and failure behavior", () => {
  it("reads OPS_ALERT_EMAILS and disables cleanly when unset (one-time warning)", () => {
    expect(CODE).toMatch(/process\.env\.OPS_ALERT_EMAILS/);
    expect(CODE).toMatch(/ops_alert_email_disabled_env_missing/);
    expect(CODE).toMatch(/missingEnvWarned = true;/);
    expect(CODE).toMatch(/return;/);
  });

  it("disables cleanly when the Resend key is missing", () => {
    expect(CODE).toMatch(/ops_alert_email_disabled_no_resend_key/);
  });

  it("never throws: the whole body is wrapped and failures only log", () => {
    expect(CODE).toMatch(/ops_alert_email_send_failed/);
    expect(CODE).toMatch(/ops_alert_email_threw/);
    expect(CODE).not.toMatch(/throw /);
  });
});

describe("email content safety", () => {
  it("sends only safe ids and the already-sanitized message", () => {
    // The input type carries ids + message only: no safe_details
    // blob, no card fields, no tokens.
    expect(SOURCE).toMatch(/event: string;\s*\n\s*message: string;/);
    expect(CODE).not.toMatch(/safe_details|safeDetails/);
    expect(CODE).not.toMatch(/card|cvc|pan/i);
  });

  it("includes the admin dashboard link and environment", () => {
    expect(CODE).toMatch(/https:\/\/hone\.care\/admin\/ops-alerts/);
    expect(CODE).toMatch(/environmentLabel\(\)/);
  });

  it("subject marks the alert CRITICAL", () => {
    expect(CODE).toMatch(/\[Hone CRITICAL\]/);
  });
});

describe("severity gating (in alerts.ts)", () => {
  const ALERTS = readFileSync(
    path.resolve(__dirname, "../../../lib/ops/alerts.ts"),
    "utf8",
  );

  it("only critical severity dispatches; warning/info never email", () => {
    const dispatchBlock = ALERTS.slice(
      ALERTS.indexOf('if (input.severity === "critical")'),
    );
    expect(dispatchBlock).toMatch(/notifyCriticalOpsAlert\(/);
    // Exactly one dispatch call site, inside the critical branch.
    const calls = ALERTS.match(/notifyCriticalOpsAlert\(/g) ?? [];
    expect(calls.length).toBe(1);
  });

  it("dispatch is wrapped so even a thrown email error cannot break the caller", () => {
    expect(ALERTS).toMatch(/ops_alert_email_dispatch_threw/);
  });
});
