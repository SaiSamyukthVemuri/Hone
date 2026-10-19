import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  retained_failed_appointments: over.resolved_at ? [] : [{ appointment_id: APPT, last_reason: null, claimed_at: "2026-10-12T15:00:00Z" }],
  ...over,
});

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-19T12:00:00Z")); });

afterEach(() => {
  vi.restoreAllMocks();
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

  it("says plainly when there is nothing, and admits what it cannot see", async () => {
    const html = await render();
    expect(html).toContain("No delivery problems reported in the last 14 days.");
    expect(html).toContain("appears here only once Hone is receiving the email provider&#x27;s delivery reports");
    expect(html).toContain("does not prove every email arrived");
    expect(html).toContain("not that it was read");
  });

  it("never infers that bounce reporting is live from the signing secret (Codex P2 4253217747)", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const without = await render();
    process.env.RESEND_WEBHOOK_SECRET = "whsec_x";
    const withSecret = await render();
    // The secret's presence changes nothing the owner reads.
    expect(withSecret).toBe(without);
    expect(withSecret).not.toMatch(/switched on|reporting is (on|live)/i);
    expect(readFileSync("components/delivery/OwnerDeliveryCard.tsx", "utf8")).not.toContain("RESEND_WEBHOOK_SECRET");
  });

  it("never says nothing was reported when the window holds only resolved incidents (Codex P2 4244957358)", async () => {
    h.answer = {
      data: [
        incident({ resolved_at: "2026-10-11T00:00:00Z", resolution: "fixed" }),
        incident({ incident_id: "y", resolved_at: "2026-10-10T00:00:00Z", resolution: "acknowledged" }),
      ],
      error: null,
    };
    const html = await render();
    expect(html).not.toContain("No delivery problems reported");
    expect(html).toContain("No open delivery problems. 2 problems were resolved in the last 14 days.");
    expect(html).not.toContain("not delivered");
  });

  it("lists open incidents once each, with a count, the meaning, the next step and the appointment", async () => {
    h.answer = {
      data: [incident(), incident({ incident_id: "x", resolved_at: "2026-10-11T00:00:00Z", resolution: "fixed" })],
      error: null,
    };
    const html = await render();
    expect(html).toContain("1 open delivery problem shown.");
    expect(html).toContain("1 problem was resolved in the last 14 days.");
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

describe("the summary claim is derived from EVERY category (Codex P2 4307428928)", () => {
  // This claim has been wrong twice for the same reason — it read fewer
  // categories than the card displays. One case per category, so the next
  // category cannot be added without a visible gap here.
  const concern = (over: Record<string, unknown> = {}) => ({
    concern_id: "k1",
    appointment_id: APPT,
    channel: "email",
    purpose: "appointment_postcare",
    ledger_status_at_report: "delivered",
    reported_at: "2026-10-12T16:00:00Z",
    state: "open",
    closed_at: "2026-10-12T16:00:00Z",
    ...over,
  });
  const NONE_REPORTED = "No delivery problems reported in the last 14 days.";

  it("nothing in any category: claims no problems", async () => {
    h.answer = { data: [], error: null };
    c.answer = { data: [], error: null };
    expect(await render()).toContain(NONE_REPORTED);
  });

  it("CONCERN ONLY: never claims 'no delivery problems reported'", async () => {
    // THE REGRESSION ITSELF. Zero incidents plus one open concern printed the
    // no-problems sentence directly above the list of that very concern.
    h.answer = { data: [], error: null };
    c.answer = { data: [concern()], error: null };
    const html = await render();
    expect(html).not.toContain(NONE_REPORTED);
    expect(html).not.toContain("No open delivery problems");
    // ...and it says something true instead, while the concern is still listed.
    expect(html).toContain("1 open report from your studio.");
    expect(html).toContain("client says they did not receive it (1 open)");
  });

  it("OPEN INCIDENT ONLY: counts the incidents", async () => {
    h.answer = { data: [incident()], error: null };
    c.answer = { data: [], error: null };
    const html = await render();
    expect(html).not.toContain(NONE_REPORTED);
    expect(html).toContain("1 open delivery problem shown.");
  });

  it("RESOLVED INCIDENT ONLY: no OPEN problems, but not 'none reported'", async () => {
    h.answer = { data: [incident({ resolved_at: "2026-10-13T10:00:00Z", resolution: "fixed" })], error: null };
    c.answer = { data: [], error: null };
    const html = await render();
    expect(html).not.toContain(NONE_REPORTED);
    expect(html).toContain("No open delivery problems.");
  });

  it("BOTH an open incident and an open concern: the incident count stands and the concern is still listed", async () => {
    h.answer = { data: [incident()], error: null };
    c.answer = { data: [concern()], error: null };
    const html = await render();
    expect(html).toContain("1 open delivery problem shown.");
    expect(html).toContain("client says they did not receive it (1 open)");
    expect(html).not.toContain(NONE_REPORTED);
  });

  it("a CLOSED concern is ACKNOWLEDGED, never denied (Codex P2 4307695801)", async () => {
    // THIS CASE IS INVERTED FROM ITS PREVIOUS FORM, deliberately. I had pinned
    // the old behaviour — a closed concern reading as "nothing reported" — as a
    // considered asymmetry, on the grounds that the card does not LIST closed
    // concerns so counting them would reference something invisible. The
    // reviewer was right that denying a report the studio actually made is the
    // worse error. So the count now includes it and the words say what happened.
    h.answer = { data: [], error: null };
    c.answer = { data: [concern({ state: "closed" })], error: null };
    const html = await render();
    expect(html).not.toContain(NONE_REPORTED);
    expect(html).toContain("No open delivery problems.");
    expect(html).toContain("1 report from your studio was closed in the last 14 days.");
  });

  it("several closed concerns are pluralised", async () => {
    h.answer = { data: [], error: null };
    c.answer = {
      data: [
        concern({ concern_id: "k1", state: "closed" }),
        concern({ concern_id: "k2", state: "closed" }),
      ],
      error: null,
    };
    expect(await render()).toContain("2 reports from your studio were closed in the last 14 days.");
  });

  it("counts only recent closed_at values in the 14-day note (4307824374)", async () => {
    h.answer = { data: [], error: null };
    c.answer = { data: [
      concern({ state: "closed", closed_at: "2026-10-19T11:00:00Z" }),
      concern({ concern_id: "older", state: "closed", closed_at: "2026-09-29T12:00:00Z" }),
      concern({ concern_id: "boundary", state: "closed", closed_at: "2026-10-05T12:00:00Z" }),
      concern({ concern_id: "unknown", state: "closed", closed_at: null }),
    ], error: null };
    const html = await render();
    expect(html).toContain("1 report from your studio was closed in the last 14 days.");
    expect(html).not.toContain("4 reports");
  });

  it("CONTROL: a genuinely empty fortnight still says nothing was reported", async () => {
    // So the inversion above has not simply made the denial unreachable.
    h.answer = { data: [], error: null };
    c.answer = { data: [], error: null };
    expect(await render()).toContain(NONE_REPORTED);
  });
});

describe("concern attribution (Codex P2 4307428933)", () => {
  it("never claims the viewing owner reported it", async () => {
    // `owner_delivery_concerns` returns every concern for the STUDIO with no
    // reporter filter, so "Reported by you" was false for every co-owner but
    // the one who filed it.
    h.answer = { data: [], error: null };
    c.answer = {
      data: [
        {
          concern_id: "k1",
          appointment_id: APPT,
          channel: "email",
          purpose: "appointment_postcare",
          ledger_status_at_report: "delivered",
          reported_at: "2026-10-12T16:00:00Z",
          state: "open",
        },
      ],
      error: null,
    };
    const html = await render();
    expect(html).not.toContain("Reported by you:");
    expect(html).toContain("Reported by your studio:");
  });
});

describe("the owner card's capped read is not a total (Codex P2 4307695060)", () => {
  // `owner_delivery_incidents` applies `limit 200` (0215:314) after ordering
  // open incidents first, so a studio at the cap sees a SLICE — and because
  // resolved rows sort LAST they are the first thing the cap removes, which
  // would distort the resolved note silently as well.
  const CAP = 200;
  const INDICATOR = "Showing up to 200 incidents, with open incidents first, newest activity first within each group. Other incidents, if any, are not listed.";

  it("AT the cap: says so, and the count reads as SHOWN", async () => {
    h.answer = {
      data: Array.from({ length: CAP }, (_, i) =>
        incident({ incident_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }),
      ),
      error: null,
    };
    const html = await render();
    expect(html).toContain(INDICATOR);
    expect(html).toContain("shown");
    // The bare "N open delivery problems." form is what read as a total.
    expect(html).not.toMatch(/open delivery problems\. Repeats/);
  });

  it("BELOW the cap: no indicator, because nothing is hidden", async () => {
    h.answer = {
      data: Array.from({ length: CAP - 1 }, (_, i) =>
        incident({ incident_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }),
      ),
      error: null,
    };
    const html = await render();
    expect(html).not.toContain("Other incidents, if any, are not listed");
    // ...and it still reports the incidents it does have.
    expect(html).toContain("shown");
  });

  it("an empty studio says neither", async () => {
    h.answer = { data: [], error: null };
    const html = await render();
    expect(html).not.toContain("Other incidents, if any, are not listed");
    expect(html).toContain("No delivery problems reported in the last 14 days.");
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


it("assigns only invalid-address refusals to studio data correction (4307826148)", () => {
  const row = { channel: "email" as const, purpose: "appointment_reminder_24h", failure_class: "refused" as const };
  expect(describeIncident({ ...row, last_reason: "invalid_to_address" })).toMatchObject({
    owner: "studio", nextStep: "Check the client's email address with them and update it.",
  });
  for (const last_reason of [null, "provider_refused", "invalid_api_key"]) {
    expect(describeIncident({ ...row, last_reason }).owner).toBe("hone");
  }
});


describe("confirmed invalid-number refusal needs studio correction (4310343000)", () => {
  it.each(["appointment_confirmation", "appointment_reminder_24h", "appointment_reminder_2h"])("assigns confirmed21211 %s to the studio with the correction step", (purpose) => {
    const result = describeIncident({ channel: "sms", purpose, failure_class: "refused", last_reason: "twilio_21211" });
    expect(result).toMatchObject({
      meaning: "The text provider refused the client's invalid mobile number.",
      nextStep: "Check the client's mobile number with them and update it.",
      owner: "studio",
    });
    expect(result.title).toContain("text not delivered");
    expect(result.nextStep).not.toContain("Nothing to change");
  });

  it("keeps unknown and non-exact SMS refusal reasons Hone-owned", () => {
    for (const last_reason of [null, "provider_refused", "twilio_unknown", "twilio_21211_extra", "21211"]) {
      expect(describeIncident({ channel: "sms", purpose: "appointment_confirmation", failure_class: "refused", last_reason })).toMatchObject({
        owner: "hone", nextStep: "Nothing to change on your side. Contact Hone support if it continues.",
      });
    }
  });

  it("does not apply a foreign SMS reason to email or change other failure classes", () => {
    for (const channel of ["email", "sms"] as const) {
      for (const failure_class of ["refused", "bounced", "failed", "suppressed", "undelivered"] as const) {
        if (channel === "sms" && failure_class === "refused") continue;
        const row = { channel, purpose: "appointment_reminder_24h", failure_class };
        expect(describeIncident({ ...row, last_reason: "twilio_21211" })).toEqual(describeIncident({ ...row, last_reason: null }));
      }
    }
  });
});


describe("retained-only partial appointment projection", () => {
  const second = "11111111-1111-4111-8111-111111111111";
  const link = (appointment_id = APPT, last_reason: string | null = null) => ({ appointment_id, last_reason, claimed_at: "2026-10-12T15:00:00Z" });
  it("reaches both appointments with each attempt's own classification, not the latest aggregate reason", async () => {
    h.answer = { data: [incident({ channel: "sms", failure_class: "refused", last_reason: null,
      retained_failed_appointments: [link(APPT, "twilio_21211"), link(second)] })], error: null };
    const html = await render();
    expect(html).toContain(`/calendar/${APPT}`);
    expect(html).toContain(`/calendar/${second}`);
    expect(html).toContain("invalid mobile number");
    expect(html).toContain("Nothing to change on your side");
    expect(html).toContain("Partial view: up to 200 appointment links");
    expect(html).toContain("not a complete delivery history");
    expect(html).toContain("for open problems only");
    expect(html).toContain("Resolved problems have no links in this view");
    expect(html).toContain("Latest retained failed attempt");
    expect(html.match(/href=/g)).toHaveLength(2);
  });
  it("does not add the aggregate latest appointment outside the bounded projection", async () => {
    h.answer = { data: [incident({ last_appointment_id: second, retained_failed_appointments: [link()] })], error: null };
    expect(await render()).not.toContain(`/calendar/${second}`);
    h.answer = { data: [incident({ retained_failed_appointments: [] })], error: null };
    const html = await render();
    expect(html).toContain("No retained appointment links are included");
    expect(html).not.toContain("href=");
    expect(html).toContain("1 open delivery problem shown.");
  });
  it.each([undefined, null, {}, [link("invalid")], [link(), link()], [{ ...link(), claimed_at: "bad" }], [{ ...link(), last_reason: "raw provider text" }]])("fails closed on missing or malformed projection %j", async (projection) => {
    h.answer = { data: [incident({ retained_failed_appointments: projection })], error: null };
    expect(await render()).toContain("Delivery status is unavailable");
  });
  it("enforces the global 200-link bound across groups", async () => {
    h.answer = { data: Array.from({ length: 201 }, (_, i) => incident({ incident_id: String(i) })), error: null };
    expect(await render()).toContain("Delivery status is unavailable");
  });
});


describe("retained reason classification never displays provider text", () => {
  it.each(["provider_refused", "twilio_21211_extra", "raw provider text: +15555550123"])("uses safe generic copy for unknown/raw %s", (last_reason) => {
    const row = { channel: "sms" as const, purpose: "appointment_confirmation", failure_class: "refused" as const, last_reason };
    const result = describeIncident(row);
    expect(result).toEqual(describeIncident({ ...row, last_reason: null }));
    expect(result.owner).toBe("hone");
    expect(JSON.stringify(result)).not.toContain(last_reason);
  });
});
