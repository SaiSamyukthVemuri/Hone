import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

// ===========================================================================
// SMS-00 — the delivery-status callback route, with the REAL signature check.
//
// Every request below is signed exactly as Twilio signs it (HMAC-SHA1 over the
// full URL plus the sorted form fields), so these cases prove the route's own
// security model rather than a mock of it: the ledger row id travels in the
// URL's query and is therefore covered by the signature, and a request whose
// URL or body was altered after signing is refused before any database work.
//
// Substituted: the database (one rpc) and the ops-alert writer. Real: the
// signature validator, the status normaliser and every guard in the route.
// ===========================================================================

type RpcCall = { fn: string; args: Record<string, unknown> };
const h: {
  calls: RpcCall[];
  alerts: Array<Record<string, unknown>>;
  answer: { data: unknown; error: unknown };
} = { calls: [], alerts: [], answer: { data: null, error: null } };

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc(fn: string, args: Record<string, unknown>) {
      h.calls.push({ fn, args });
      return Promise.resolve(h.answer);
    },
  }),
}));

vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: (input: Record<string, unknown>) => {
    h.alerts.push(input);
    return Promise.resolve();
  },
}));

const { POST } = await import("@/app/api/twilio/message-status/route");

const TOKEN = "test-auth-token";
const BASE = "https://hone.care";
const ROW = "0b8f1c1e-6a52-4c0e-9f3e-2f6c3c1a7d10";
const SID = `SM${"a1".repeat(16)}`;
const STUDIO = "4f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b";
const APPT = "9e8d7c6b-5a49-4382-a716-152433221100";

function sign(url: string, params: Record<string, string>): string {
  let payload = url;
  for (const key of Object.keys(params).sort()) payload += key + params[key];
  return crypto.createHmac("sha1", TOKEN).update(payload).digest("base64");
}

/**
 * POST to the route. `requestUrl` is what the runtime sees (Vercel's internal
 * host); `signedUrl` is what Twilio signed (the public base). They differ in
 * production, which is exactly why the route re-derives the signed URL.
 */
function callback(
  params: Record<string, string>,
  opts: { query?: string; signedQuery?: string; signature?: string | null; tamperBody?: boolean } = {},
) {
  const query = opts.query ?? `?m=${ROW}`;
  const signedUrl = `${BASE}/api/twilio/message-status${opts.signedQuery ?? query}`;
  const requestUrl = `https://hone-internal.vercel.app/api/twilio/message-status${query}`;
  const signature = opts.signature === undefined ? sign(signedUrl, params) : opts.signature;
  const sent = opts.tamperBody ? { ...params, MessageStatus: "delivered" } : params;
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (signature !== null) headers["x-twilio-signature"] = signature;
  return POST(
    new Request(requestUrl, {
      method: "POST",
      headers,
      body: new URLSearchParams(sent).toString(),
    }),
  );
}

const twilio = (status: string, extra: Record<string, string> = {}) => ({
  MessageSid: SID,
  SmsSid: SID,
  AccountSid: `AC${"0".repeat(32)}`,
  MessageStatus: status,
  From: "+15550001111",
  To: "+16475550123",
  ...extra,
});

const updated = (status: string, purpose = "appointment_reminder_24h") => ({
  data: [{ result: "updated", studio_id: STUDIO, purpose, status, appointment_id: APPT }],
  error: null,
});

let logs: string[] = [];

beforeEach(() => {
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  process.env.TWILIO_WEBHOOK_BASE_URL = BASE;
  h.calls = [];
  h.alerts = [];
  h.answer = updated("delivered");
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
});

describe("authentication comes first, and a refusal does no database work", () => {
  it("a correctly signed callback is accepted (the control for every refusal below)", async () => {
    const res = await callback(twilio("delivered"));
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });

  it("no Auth Token configured -> 500, nothing written", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const res = await callback(twilio("delivered"));
    expect(res.status).toBe(500);
    expect(h.calls).toHaveLength(0);
  });

  it("no signature -> 403, nothing written", async () => {
    const res = await callback(twilio("delivered"), { signature: null });
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("a forged signature -> 403, nothing written", async () => {
    const res = await callback(twilio("delivered"), { signature: "Zm9yZ2Vk" });
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("the row id is covered by the signature: re-addressing a signed callback is refused", async () => {
    const other = "11111111-2222-4333-8444-555555555555";
    const res = await callback(twilio("delivered"), {
      query: `?m=${other}`,
      signedQuery: `?m=${ROW}`,
    });
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("a body altered after signing is refused", async () => {
    const res = await callback(twilio("undelivered"), { tamperBody: true });
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });
});

describe("a verified callback is applied once, to the row it names", () => {
  it("passes the row id, SID and normalised status to the one command", async () => {
    await callback(twilio("delivered"));
    expect(h.calls).toEqual([
      {
        fn: "record_sms_delivery_status",
        args: {
          p_message_id: ROW,
          p_provider_message_sid: SID,
          p_status: "delivered",
          p_provider_error_code: null,
        },
      },
    ]);
  });

  it("normalises Twilio's vocabulary (accepted -> queued, read -> delivered, canceled -> failed)", async () => {
    for (const [raw, normal] of [
      ["accepted", "queued"],
      ["scheduled", "queued"],
      ["read", "delivered"],
      ["canceled", "failed"],
    ] as const) {
      h.calls = [];
      h.answer = updated(normal);
      await callback(twilio(raw));
      expect(h.calls[0]?.args.p_status, raw).toBe(normal);
    }
  });

  it("an inbound or unknown status is acknowledged and not recorded", async () => {
    for (const raw of ["received", "receiving", "partially_delivered", "nonsense"]) {
      const res = await callback(twilio(raw));
      expect(res.status).toBe(200);
    }
    expect(h.calls).toHaveLength(0);
  });

  it("a callback with no row id, or a malformed SID, is acknowledged and not recorded", async () => {
    expect((await callback(twilio("delivered"), { query: "" })).status).toBe(200);
    expect((await callback(twilio("delivered", { MessageSid: "SM123" }))).status).toBe(200);
    expect(h.calls).toHaveLength(0);
  });

  it("a ledger failure answers 500 so the provider's debugger shows it", async () => {
    h.answer = { data: null, error: { message: "boom" } };
    expect((await callback(twilio("delivered"))).status).toBe(500);
  });
});

describe("a failed delivery is the one fact an operator must see", () => {
  it("undelivered raises ONE studio- and appointment-attributed warning with safe details", async () => {
    h.answer = updated("undelivered");
    await callback(twilio("undelivered", { ErrorCode: "30003" }));
    expect(h.calls[0]?.args.p_provider_error_code).toBe(30003);
    expect(h.alerts).toHaveLength(1);
    const alert = h.alerts[0]!;
    expect(alert).toMatchObject({
      severity: "warning",
      event: "sms_delivery_failed",
      studioId: STUDIO,
      appointmentId: APPT,
      safeDetails: {
        sms_message_id: ROW,
        purpose: "appointment_reminder_24h",
        provider_status: "undelivered",
        provider_error_code: 30003,
      },
    });
    // No phone number reaches the alert.
    expect(JSON.stringify(alert)).not.toMatch(/\+1\d{10}|5550001111|6475550123/);
  });

  it("a repeated or late failure report (stale) raises nothing", async () => {
    h.answer = {
      data: [{ result: "stale", studio_id: STUDIO, purpose: "waitlist_invitation", status: "failed", appointment_id: null }],
      error: null,
    };
    await callback(twilio("failed", { ErrorCode: "30005" }));
    expect(h.alerts).toHaveLength(0);
  });

  it("a successful delivery raises nothing", async () => {
    await callback(twilio("delivered"));
    expect(h.alerts).toHaveLength(0);
  });

  it("a non-numeric ErrorCode is dropped rather than recorded", async () => {
    h.answer = updated("failed");
    await callback(twilio("failed", { ErrorCode: "30003; drop table" }));
    expect(h.calls[0]?.args.p_provider_error_code).toBeNull();
  });
});

describe("logging discipline", () => {
  it("never logs the phone numbers or the signature", async () => {
    h.answer = updated("undelivered");
    await callback(twilio("undelivered", { ErrorCode: "30003" }));
    await callback(twilio("delivered"), { signature: "Zm9yZ2Vk" });
    const all = logs.join("\n");
    expect(all).not.toMatch(/5550001111|6475550123/);
    expect(all).not.toContain("Zm9yZ2Vk");
    expect(all).not.toContain(TOKEN);
  });

  it("the route reads no To, From or Body field", () => {
    const src = readFileSync("app/api/twilio/message-status/route.ts", "utf8").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    expect(src).not.toMatch(/formParams\.(To|From|Body)\b/);
  });
});
