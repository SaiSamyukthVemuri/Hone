import { describe, expect, it } from "vitest";
import {
  LEAD_ALERT_RECIPIENTS_ENV,
  MAX_LEAD_ALERT_RECIPIENTS,
  maskRecipient,
  resolveLeadAlertRecipients,
} from "@/lib/platform-leads/alert-config";

// The recipients are fake addresses on a reserved test domain. The real list is server config, set at release, never in the repo.
const A = "one@hone.example";
const B = "two@hone.example";
const C = "three@hone.example";
const env = (o: Record<string, string | undefined>) => o;
const BAD = { ok: false, code: "recipient_not_allowlisted" } as const;

describe("resolveLeadAlertRecipients", () => {
  it("reads one variable, LEAD_ALERT_RECIPIENTS; the old single-address variable is retired", () => {
    expect(LEAD_ALERT_RECIPIENTS_ENV).toBe("LEAD_ALERT_RECIPIENTS");
    expect(resolveLeadAlertRecipients(env({ LEAD_ALERT_EMAIL: A }))).toEqual({ ok: false, code: "recipient_not_configured" });
  });

  it("three comma-separated addresses: trimmed, lower-cased, in the configured order", () => {
    expect(resolveLeadAlertRecipients(env({ LEAD_ALERT_RECIPIENTS: ` ${A.toUpperCase()} ,${B},  ${C}` }))).toEqual({
      ok: true,
      recipients: [A, B, C],
    });
  });

  it("a duplicate is sent once (case-insensitive)", () => {
    expect(resolveLeadAlertRecipients(env({ LEAD_ALERT_RECIPIENTS: `${A},${B},${A.toUpperCase()}` }))).toEqual({ ok: true, recipients: [A, B] });
  });

  it("no default: unset, empty and blank are 'not configured'", () => {
    for (const v of [undefined, "", "   "]) {
      expect(resolveLeadAlertRecipients(env({ LEAD_ALERT_RECIPIENTS: v }))).toEqual({ ok: false, code: "recipient_not_configured" });
    }
  });

  it("an invalid entry refuses the WHOLE list at config, never a partial reading", () => {
    const entries = [
      "not an address",
      "no-at-sign",
      "Name <a@hone.example>",
      "a@hone.example;b@hone.example",
      "a@hone.example\nBcc: x@hone.example",
      "a@@hone.example",
      "a@hone",
      "a b@hone.example",
      `${"x".repeat(250)}@hone.example`,
    ];
    for (const bad of entries) {
      expect(resolveLeadAlertRecipients(env({ LEAD_ALERT_RECIPIENTS: `${A},${bad},${B}` })), bad).toEqual(BAD);
      expect(resolveLeadAlertRecipients(env({ LEAD_ALERT_RECIPIENTS: bad })), bad).toEqual(BAD);
    }
  });

  it("a stray or doubled comma is a malformed list, not a skipped entry", () => {
    for (const v of [`${A},`, `,${A}`, `${A},,${B}`]) expect(resolveLeadAlertRecipients(env({ LEAD_ALERT_RECIPIENTS: v })), v).toEqual(BAD);
  });

  it("is capped: the limit is allowed, one over is refused", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `r${i}@hone.example`).join(",");
    expect(MAX_LEAD_ALERT_RECIPIENTS).toBe(5);
    expect(resolveLeadAlertRecipients(env({ LEAD_ALERT_RECIPIENTS: list(5) }))).toMatchObject({ ok: true });
    expect(resolveLeadAlertRecipients(env({ LEAD_ALERT_RECIPIENTS: list(6) }))).toEqual(BAD);
  });

  it("is NOT tied to the admin allowlist: a recipient who is not an admin is accepted, and being a recipient grants nothing", () => {
    expect(resolveLeadAlertRecipients(env({ LEAD_ALERT_RECIPIENTS: A, ADMIN_EMAILS: "someone-else@hone.example" }))).toEqual({ ok: true, recipients: [A] });
    expect(resolveLeadAlertRecipients(env({ LEAD_ALERT_RECIPIENTS: A }))).toEqual({ ok: true, recipients: [A] });
  });

  it("this module never reads the admin allowlist at all (source guard)", async () => {
    const { readFileSync } = await import("node:fs");
    const code = readFileSync("lib/platform-leads/alert-config.ts", "utf8")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(code).not.toMatch(/ADMIN_EMAILS|parseAdminEmails|@\/lib\/admin|isAdmin/);
  });
});

describe("maskRecipient", () => {
  it("keeps enough to recognise an inbox, not to copy it", () => {
    const masked = maskRecipient("someone.long@example.com");
    expect(masked).toBe("s•••@e•••.com");
    expect(masked).not.toContain("someone");
  });
});
