import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectedInboundWebhookUrl } from "@/lib/sms/inbound-stop-preflight";
import { pagedSource, type PagedSource } from "@/tests/lib/sms/helpers/postgrest-pages";

// ===========================================================================
// WILLOW-STOP-PREFLIGHT-01 (#824): a STOP sent to a STUDIO's number, signed
// the way Twilio signs it, through the REAL route and the REAL validator.
// ===========================================================================
//
// Nothing about authentication is mocked. Each request is signed here,
// independently of lib/sms/twilio.ts, with Twilio's documented algorithm
// (HMAC-SHA1 over the full URL plus every POST field sorted by name, values
// appended raw, base64), using a SYNTHETIC token. Only the database is
// substituted. Every studio, number, service and account below is invented.
//
// What this proves for per-studio routing:
//   * a studio service whose inbound URL is exactly expectedInboundWebhookUrl
//     is accepted even though Vercel hands the route an internal hostname;
//   * the URL must match exactly: www, http, a trailing slash, a query, or
//     another path is a 403 with nothing written;
//   * a service in another (sub)account, signed with a token Hone does not
//     hold, is a 403 with nothing written;
//   * body fields (MessagingServiceSid, AccountSid, To) authenticate nothing
//     and route nothing: tampering after signing is a 403, and a validly
//     signed STOP reaches every studio holding the number;
//   * a missing base URL makes a correctly signed STOP fail (the blocker);
//   * a missing token is a 500 and a Twilio retry of the same STOP is a no-op.

type Row = { id: string; studio_id: string; phone: string | null; sms_opted_out_at: string | null };

const h: {
  clients: Row[];
  clientSource: PagedSource;
  prospectSource: PagedSource;
  clientUpdates: string[];
  suppressCalls: string[][];
  audits: unknown[];
} = {
  clients: [],
  clientSource: pagedSource(() => []),
  prospectSource: pagedSource(() => []),
  clientUpdates: [],
  suppressCalls: [],
  audits: [],
};

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      if (table === "audit_logs") {
        return {
          insert(rows: unknown[]) {
            h.audits.push(...rows);
            return Promise.resolve({ error: null });
          },
        };
      }
      return {
        select: () => h.clientSource.query(),
        update: (values: Record<string, unknown>) => ({
          eq: (_c: string, id: string) => ({
            is: () => {
              const row = h.clients.find((r) => r.id === id);
              if (row && row.sms_opted_out_at === null) {
                row.sms_opted_out_at = String(values.sms_opted_out_at);
                h.clientUpdates.push(id);
              }
              return Promise.resolve({ error: null });
            },
          }),
        }),
      };
    },
    rpc(fn: string, args?: Record<string, unknown>) {
      if (fn === "waitlist_prospect_suppression_candidates") return h.prospectSource.query();
      if (fn === "suppress_waitlist_prospects") {
        const ids = (args?.p_entry_ids as string[]) ?? [];
        h.suppressCalls.push(ids);
        return Promise.resolve({ data: ids.map((id) => ({ stamped_id: id })), error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  }),
}));

const { POST } = await import("@/app/api/twilio/inbound-sms/route");

const HONE_TOKEN = "synthetic-hone-auth-token-0001";
const SUBACCOUNT_TOKEN = "synthetic-subaccount-token-0002";
const BASE = "https://hone.example";
const INTERNAL = "https://hone-preview-abc123.vercel.app";
const HONE_ACCOUNT = `AC${"1".repeat(32)}`;
const STUDIO_B_SERVICE = `MG${"b".repeat(32)}`;
const STUDIO_B_NUMBER = "+14165550188";
const PHONE = "+16475551234";

/** Twilio's documented request signature, computed independently of the app. */
function twilioSignature(token: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
}

/** The form a studio's Messaging Service POSTs for an inbound message. */
function studioInbound(over: Record<string, string> = {}): Record<string, string> {
  return {
    ToCountry: "CA",
    SmsMessageSid: `SM${"9".repeat(32)}`,
    NumMedia: "0",
    SmsSid: `SM${"9".repeat(32)}`,
    SmsStatus: "received",
    Body: "STOP",
    To: STUDIO_B_NUMBER,
    MessagingServiceSid: STUDIO_B_SERVICE,
    NumSegments: "1",
    MessageSid: `SM${"9".repeat(32)}`,
    AccountSid: HONE_ACCOUNT,
    From: PHONE,
    ApiVersion: "2010-04-01",
    ...over,
  };
}

/**
 * POST to the route as Vercel delivers it: at `arrivesAt` (often an internal
 * hostname), carrying the signature Twilio computed over `signedUrl`.
 */
function deliver(opts: {
  params: Record<string, string>;
  signedUrl: string;
  token?: string;
  arrivesAt?: string;
  bodyParams?: Record<string, string>;
}) {
  const signature = twilioSignature(opts.token ?? HONE_TOKEN, opts.signedUrl, opts.params);
  const arrivesAt = opts.arrivesAt ?? `${INTERNAL}/api/twilio/inbound-sms`;
  return POST(
    new Request(arrivesAt, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
      body: new URLSearchParams(opts.bodyParams ?? opts.params).toString(),
    }) as never,
  );
}

const C = (id: string, studio: string, phone: string): Row => ({ id, studio_id: studio, phone, sms_opted_out_at: null });

const KEYS = ["TWILIO_AUTH_TOKEN", "TWILIO_WEBHOOK_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.TWILIO_AUTH_TOKEN = HONE_TOKEN;
  process.env.TWILIO_WEBHOOK_BASE_URL = BASE;
  h.clients = [C("a1", "studio-a", "647-555-1234"), C("b1", "studio-b", "+1 (647) 555-1234"), C("c1", "studio-c", "6475551234")];
  h.clientUpdates = [];
  h.suppressCalls = [];
  h.audits = [];
  h.clientSource = pagedSource(() => h.clients);
  h.prospectSource = pagedSource(() => []);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const expectNothingWritten = () => {
  expect(h.clientUpdates).toEqual([]);
  expect(h.suppressCalls).toEqual([]);
  expect(h.audits).toEqual([]);
};

const EXPECTED = () => {
  const e = expectedInboundWebhookUrl(process.env);
  if (!e.ok) throw new Error("fixture base must be valid");
  return e.url;
};

describe("a studio service posting to EXACTLY the expected URL is accepted", () => {
  it("the expected URL is the base plus the route path", () => {
    expect(EXPECTED()).toBe("https://hone.example/api/twilio/inbound-sms");
  });

  it("a STOP to Studio B's number, signed over the expected URL, arriving on an internal host: 200 and phone-wide", async () => {
    const res = await deliver({ params: studioInbound(), signedUrl: EXPECTED() });
    expect(res.status).toBe(200);
    expect([...h.clientUpdates].sort()).toEqual(["a1", "b1", "c1"]);
  });

  it("a Twilio retry of the same STOP is accepted and writes nothing new", async () => {
    await deliver({ params: studioInbound(), signedUrl: EXPECTED() });
    h.clientUpdates = [];
    h.audits = [];
    const res = await deliver({ params: studioInbound(), signedUrl: EXPECTED() });
    expect(res.status).toBe(200);
    expect(h.clientUpdates).toEqual([]);
    expect(h.audits).toEqual([]);
  });
});

describe("ANY other inbound URL on the studio service fails closed", () => {
  for (const [why, url] of [
    ["the www host (which 307-redirects to the apex)", "https://www.hone.example/api/twilio/inbound-sms"],
    ["http instead of https", "http://hone.example/api/twilio/inbound-sms"],
    ["a trailing slash", "https://hone.example/api/twilio/inbound-sms/"],
    ["a query string", "https://hone.example/api/twilio/inbound-sms?studio=b"],
    ["the status-callback path", "https://hone.example/api/twilio/message-status"],
    ["the internal deployment host", `${INTERNAL}/api/twilio/inbound-sms`],
  ] as const) {
    it(`signed over ${why}: 403, nothing written`, async () => {
      const res = await deliver({ params: studioInbound(), signedUrl: url });
      expect(res.status).toBe(403);
      expectNothingWritten();
    });
  }
});

describe("credentials: only the account whose token Hone holds", () => {
  it("a service in another (sub)account, signed with ITS token: 403, nothing written", async () => {
    const res = await deliver({
      params: studioInbound({ AccountSid: `AC${"2".repeat(32)}` }),
      signedUrl: EXPECTED(),
      token: SUBACCOUNT_TOKEN,
    });
    expect(res.status).toBe(403);
    expectNothingWritten();
  });

  it("no TWILIO_AUTH_TOKEN in the deployment: 500, nothing written", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const res = await deliver({ params: studioInbound(), signedUrl: `${BASE}/api/twilio/inbound-sms` });
    expect(res.status).toBe(500);
    expectNothingWritten();
  });

  it("BLOCKER PROOF: TWILIO_WEBHOOK_BASE_URL unset, Vercel delivers on an internal host: a correctly signed STOP is refused", async () => {
    delete process.env.TWILIO_WEBHOOK_BASE_URL;
    const res = await deliver({ params: studioInbound(), signedUrl: `${BASE}/api/twilio/inbound-sms` });
    expect(res.status).toBe(403);
    expectNothingWritten();
  });
});

describe("body fields are not authority, and do not narrow STOP", () => {
  it("a field changed after signing (From) is refused", async () => {
    const params = studioInbound();
    const res = await deliver({ params, signedUrl: EXPECTED(), bodyParams: { ...params, From: "+16475559999" } });
    expect(res.status).toBe(403);
    expectNothingWritten();
  });

  it("a field changed after signing (MessagingServiceSid, to claim another studio) is refused", async () => {
    const params = studioInbound();
    const res = await deliver({
      params,
      signedUrl: EXPECTED(),
      bodyParams: { ...params, MessagingServiceSid: `MG${"c".repeat(32)}` },
    });
    expect(res.status).toBe(403);
    expectNothingWritten();
  });

  it("the same signed STOP via another studio's service, or the platform number, reaches the same rows", async () => {
    const reached: string[][] = [];
    for (const over of [
      { MessagingServiceSid: STUDIO_B_SERVICE, To: STUDIO_B_NUMBER },
      { MessagingServiceSid: `MG${"a".repeat(32)}`, To: "+14165550177" },
      { MessagingServiceSid: "", To: "+15550001111" },
    ]) {
      h.clients = [C("a1", "studio-a", "647-555-1234"), C("b1", "studio-b", "+1 (647) 555-1234"), C("c1", "studio-c", "6475551234")];
      h.clientSource = pagedSource(() => h.clients);
      h.clientUpdates = [];
      const res = await deliver({ params: studioInbound(over), signedUrl: EXPECTED() });
      expect(res.status).toBe(200);
      reached.push([...h.clientUpdates].sort());
    }
    expect(reached).toEqual([
      ["a1", "b1", "c1"],
      ["a1", "b1", "c1"],
      ["a1", "b1", "c1"],
    ]);
  });
});
