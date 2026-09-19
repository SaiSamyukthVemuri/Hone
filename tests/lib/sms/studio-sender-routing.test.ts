import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  send24hReminderSmsToClient,
  send2hReminderSmsToClient,
  sendBookingConfirmationSmsToClient,
} from "@/lib/sms/send-appointment";

// ===========================================================================
// WAIT S3 PART 2 — the routing law, proved end to end
//
//   1 consent / STOP gate
//   2 resolve the STUDIO's active sender
//   3 anything but ok  ->  REFUSE BEFORE CLAIM
//   4 claim
//   5 build body
//   6 sendSmsSafely with the EXPLICIT resolved MessagingServiceSid
//   7 recordSmsResult in finally, unchanged
//
// THE HARD INVARIANT under test:
//   no valid studio sender -> no claim -> zero provider call -> zero attempt
//   consumed.
//
// `fetch` is stubbed and asserted on directly, so "zero provider call" is
// measured rather than assumed. No Twilio, no network, no real send.
// ===========================================================================

const STUDIO_ID = "11111111-1111-4111-8111-111111111111";
const APPT_ID = "22222222-2222-4222-8222-222222222222";
const RESOLVED_SID = "MGstudioownidentity0000000000000000";
const PLATFORM_SID = "MGplatformwideshared00000000000000";
const PLATFORM_FROM = "+15550000000";

const studio = {
  id: STUDIO_ID,
  name: "Willow Electrolysis",
  send_confirmation_sms: true,
  send_24h_sms_reminders: true,
  send_2h_sms_reminders: true,
} as const;

const consentingClient = {
  phone: "+14165551234",
  sms_consent_at: "2026-09-01T00:00:00.000Z",
  sms_opted_out_at: null,
} as const;

/** Records every RPC so claim-vs-resolve ordering can be asserted. */
type Recorder = { calls: string[] };

function adminStub(
  recorder: Recorder,
  opts: {
    senderRows?: unknown;
    senderError?: unknown;
    claimOk?: boolean;
  } = {},
): SupabaseClient {
  const rpc = vi.fn(async (name: string) => {
    recorder.calls.push(name);
    if (name === "resolve_active_studio_sms_sender") {
      return { data: opts.senderRows ?? null, error: opts.senderError ?? null };
    }
    if (name === "claim_sms_send") {
      return { data: opts.claimOk ?? true, error: null };
    }
    return { data: null, error: null };
  });
  return { rpc } as unknown as SupabaseClient;
}

function confirmationArgs(admin: SupabaseClient) {
  return {
    admin,
    appointmentId: APPT_ID,
    startsAt: new Date("2026-10-01T14:00:00.000Z"),
    timezone: "America/Toronto",
    studio,
    client: consentingClient,
    manageUrl: "https://hone.care/manage/tok",
    intakeUrl: null,
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // A sender env is ALWAYS present in these tests. If routing ever fell back
  // to it, proof G would silently pass; making it present everywhere means a
  // fallback shows up as a wrong MessagingServiceSid rather than as absence.
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "tok";
  process.env.TWILIO_MESSAGING_SERVICE_SID = PLATFORM_SID;
  process.env.TWILIO_FROM_NUMBER = PLATFORM_FROM;

  fetchSpy = vi.fn(async () =>
    new Response(JSON.stringify({ sid: "SMsent", status: "queued" }), {
      status: 201,
    }),
  );
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- A ---------------------------------------------------------------------

describe("A — a resolved sender reaches Twilio verbatim", () => {
  it("posts the STUDIO's MessagingServiceSid, not the platform one", async () => {
    const rec: Recorder = { calls: [] };
    const admin = adminStub(rec, {
      senderRows: [{ messaging_service_sid: RESOLVED_SID }],
    });

    const r = await sendBookingConfirmationSmsToClient(confirmationArgs(admin));

    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = String((fetchSpy.mock.calls[0]![1] as RequestInit).body);
    expect(body).toContain(`MessagingServiceSid=${RESOLVED_SID}`);
    expect(body).not.toContain(PLATFORM_SID);
    // The legacy From path is gone entirely.
    expect(body).not.toContain("From=");
  });

  it("resolves BEFORE it claims", async () => {
    const rec: Recorder = { calls: [] };
    const admin = adminStub(rec, {
      senderRows: [{ messaging_service_sid: RESOLVED_SID }],
    });
    await sendBookingConfirmationSmsToClient(confirmationArgs(admin));
    const resolveAt = rec.calls.indexOf("resolve_active_studio_sms_sender");
    const claimAt = rec.calls.indexOf("claim_sms_send");
    expect(resolveAt).toBeGreaterThanOrEqual(0);
    expect(claimAt).toBeGreaterThan(resolveAt);
  });
});

// --- B / C / D -------------------------------------------------------------

const REFUSALS = [
  {
    label: "B — no active sender",
    rows: [] as unknown,
    error: null as unknown,
    reason: "sms_sender_not_active_for_studio",
  },
  {
    label: "C — ambiguous sender",
    rows: [
      { messaging_service_sid: RESOLVED_SID },
      { messaging_service_sid: "MGsecond0000000000000000000000000" },
    ] as unknown,
    error: null as unknown,
    reason: "sms_sender_ambiguous",
  },
  {
    label: "D — resolver read failure",
    rows: null as unknown,
    error: { message: "boom" } as unknown,
    reason: "sms_sender_read_failed",
  },
  {
    label: "D — malformed resolver result",
    rows: "not-an-array" as unknown,
    error: null as unknown,
    reason: "sms_sender_read_failed",
  },
];

describe.each(REFUSALS)("$label — refuse before claim", (c) => {
  it("skips with the ops-alert vocabulary reason", async () => {
    const rec: Recorder = { calls: [] };
    const admin = adminStub(rec, { senderRows: c.rows, senderError: c.error });
    const r = await sendBookingConfirmationSmsToClient(confirmationArgs(admin));
    expect(r).toEqual({ ok: false, skipped: true, reason: c.reason });
  });

  it("consumes ZERO attempts — claim_sms_send is never called", async () => {
    const rec: Recorder = { calls: [] };
    const admin = adminStub(rec, { senderRows: c.rows, senderError: c.error });
    await sendBookingConfirmationSmsToClient(confirmationArgs(admin));
    expect(rec.calls).toContain("resolve_active_studio_sms_sender");
    expect(rec.calls).not.toContain("claim_sms_send");
  });

  it("issues ZERO provider calls", async () => {
    const rec: Recorder = { calls: [] };
    const admin = adminStub(rec, { senderRows: c.rows, senderError: c.error });
    await sendBookingConfirmationSmsToClient(confirmationArgs(admin));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records nothing — record_sms_result is never reached", async () => {
    const rec: Recorder = { calls: [] };
    const admin = adminStub(rec, { senderRows: c.rows, senderError: c.error });
    await sendBookingConfirmationSmsToClient(confirmationArgs(admin));
    expect(rec.calls).not.toContain("record_sms_result");
  });
});

describe("C — ambiguity never resolves to the first row", () => {
  it("does not send from either candidate", async () => {
    const rec: Recorder = { calls: [] };
    const admin = adminStub(rec, {
      senderRows: [
        { messaging_service_sid: RESOLVED_SID },
        { messaging_service_sid: "MGsecond0000000000000000000000000" },
      ],
    });
    const r = await sendBookingConfirmationSmsToClient(confirmationArgs(admin));
    expect(r.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain(RESOLVED_SID);
  });
});

// --- E ---------------------------------------------------------------------

describe("E — the consent / STOP gate stays BEFORE routing", () => {
  const suppressed = [
    {
      label: "opted out (STOP)",
      client: { ...consentingClient, sms_opted_out_at: "2026-09-02T00:00:00.000Z" },
      reason: "client_opted_out",
    },
    {
      label: "no consent",
      client: { ...consentingClient, sms_consent_at: null },
      reason: "client_no_consent",
    },
    {
      label: "studio toggle off",
      client: consentingClient,
      studio: { ...studio, send_confirmation_sms: false },
      reason: "studio_toggle_off",
    },
  ];

  it.each(suppressed)("$label — zero sender lookup", async (c) => {
    const rec: Recorder = { calls: [] };
    const admin = adminStub(rec, {
      senderRows: [{ messaging_service_sid: RESOLVED_SID }],
    });
    const r = await sendBookingConfirmationSmsToClient({
      ...confirmationArgs(admin),
      studio: c.studio ?? studio,
      client: c.client,
    });
    expect(r).toEqual({ ok: false, skipped: true, reason: c.reason });
    // A suppressed client must not even cause a sender to be looked up.
    expect(rec.calls).not.toContain("resolve_active_studio_sms_sender");
    expect(rec.calls).not.toContain("claim_sms_send");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// --- F ---------------------------------------------------------------------

describe("F — the claim → provider → record lifecycle is intact", () => {
  it("claims, calls the provider once, and records the result", async () => {
    const rec: Recorder = { calls: [] };
    const admin = adminStub(rec, {
      senderRows: [{ messaging_service_sid: RESOLVED_SID }],
    });
    const r = await sendBookingConfirmationSmsToClient(confirmationArgs(admin));
    expect(r.ok).toBe(true);
    expect(rec.calls).toContain("claim_sms_send");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(rec.calls).toContain("record_sms_result");
  });

  it("an unclaimed send still short-circuits, and never calls the provider", async () => {
    const rec: Recorder = { calls: [] };
    const admin = adminStub(rec, {
      senderRows: [{ messaging_service_sid: RESOLVED_SID }],
      claimOk: false,
    });
    const r = await sendBookingConfirmationSmsToClient(confirmationArgs(admin));
    expect(r).toEqual({ ok: false, skipped: true, reason: "not_claimed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// --- G ---------------------------------------------------------------------

describe("G — the environment cannot rescue a routing failure", () => {
  it("refuses with a valid platform sender present, and issues zero fetch", async () => {
    // Both env keys hold usable values throughout this file. If any fallback
    // survived anywhere in the chain, this is where it would show.
    expect(process.env.TWILIO_MESSAGING_SERVICE_SID).toBe(PLATFORM_SID);
    expect(process.env.TWILIO_FROM_NUMBER).toBe(PLATFORM_FROM);

    const rec: Recorder = { calls: [] };
    const admin = adminStub(rec, { senderRows: [] });
    const r = await sendBookingConfirmationSmsToClient(confirmationArgs(admin));

    expect(r).toEqual({
      ok: false,
      skipped: true,
      reason: "sms_sender_not_active_for_studio",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rec.calls).not.toContain("claim_sms_send");
  });

  it("does not read the env sender even on the SUCCESS path", async () => {
    const rec: Recorder = { calls: [] };
    const admin = adminStub(rec, {
      senderRows: [{ messaging_service_sid: RESOLVED_SID }],
    });
    await sendBookingConfirmationSmsToClient(confirmationArgs(admin));
    const body = String((fetchSpy.mock.calls[0]![1] as RequestInit).body);
    expect(body).not.toContain(PLATFORM_SID);
    expect(body).not.toContain(encodeURIComponent(PLATFORM_FROM));
  });
});

// --- H ---------------------------------------------------------------------

describe("H — confirmation, 24h and 2h share ONE routing law", () => {
  const senders = [
    { label: "confirmation", fn: sendBookingConfirmationSmsToClient },
    { label: "24h reminder", fn: send24hReminderSmsToClient },
    { label: "2h reminder", fn: send2hReminderSmsToClient },
  ];

  it.each(senders)("$label routes through the studio sender", async (s) => {
    const rec: Recorder = { calls: [] };
    const admin = adminStub(rec, {
      senderRows: [{ messaging_service_sid: RESOLVED_SID }],
    });
    const r = await s.fn(confirmationArgs(admin));
    expect(r.ok).toBe(true);
    const body = String((fetchSpy.mock.calls[0]![1] as RequestInit).body);
    expect(body).toContain(`MessagingServiceSid=${RESOLVED_SID}`);
  });

  it.each(senders)("$label refuses before claim when unrouteable", async (s) => {
    const rec: Recorder = { calls: [] };
    const admin = adminStub(rec, { senderRows: [] });
    const r = await s.fn(confirmationArgs(admin));
    expect(r).toEqual({
      ok: false,
      skipped: true,
      reason: "sms_sender_not_active_for_studio",
    });
    expect(rec.calls).not.toContain("claim_sms_send");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// --- I ---------------------------------------------------------------------

describe("I — a routing failure cannot consume an SMS attempt", () => {
  /**
   * `claim_sms_send` is what increments `send_attempts` and stamps
   * `claimed_at`; the counter lives behind that RPC and nowhere else. So the
   * counter is modelled here as "how many times the claim was invoked", which
   * is the only way runtime can move it.
   */
  function countingAdmin(rec: Recorder, senderRows: unknown) {
    let attempts = 0;
    const rpc = vi.fn(async (name: string) => {
      rec.calls.push(name);
      if (name === "resolve_active_studio_sms_sender") {
        return { data: senderRows, error: null };
      }
      if (name === "claim_sms_send") {
        attempts += 1; // the ONLY writer of the attempt counter
        return { data: true, error: null };
      }
      return { data: null, error: null };
    });
    return {
      admin: { rpc } as unknown as SupabaseClient,
      attempts: () => attempts,
    };
  }

  it("leaves the counter at ZERO across the whole three-attempt budget", async () => {
    // The real damage a claim-first ordering would do: a misconfigured studio
    // burns all three attempts rediscovering the same configuration fact, then
    // gives up PERMANENTLY on a message it never tried to send.
    const rec: Recorder = { calls: [] };
    const { admin, attempts } = countingAdmin(rec, []);

    for (let i = 0; i < 3; i += 1) {
      const r = await sendBookingConfirmationSmsToClient(confirmationArgs(admin));
      expect(r).toEqual({
        ok: false,
        skipped: true,
        reason: "sms_sender_not_active_for_studio",
      });
    }

    expect(attempts()).toBe(0);
    expect(rec.calls.filter((c) => c === "claim_sms_send")).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    // …and the budget is still fully intact for after the fix.
    const { admin: fixed, attempts: fixedAttempts } = countingAdmin(rec, [
      { messaging_service_sid: RESOLVED_SID },
    ]);
    const ok = await sendBookingConfirmationSmsToClient(confirmationArgs(fixed));
    expect(ok.ok).toBe(true);
    expect(fixedAttempts()).toBe(1);
  });

  it("holds for ambiguous and read_failed too", async () => {
    for (const rows of [
      [{ messaging_service_sid: "MGa00000000000000000000000000000" },
       { messaging_service_sid: "MGb00000000000000000000000000000" }],
      "malformed" as unknown,
    ]) {
      const rec: Recorder = { calls: [] };
      const { admin, attempts } = countingAdmin(rec, rows);
      await sendBookingConfirmationSmsToClient(confirmationArgs(admin));
      expect(attempts()).toBe(0);
    }
  });
});
