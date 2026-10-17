import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #193. Pins the standalone critical-alert operator email module:
// the env-gated, cycle-free, never-throwing notification layer on
// top of the durable ops_alerts row.

// Behavioural canary (#828 G-24): the bare Resend client is replaced so the
// exact email the operator would receive can be inspected. Nothing is sent.
const sent: Array<{ to: string[]; subject: string; text: string }> = [];
vi.mock("@/lib/email/client", () => ({
  FROM_ADDRESS: "Hone <alerts@example.test>",
  resend: {
    emails: {
      send: async (msg: { to: string[]; subject: string; text: string }) => {
        sent.push(msg);
        return { data: { id: "fake" }, error: null };
      },
    },
  },
}));

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

describe("#828 G-24: the alert email carries no record identifiers", () => {
  // Synthetic values only.
  const STUDIO = "11111111-2222-4333-8444-555555555555";
  const APPT = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
  const CLIENT = "ABCDEF12-3456-4789-8ABC-DEF012345678";
  const EVT = "evt_1TestEventABCDEF";
  const PI = "pi_3TestPaymentIntent";
  const ROUTE = `/clients/${CLIENT}/sessions/${APPT}`;
  const FORBIDDEN = [STUDIO, APPT, CLIENT, EVT, PI, ROUTE, "Client id:", "Studio:", "Appointment:", "PaymentIntent:", "Route:"];

  beforeEach(() => {
    sent.length = 0;
    process.env.OPS_ALERT_EMAILS = "ops@example.test";
  });
  afterEach(() => {
    delete process.env.OPS_ALERT_EMAILS;
  });

  async function send(message: string) {
    const { notifyCriticalOpsAlert } = await import("@/lib/ops/alert-email");
    await notifyCriticalOpsAlert({
      event: "session_payment_succeeded_write_zero_rows",
      message,
      createdAtIso: "2026-10-17T03:00:00.000Z",
      studioId: STUDIO,
      appointmentId: APPT,
      clientId: CLIENT,
      stripeEventId: EVT,
      stripePaymentIntentId: PI,
      route: ROUTE,
    });
    expect(sent).toHaveLength(1);
    return sent[0]!;
  }

  it("renders no id lines, and scrubs ids embedded in the message", async () => {
    const mail = await send(`Payment ${PI} for appointment ${APPT} (evt ${EVT}) wrote zero rows at ${ROUTE}`);
    const whole = `${mail.subject}\n${mail.text}`.toLowerCase();
    for (const f of FORBIDDEN) expect(whole, `email still carries ${f}`).not.toContain(f.toLowerCase());
    expect(mail.text).toContain("Payment [stripe-id] for appointment [id] (evt [stripe-id]) wrote zero rows at /clients/[id]/sessions/[id]");
  });

  it("keeps what the operator needs to triage: event slug, time, environment and the admin link", async () => {
    const mail = await send("Benign message");
    expect(mail.subject).toBe("[Hone CRITICAL] session_payment_succeeded_write_zero_rows");
    expect(mail.text).toContain("CRITICAL ops alert: session_payment_succeeded_write_zero_rows");
    expect(mail.text).toContain("Created: 2026-10-17T03:00:00.000Z");
    expect(mail.text).toMatch(/Environment: \S+/);
    expect(mail.text).toContain("Review and resolve: https://hone.care/admin/ops-alerts");
    expect(mail.text).toContain("Record and payment details are on the alert itself, not in this email.");
  });
});
