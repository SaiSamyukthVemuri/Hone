import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// STACKED BOUNDARY (#831 over #832): one owner per delivery authority.
//   * lib/platform-leads owns the lead alert's SEND retries;
//   * lib/email/delivery-events.ts, lib/email/resend-webhook.ts and the Resend
//     webhook route own delivery-event RECEIPTS and never send.
// Neither side imports the other, and neither migration names the other's
// tables, so a change on one side cannot quietly become a second retry path.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|--)/.test(l)).join("\n");

const LEAD = readdirSync(path.join(ROOT, "lib/platform-leads")).map((f) => `lib/platform-leads/${f}`);
const RECEIPTS = ["lib/email/delivery-events.ts", "lib/email/resend-webhook.ts", "app/api/resend/webhook/route.ts"];

describe("one retry authority each", () => {
  it("the scan reaches both sides (not vacuous)", () => {
    expect(LEAD.length).toBeGreaterThanOrEqual(4);
    for (const f of RECEIPTS) expect(read(f).length, f).toBeGreaterThan(0);
  });

  it("the lead-alert worker never imports or calls the receipt pipeline", () => {
    for (const f of LEAD) {
      const src = code(read(f));
      expect(src, f).not.toMatch(/delivery-events|resend-webhook|email_provider_event|email_outbound_messages|_email_message\b/);
    }
  });

  it("the receipt pipeline never imports the lead-alert worker, sends, or retries an alert", () => {
    for (const f of RECEIPTS) {
      const src = code(read(f));
      expect(src, f).not.toMatch(/platform-leads|platform_lead_alert|deliverPlatformLeadAlert|sweepPlatformLeadAlerts/);
      expect(src, f).not.toMatch(/emails\.send\(|sendEmailSafely\(|sendWaitlistEmailIdempotent\(|sendOnceWithIdempotencyKey\(/);
    }
  });

  it("neither migration names the other's tables", () => {
    const m0212 = code(read("supabase/migrations/0212_email_delivery_events.sql"));
    const m0213 = code(read("supabase/migrations/0213_platform_lead_alerts.sql"));
    expect(m0212).not.toMatch(/platform_lead_alerts/);
    expect(m0213).not.toMatch(/email_outbound_messages|email_provider_events/);
  });
});
