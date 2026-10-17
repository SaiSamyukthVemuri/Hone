import { describe, expect, it } from "vitest";
import {
  LEAD_ALERT_RECIPIENT_ENV,
  maskRecipient,
  resolveLeadAlertRecipient,
} from "@/lib/platform-leads/alert-config";

// LEAD-ALERT-01 (#826): the operator alert goes to ONE server-configured
// address that is also on the admin allowlist, and to nothing else.

const OPS = "ops@hone.example";
const env = (o: Record<string, string | undefined>) => o;

describe("resolveLeadAlertRecipient", () => {
  it("reads one variable, LEAD_ALERT_EMAIL", () => {
    expect(LEAD_ALERT_RECIPIENT_ENV).toBe("LEAD_ALERT_EMAIL");
  });

  it("an allowlisted address is the recipient, normalized", () => {
    expect(
      resolveLeadAlertRecipient(env({ LEAD_ALERT_EMAIL: "  Ops@Hone.Example ", ADMIN_EMAILS: `someone@x.example, ${OPS}` })),
    ).toEqual({ ok: true, recipient: OPS });
  });

  it("nothing configured is BLOCKED, never a fallback", () => {
    for (const value of [undefined, "", "   "]) {
      expect(resolveLeadAlertRecipient(env({ LEAD_ALERT_EMAIL: value, ADMIN_EMAILS: OPS }))).toEqual({
        ok: false,
        code: "recipient_not_configured",
      });
    }
  });

  it("an address outside ADMIN_EMAILS is refused", () => {
    expect(resolveLeadAlertRecipient(env({ LEAD_ALERT_EMAIL: OPS, ADMIN_EMAILS: "other@hone.example" }))).toEqual({
      ok: false,
      code: "recipient_not_allowlisted",
    });
  });

  it("the allowlist is the env alone: lib/admin's non-production fallback never admits a recipient", () => {
    // NODE_ENV is 'test' here, where lib/admin.ts would fall back to its
    // built-in admin list for /admin access. The alert must not.
    expect(resolveLeadAlertRecipient(env({ LEAD_ALERT_EMAIL: OPS }))).toEqual({
      ok: false,
      code: "recipient_not_allowlisted",
    });
    expect(resolveLeadAlertRecipient(env({ LEAD_ALERT_EMAIL: OPS, ADMIN_EMAILS: "" }))).toEqual({
      ok: false,
      code: "recipient_not_allowlisted",
    });
  });

  it("anything but ONE plain address is refused, even when each part is allowlisted", () => {
    const LF = String.fromCharCode(10);
    const CRLF = String.fromCharCode(13, 10);
    const attacker = "attacker@evil.example";
    const allow = `${OPS},${attacker}`;
    for (const configured of [
      `${OPS},${attacker}`,
      `${OPS}; ${attacker}`,
      `${OPS} ${attacker}`,
      `${OPS}${LF}Bcc: ${attacker}`,
      `${OPS}${CRLF}Cc: ${attacker}`,
      `Ops <${OPS}>`,
      `<${OPS}>`,
      "ops@",
      "@hone.example",
      "ops@hone",
      `${"a".repeat(250)}@hone.example`,
    ]) {
      expect(resolveLeadAlertRecipient(env({ LEAD_ALERT_EMAIL: configured, ADMIN_EMAILS: allow })), configured).toEqual({
        ok: false,
        code: "recipient_not_allowlisted",
      });
    }
  });
});

describe("maskRecipient", () => {
  it("shows enough to recognise the inbox, not to copy it", () => {
    const masked = maskRecipient("someone.long@example.com");
    expect(masked).toBe("s•••@e•••.com");
    expect(masked).not.toContain("someone");
    expect(masked).not.toContain("example");
  });
});
