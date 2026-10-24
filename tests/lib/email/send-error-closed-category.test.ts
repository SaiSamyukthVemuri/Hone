import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureConsole, expectMinimumNecessary } from "../sms/helpers/log-capture";

// ===========================================================================
// MSG-LOG-RAW-ERROR: an email send failure is a closed category.
//
// sendEmailSafely used to return free text as `error`: "Invalid recipient:
// <to>" for an address without "@" (so a phone number typed into the email
// field), the provider's own message, or a thrown transport message. Callers
// log that string (portal message and reply, portal login, intake reissue) and
// store it (portal notification_email_error, the receipt failure row, ops-alert
// details), and safeLog strips record ids only. Every case below plants a
// synthetic phone and email in the provider's answer and proves neither
// reaches the returned error nor any log line, including the line a caller
// writes from it.
// ===========================================================================

const PHONE = "+1 555 010 0199";
const EMAIL = "leak.probe@example.test";
const HOSTILE = `Invalid \`to\` field: ${EMAIL} / ${PHONE} https://provider.example.test/r/${EMAIL}`;

type SendReply = { data: { id?: string } | null; error: { statusCode?: number; name?: string; message?: string } | null } | undefined;
const transport = vi.hoisted(() => ({ send: (async () => undefined) as (payload: unknown) => Promise<unknown> }));

vi.mock("@/lib/email/client", () => ({
  FROM_ADDRESS: "Hone <noreply@hone.test>",
  getResendTransport: () => ({ emails: { send: (payload: unknown) => transport.send(payload) } }),
}));

import * as sendModule from "@/lib/email/send-appointment";
import { logEmailFailure, sendEmailSafely } from "@/lib/email/send-appointment";

const BASE = { subject: "s", html: "<p>h</p>", text: "t" };

function reply(r: SendReply) {
  transport.send = async () => r;
}

// What the returned failure must never carry, however it is serialised.
function expectClean(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(EMAIL);
  expect(text).not.toContain("leak.probe");
  expect(text.replace(/\D/g, "")).not.toContain("5550100199");
  expect(text).not.toMatch(/https?:\/\//);
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const CASES: ReadonlyArray<readonly [string, () => void, string, boolean, string]> = [
  ["a provider refusal (422 validation_error) quoting the recipient", () => reply({ data: null, error: { statusCode: 422, name: "validation_error", message: HOSTILE } }), "provider_rejected", false, EMAIL],
  ["a provider outage (503) quoting the recipient", () => reply({ data: null, error: { statusCode: 503, name: "internal_server_error", message: HOSTILE } }), "provider_unavailable", true, EMAIL],
  ["rate limiting (429) quoting the recipient", () => reply({ data: null, error: { statusCode: 429, name: "rate_limit_exceeded", message: HOSTILE } }), "provider_unavailable", true, EMAIL],
  ["an unfamiliar error envelope whose only text is the recipient", () => reply({ data: null, error: { name: HOSTILE, message: HOSTILE } }), "unknown", true, EMAIL],
  ["a thrown transport error quoting the request", () => { transport.send = async () => { throw new Error(`connect ECONNRESET while sending to ${EMAIL} ${PHONE}`); }; }, "unknown", true, EMAIL],
  ["an empty provider reply", () => reply(undefined), "unknown", true, EMAIL],
  ["a phone number typed into the email field (no '@')", () => reply({ data: { id: "never" }, error: null }), "invalid_recipient", false, PHONE],
];

describe("MSG-LOG-RAW-ERROR: sendEmailSafely never returns the destination or the provider's text", () => {
  it.each(CASES)("%s", async (_name, arrange, category, retryable, to) => {
    arrange();
    const result = await sendEmailSafely({ ...BASE, to });
    expect(result).toEqual({ ok: false, error: category, retryable });
    expectClean(result);
  });

  it("every category is in the closed set", async () => {
    const closed: readonly string[] = sendModule.EMAIL_SEND_FAILURES;
    expect([...closed].sort()).toEqual(
      ["invalid_recipient", "no_recipient", "not_configured", "provider_rejected", "provider_unavailable", "timeout", "unknown"],
    );
    for (const [, arrange, category] of CASES) {
      arrange();
      expect(closed).toContain(category);
    }
  });

  it("an empty recipient is no_recipient, without calling the provider", async () => {
    const send = vi.fn(async () => ({ data: { id: "x" }, error: null }));
    transport.send = send;
    expect(await sendEmailSafely({ ...BASE, to: "" })).toEqual({ ok: false, error: "no_recipient", retryable: false });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("MSG-LOG-RAW-ERROR: no log line carries them, including the caller's", () => {
  it.each(CASES)("%s", async (_name, arrange, _category, _retryable, to) => {
    vi.restoreAllMocks();
    const log = captureConsole();
    arrange();
    const result = await sendEmailSafely({ ...BASE, to });
    if (result.ok) throw new Error("expected a failure");
    // The lib/email diagnostic, and the shape the portal, portal-login and
    // intake-reissue call sites write from the result.
    logEmailFailure({ appointmentId: "appointment-ref", emailType: "confirmation", error: result.error, retryable: result.retryable, attemptNumber: 1 });
    console.error(JSON.stringify({ event: "caller_email_send_failed", retryable: result.retryable, error: result.error }));
    const text = log.text();
    expect(text).toContain("caller_email_send_failed");
    expectMinimumNecessary(text, { phones: [PHONE], secrets: [EMAIL] });
    expect(text).not.toContain("leak.probe");
  });
});
