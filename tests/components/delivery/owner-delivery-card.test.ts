import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { describeIncident, purposeLabel } from "@/lib/delivery/incidents";

// ===========================================================================
// DELIVERY-VISIBILITY-02 — the owner's "Message delivery" card and the plain-
// English incident reading it shares with the support queue.
//
// The card follows the contract agreed with the #824 owner-console lane: it
// reads owner_delivery_incidents with the user's OWN session (no admin
// client), renders NOTHING only when the database refuses (42501), shows an
// owner whose read FAILED that the status is unknown (never healthy), and
// shows operational metadata only.
// ===========================================================================

const h: { answer: { data: unknown; error: unknown }; calls: Array<[string, unknown]> } = {
  answer: { data: [], error: null },
  calls: [],
};

const c: { answer: { data: unknown; error: unknown } } = { answer: { data: [], error: null } };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (fn: string, args: unknown) => {
      h.calls.push([fn, args]);
      return Promise.resolve(fn === "owner_delivery_concerns" ? c.answer : h.answer);
    },
  }),
}));

const { OwnerDeliveryCard } = await import("@/components/delivery/OwnerDeliveryCard");

const STUDIO = "4f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b";
const APPT = "9e8d7c6b-5a49-4382-a716-152433221100";

async function render(): Promise<string> {
  const el = await OwnerDeliveryCard({ studioId: STUDIO, timezone: "America/Los_Angeles" });
  return el ? renderToStaticMarkup(el) : "";
}

const incident = (over: Record<string, unknown> = {}) => ({
  incident_id: "6e5d4c3b-2a19-4807-a6b5-c4d3e2f1a0b9",
  channel: "email",
  purpose: "appointment_reminder_24h",
  failure_class: "bounced",
  occurrences: 3,
  first_seen_at: "2026-10-12T15:00:00Z",
  last_seen_at: "2026-10-12T18:00:00Z",
  last_reason: "no_email",
  last_appointment_id: APPT,
  resolved_at: null,
  resolution: null,
  ...over,
});

afterEach(() => {
  h.answer = { data: [], error: null };
  c.answer = { data: [], error: null };
  h.calls = [];
  delete process.env.RESEND_WEBHOOK_SECRET;
});

describe("OwnerDeliveryCard", () => {
  it("reads its own studio through the owner RPC, with the user's session", async () => {
    await render();
    expect(h.calls).toEqual([
      ["owner_delivery_incidents", { p_studio_id: STUDIO }],
      ["owner_delivery_concerns", { p_studio_id: STUDIO }],
    ]);
  });

  it("renders nothing ONLY when the database refuses the caller", async () => {
    h.answer = { data: null, error: { code: "42501", message: "not the owner of this studio" } };
    expect(await render()).toBe("");
  });

  it("shows an owner whose read failed that the status is UNKNOWN, never healthy", async () => {
    for (const answer of [
      { data: null, error: { code: "PGRST301", message: "JWT expired" } },
      { data: null, error: { message: "network" } },
      { data: { not: "an array" }, error: null },
    ]) {
      h.answer = answer;
      const html = await render();
      expect(html).toContain("Delivery status is unavailable right now");
      expect(html).toContain("unknown whether any messages failed");
      expect(html).not.toContain("No delivery problems");
    }
  });

  it("says plainly when there is nothing, and admits what it cannot see yet", async () => {
    const html = await render();
    expect(html).toContain("No delivery problems reported in the last 14 days.");
    expect(html).toContain("Email bounce reports are not switched on yet");
    process.env.RESEND_WEBHOOK_SECRET = "whsec_x";
    const live = await render();
    expect(live).not.toContain("not switched on yet");
    expect(live).toContain("not that it was read");
  });

  it("lists open incidents once each, with a count, the meaning, the next step and the appointment", async () => {
    h.answer = {
      data: [incident(), incident({ incident_id: "x", resolved_at: "2026-10-11T00:00:00Z", resolution: "fixed" })],
      error: null,
    };
    const html = await render();
    expect(html).toContain("1 open delivery problem.");
    expect(html).toContain("24-hour reminder email not delivered");
    expect(html).toContain("3 times");
    expect(html).toContain("The client&#x27;s mail server rejected the email.");
    expect(html).toContain("Check the client&#x27;s email address");
    expect(html).toContain(`/calendar/${APPT}`);
    // Resolved incidents are not shown as open problems.
    expect(html.match(/not delivered/g)).toHaveLength(1);
  });
});

describe("owner-reported concerns on the card (DELIVERY-VISIBILITY-04)", () => {
  it("lists the owner's open concerns with what the ledger said when reported", async () => {
    c.answer = {
      data: [
        { concern_id: "k1", appointment_id: APPT, channel: "email", purpose: "appointment_postcare", ledger_status_at_report: "delivered", reported_at: "2026-10-12T16:00:00Z", state: "open" },
        { concern_id: "k2", appointment_id: APPT, channel: "sms", purpose: "appointment_reminder_2h", ledger_status_at_report: "no_record", reported_at: "2026-10-10T16:00:00Z", state: "closed" },
      ],
      error: null,
    };
    const html = await render();
    expect(html).toContain("client says they did not receive it (1 open)");
    expect(html).toContain("Postcare email");
    expect(html).toContain("not that it was seen");
    expect(html).not.toContain("2-hour reminder text");
  });

  it("treats a failed concern read as unknown too, never as healthy", async () => {
    c.answer = { data: null, error: { message: "network" } };
    const html = await render();
    expect(html).toContain("Delivery status is unavailable right now");
  });
});

describe("describeIncident", () => {
  it("gives every failure class a meaning, a next step and who acts, without claiming a read or a loss", () => {
    const classes: Array<[string, string]> = [
      ["email", "bounced"], ["email", "suppressed"], ["email", "failed"], ["email", "refused"],
      ["sms", "undelivered"], ["sms", "failed"], ["sms", "refused"],
    ];
    for (const [channel, failure_class] of classes) {
      const d = describeIncident({ channel, purpose: "appointment_reminder_2h", failure_class } as never);
      expect(d.meaning.length, `${channel}/${failure_class}`).toBeGreaterThan(10);
      expect(d.nextStep.length).toBeGreaterThan(10);
      expect(`${d.meaning} ${d.nextStep}`).not.toMatch(/\b(read|opened|inbox|lost)\b/i);
    }
  });

  it("puts a bounce on the studio and a provider failure on Hone", () => {
    expect(describeIncident({ channel: "email", purpose: "x_y", failure_class: "bounced" }).owner).toBe("studio");
    expect(describeIncident({ channel: "email", purpose: "x_y", failure_class: "failed" }).owner).toBe("hone");
  });

  it("labels known purposes and humanises unknown ones", () => {
    expect(purposeLabel("waitlist_invitation")).toBe("Waitlist invitation");
    expect(purposeLabel("future_purpose")).toBe("Future purpose");
  });
});
