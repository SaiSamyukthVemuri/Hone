import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

// HON-50: bridge the existing callback-payload and static-page tests. Real:
// signature validation, callback, alert writer/redactor and admin page renderer.
// Substituted: RPC answers/table storage and action/email transports. This is
// rendering proof, not DB deduplication, browser or live-delivery acceptance.
const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  result: "updated",
  resolvedReadError: false,
  rpc: vi.fn(),
  email: vi.fn(),
  action: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc: h.rpc,
    from(table: string) {
      if (table !== "ops_alerts") throw new Error(`Unexpected table: ${table}`);
      return {
        async insert(row: Record<string, unknown>) {
          h.rows.push({
            ...row,
            id: "33333333-3333-4333-8333-333333333333",
            created_at: "2026-10-20T00:00:00Z",
            resolved_at: null,
            resolution_note: null,
          });
          return { error: null };
        },
        select() {
          const selection = (resolved: boolean) => ({
            order: () => ({
              limit: async () => ({
                data: h.rows.filter((row) => (row.resolved_at !== null) === resolved),
                error: resolved && h.resolvedReadError ? { message: "synthetic history unavailable" } : null,
              }),
            }),
          });
          return {
            is: () => selection(false),
            not: () => selection(true),
          };
        },
      };
    },
  }),
}));
vi.mock("@/lib/ops/alert-email", () => ({ notifyCriticalOpsAlert: h.email }));
vi.mock("@/app/admin/ops-alerts/actions", () => ({
  resolveOpsAlertAction: h.action,
  sendTestCriticalAlertAction: h.action,
}));

import { POST } from "@/app/api/twilio/message-status/route";
import OpsAlertsPage from "@/app/admin/ops-alerts/page";

const BASE = "https://hone.example";
const TOKEN = "synthetic-callback-token";
const MESSAGE = "44444444-4444-4444-8444-444444444444";
const STUDIO = "11111111-1111-4111-8111-111111111111";
const APPOINTMENT = "22222222-2222-4222-8222-222222222222";
const SID = `SM${"a".repeat(32)}`;

function callback(status: "undelivered" | "failed", signingToken = TOKEN, errorCode = "30007") {
  const url = `${BASE}/api/twilio/message-status?m=${MESSAGE}`;
  const params = {
    MessageSid: SID,
    MessageStatus: status,
    ErrorCode: errorCode,
    To: "+12125550123",
    Body: "Synthetic private body must not reach the alert",
  };
  const signed = url + Object.keys(params).sort().map((key) => key + params[key as keyof typeof params]).join("");
  return POST(new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": createHmac("sha1", signingToken).update(signed).digest("base64"),
    },
    body: new URLSearchParams(params).toString(),
  }));
}

beforeEach(() => {
  h.rows = [];
  h.result = "updated";
  h.resolvedReadError = false;
  h.rpc.mockReset().mockImplementation(async (fn: string) => {
    if (fn !== "record_sms_delivery_status") throw new Error(`Unexpected RPC: ${fn}`);
    return {
      data: [{ result: h.result, studio_id: STUDIO, appointment_id: APPOINTMENT, purpose: "appointment_reminder_24h" }],
      error: null,
    };
  });
  for (const transport of [h.email, h.action, h.fetch]) {
    transport.mockReset().mockImplementation(() => { throw new Error("No transport or UI action allowed"); });
  }
  vi.stubGlobal("fetch", h.fetch);
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("TWILIO_WEBHOOK_BASE_URL", BASE);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("synthetic SMS delivery failures reach the operator's real page", () => {
  it.each(["undelivered", "failed"] as const)("%s is a visible warning with safe reminder context, without email", async (status) => {
    expect((await callback(status)).status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("record_sms_delivery_status", {
      p_message_id: MESSAGE,
      p_provider_message_sid: SID,
      p_status: status,
      p_provider_error_code: 30007,
    });
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({
      severity: "warning",
      event: "sms_delivery_failed",
      studio_id: STUDIO,
      appointment_id: APPOINTMENT,
      safe_details: {
        sms_message_id: MESSAGE,
        purpose: "appointment_reminder_24h",
        provider_status: status,
        provider_error_code: 30007,
      },
    });

    const html = renderToStaticMarkup(await OpsAlertsPage());
    expect(html).not.toContain("No unresolved alerts");
    for (const visible of ["sms_delivery_failed", "warning", "appointment_reminder_24h", status, "30007", STUDIO, APPOINTMENT, MESSAGE]) {
      expect(html).toContain(visible);
    }
    expect(html).toContain("Details (redacted at write time)");
    for (const privateValue of ["+12125550123", "Synthetic private body", TOKEN, SID]) {
      expect(html).not.toContain(privateValue);
    }
    expect(h.email).not.toHaveBeenCalled();
    expect(h.action).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each(["private-provider-error-sentinel", "123456789"])("malformed provider error %s cannot leak into the alert page", async (errorCode) => {
    expect((await callback("failed", TOKEN, errorCode)).status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("record_sms_delivery_status", expect.objectContaining({
      p_provider_error_code: null,
    }));
    expect(h.rows).toHaveLength(1);
    expect(JSON.stringify(h.rows)).not.toContain(errorCode);
    const html = renderToStaticMarkup(await OpsAlertsPage());
    expect(html).toContain("sms_delivery_failed");
    expect(html).not.toContain(errorCode);
    expect(html).not.toContain("Synthetic private body");
    expect(h.email).not.toHaveBeenCalled();
    expect(h.action).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("an invalid callback signature cannot create a visible delivery warning", async () => {
    expect((await callback("failed", "wrong-synthetic-token")).status).toBe(403);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.rows).toEqual([]);
    const html = renderToStaticMarkup(await OpsAlertsPage());
    expect(html).toContain("No unresolved alerts");
    expect(html).not.toContain("sms_delivery_failed");
    expect(h.email).not.toHaveBeenCalled();
    expect(h.action).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("unavailable resolved history is not presented as empty while unresolved delivery warnings remain visible", async () => {
    expect((await callback("failed")).status).toBe(200);
    h.resolvedReadError = true;
    const html = renderToStaticMarkup(await OpsAlertsPage());
    expect(html).toContain("sms_delivery_failed");
    expect(html).toContain("Recently resolved alerts are unavailable. Try again.");
    expect(html).not.toContain("Nothing resolved yet.");
    expect(html).not.toContain("last 0");
    expect(html).not.toContain("synthetic history unavailable");
    expect(h.email).not.toHaveBeenCalled();
    expect(h.action).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("a capped unresolved delivery-alert view discloses its slice without claiming more alerts exist", async () => {
    expect((await callback("failed")).status).toBe(200);
    const row = h.rows[0];
    h.rows = Array.from({ length: 200 }, (_, i) => ({ ...row, id: `synthetic-alert-${i}` }));
    const notice = "Showing the 200 newest unresolved alerts. Older alerts, if any, are not shown.";
    expect(renderToStaticMarkup(await OpsAlertsPage())).toContain(notice);
    h.rows = [row];
    expect(renderToStaticMarkup(await OpsAlertsPage())).not.toContain(notice);
    expect(h.email).not.toHaveBeenCalled();
    expect(h.action).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("a stale repeat does not add a second visible warning", async () => {
    expect((await callback("undelivered")).status).toBe(200);
    h.result = "stale"; // The DB result is supplied, not a DB deduplication proof.
    expect((await callback("undelivered")).status).toBe(200);
    expect(h.rows).toHaveLength(1);
    const html = renderToStaticMarkup(await OpsAlertsPage());
    expect(html.match(/sms_delivery_failed/g)).toHaveLength(1);
    expect(h.email).not.toHaveBeenCalled();
    expect(h.action).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
