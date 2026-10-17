import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendBookingConfirmationSmsToClient } from "@/lib/sms/send-appointment";

// SMS-00 — a fenced deployment skips an appointment SMS BEFORE the claim.
//
// Vercel previews run against the production database, so a claim there spends
// a real appointment's attempt and a failure there writes a real ops alert. The
// transport would refuse anyway; this pins that the helper never gets that far.

const alerts: unknown[] = [];
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: (input: unknown) => {
    alerts.push(input);
    return Promise.resolve();
  },
}));

const SID = `SM${"0f".repeat(16)}`;

function admin() {
  const rpcs: string[] = [];
  const client = {
    rpc(fn: string) {
      rpcs.push(fn);
      return Promise.resolve({ data: true, error: null });
    },
  } as unknown as SupabaseClient;
  return { client, rpcs };
}

const input = (client: SupabaseClient) => ({
  admin: client,
  appointmentId: "a",
  startsAt: new Date("2026-10-08T15:00:00Z"),
  timezone: "America/Toronto",
  studio: {
    id: "s",
    name: "Studio",
    send_confirmation_sms: true,
    send_24h_sms_reminders: true,
    send_2h_sms_reminders: true,
  },
  client: { phone: "+16475550123", sms_consent_at: "2026-10-01T00:00:00Z", sms_opted_out_at: null },
  intakeUrl: null,
  manageUrl: null,
});

let fetchMock: ReturnType<typeof vi.fn>;
const ENV_KEYS = ["VERCEL_ENV", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  alerts.length = 0;
  process.env.TWILIO_ACCOUNT_SID = `AC${"1".repeat(32)}`;
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+15550001111";
  fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ sid: SID }), { status: 201 })));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("the fence is checked before the claim", () => {
  it("a preview booking makes no claim, no request and no alert", async () => {
    process.env.VERCEL_ENV = "preview";
    const { client, rpcs } = admin();
    expect(await sendBookingConfirmationSmsToClient(input(client))).toEqual({
      ok: false,
      skipped: true,
      reason: "non_production_deployment",
    });
    expect(rpcs).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(alerts).toEqual([]);
  });

  it("production claims and sends (the control)", async () => {
    process.env.VERCEL_ENV = "production";
    const { client, rpcs } = admin();
    const r = await sendBookingConfirmationSmsToClient(input(client));
    expect(r).toEqual({ ok: true, messageSid: SID });
    expect(rpcs[0]).toBe("claim_sms_send");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
