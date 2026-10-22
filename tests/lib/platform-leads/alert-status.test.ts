import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  describeLeadAlert,
  isLeadAlertConfigCode,
  LEAD_ALERT_CONFIG_CODES,
  LEAD_ALERT_ERROR_CODES,
  LEAD_ALERT_MAX_ATTEMPTS,
  LEAD_ALERT_STATUSES,
  leadAlertReason,
  leadAnchorId,
} from "@/lib/platform-leads/alert-status";

// LEAD-ALERT-01 (#826): the console's words for each alert state, and the
// vocabulary they are built on, pinned to migration 0213 so the two cannot
// drift apart.

const SQL = readFileSync(
  path.join(process.cwd(), "supabase/migrations/0213_platform_lead_alerts.sql"),
  "utf8",
);

/** The quoted values inside one named table constraint of 0213. */
function constraintValues(name: string): string[] {
  const start = SQL.indexOf(`constraint ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const end = SQL.indexOf("constraint ", start + 1);
  return [...SQL.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe("the vocabulary is 0213's", () => {
  it("every status", () => {
    expect(constraintValues("platform_lead_alerts_status_ck").sort()).toEqual([...LEAD_ALERT_STATUSES].sort());
  });

  it("every error code", () => {
    expect(constraintValues("platform_lead_alerts_error_code_ck").sort()).toEqual([...LEAD_ALERT_ERROR_CODES].sort());
  });

  it("the configuration codes are exactly the ones the blocked command admits", () => {
    const start = SQL.indexOf("create or replace function public.record_platform_lead_alerts_unconfigured(");
    const body = SQL.slice(start, SQL.indexOf("$$;", start));
    const admitted = [...body.slice(body.indexOf("not in (")).matchAll(/'([a-z_]+)'/g)]
      .map((m) => m[1])
      .filter((c) => (LEAD_ALERT_ERROR_CODES as readonly string[]).includes(c));
    expect(admitted.sort()).toEqual([...LEAD_ALERT_CONFIG_CODES].sort());
  });

  it("the attempt ceiling", () => {
    expect(SQL).toMatch(new RegExp(`attempt_count between 0 and ${LEAD_ALERT_MAX_ATTEMPTS}\\b`));
  });

  it("every code has an operator-facing reason, and an unknown code has none", () => {
    for (const code of LEAD_ALERT_ERROR_CODES) expect(leadAlertReason(code), code).toMatch(/\.$/);
    expect(leadAlertReason("something_else")).toBeNull();
    expect(leadAlertReason(null)).toBeNull();
  });
});

describe("describeLeadAlert", () => {
  it("no alert: said plainly, never as sent", () => {
    expect(describeLeadAlert(null)).toMatchObject({ tone: "none", label: "No alert" });
  });

  it("accepted is ACCEPTED, with delivery explicitly unconfirmed", () => {
    const b = describeLeadAlert({ status: "accepted", attempt_count: 1, last_error_code: null });
    expect(b).toMatchObject({ tone: "ok", label: "Alert accepted" });
    expect(b.detail).toMatch(/not confirmed/);
    expect(JSON.stringify(b)).not.toMatch(/delivered/i);
  });

  it("missing configuration is a problem, never success", () => {
    for (const code of LEAD_ALERT_CONFIG_CODES) {
      expect(isLeadAlertConfigCode(code)).toBe(true);
      expect(describeLeadAlert({ status: "pending", attempt_count: 0, last_error_code: code })).toMatchObject({
        tone: "problem",
        label: "Alert not sent",
        detail: leadAlertReason(code),
      });
    }
  });

  it("waiting, retrying, sending and failed", () => {
    expect(describeLeadAlert({ status: "pending", attempt_count: 0, last_error_code: null })).toMatchObject({ tone: "waiting", label: "Alert waiting to send" });
    expect(describeLeadAlert({ status: "pending", attempt_count: 2, last_error_code: "provider_timeout" })).toMatchObject({
      tone: "waiting",
      label: "Retrying (2 of 5 attempts used)",
      detail: "The email provider did not answer in time.",
    });
    expect(describeLeadAlert({ status: "sending", attempt_count: 3, last_error_code: null })).toMatchObject({ label: "Sending (attempt 3 of 5)" });
    expect(describeLeadAlert({ status: "failed", attempt_count: 5, last_error_code: "expired" })).toMatchObject({
      tone: "problem",
      label: "Alert failed",
      detail: "It was not sent within its automatic retry window. Use Retry to send it under a new key.",
    });
  });
});

describe("leadAnchorId", () => {
  it("one anchor per lead kind, shared by the email link and the console row", () => {
    expect(leadAnchorId("demo_request", "abc")).toBe("lead-demo-request-abc");
    expect(leadAnchorId("early_access", "abc")).toBe("lead-early-access-abc");
  });
});
