import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pagedSource, type PagedSource } from "@/tests/lib/sms/helpers/postgrest-pages";

// MSG-LOG-RAW-ERROR-2. BEHAVIOUR: drive real code paths with HOSTILE errors, one
// per class, and read what actually reached the console. The source contract
// (tests/lib/logging/raw-error-log-contract.test.ts) proves no file passes an
// error's text to a log call; this proves the lines that DO get written carry
// the classified code and nothing the error said.
//
// The hostile text stands for what real errors quote: a constraint's value, a
// destination address, a URL with a token, a record id.

const HOSTILE =
  "duplicate key value violates unique constraint: Key (email)=(synthetic.person@example.test) " +
  "phone +1 604 555 0184 https://example.test/portal?token=abc123 " +
  "5b0f7a52-3c1d-4c8e-9a52-0b3f6a1d2e44";
const LEAK = /synthetic\.person|example\.test|604 555|abc123|5b0f7a52|duplicate key|socket hang up|scan failed or incomplete/i;

type Admin = { from: (table: string) => unknown; rpc: (fn: string, args?: unknown) => unknown };
const hold: { admin: () => Admin; clientSource: PagedSource; prospectSource: PagedSource; validSignature: boolean } = {
  admin: () => {
    throw new Error("admin not configured for this test");
  },
  clientSource: pagedSource(() => []),
  prospectSource: pagedSource(() => []),
  validSignature: true,
};

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => hold.admin() }));
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: vi.fn(() => Promise.resolve()),
  fireAndForgetOpsAlert: vi.fn(),
}));
vi.mock("@/lib/sms/twilio", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sms/twilio")>();
  return { ...real, validateTwilioFormRequest: () => hold.validSignature };
});

let errors: string[] = [];
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = [];
  spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
});
afterEach(() => {
  spy.mockRestore();
  vi.restoreAllMocks();
});

const logged = () => errors.join("\n");
const lines = () => errors.map((e) => JSON.parse(e) as Record<string, unknown>);
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// DB class: lib/portal-messages/queries.ts
// ---------------------------------------------------------------------------
describe("database error -> its code only (portal messages for the practitioner view)", () => {
  const failing = (error: unknown): Admin => ({
    rpc: () => undefined,
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ order: () => Promise.resolve({ data: null, error }) }) }) }),
    }),
  });

  it("logs the SQLSTATE and no part of the message, and still returns []", async () => {
    const { getPortalMessagesForPractitionerView } = await import("@/lib/portal-messages/queries");
    hold.admin = () => failing({ code: "42501", message: HOSTILE, details: HOSTILE, hint: HOSTILE });
    expect(await getPortalMessagesForPractitionerView("studio-1", "client-1")).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ event: "portal_messages_for_practitioner_failed", code: "42501" });
    expect(logged()).not.toMatch(LEAK);
  });

  it("a code that is not a SQLSTATE or PostgREST code is logged as 'unknown', never as text", async () => {
    const { getPortalMessagesForPractitionerView } = await import("@/lib/portal-messages/queries");
    hold.admin = () => failing({ code: HOSTILE, message: HOSTILE });
    await getPortalMessagesForPractitionerView("studio-1", "client-1");
    expect(lines()[0]).toMatchObject({ code: "unknown" });
    expect(logged()).not.toMatch(LEAK);
  });
});

// ---------------------------------------------------------------------------
// DB class AND thrown class: lib/notifications/practitioner-notifications.ts
// ---------------------------------------------------------------------------
describe("practitioner notification writer: a returned database error and a thrown one", () => {
  const input = {
    studioId: "studio-1",
    practitionerId: "practitioner-1",
    eventType: "new_booking",
    title: "New booking",
    body: "A booking was made",
    appointmentId: "appointment-1",
    clientId: "client-1",
    href: "/calendar",
  } as never;

  it("a returned error: the line carries the code only", async () => {
    const { recordPractitionerNotification } = await import("@/lib/notifications/practitioner-notifications");
    hold.admin = () => ({
      rpc: () => undefined,
      from: () => ({ insert: () => Promise.resolve({ error: { code: "23505", message: HOSTILE } }) }),
    });
    recordPractitionerNotification(input);
    await flush();
    const failedLine = lines().find((l) => l.event === "practitioner_notification_insert_failed");
    expect(failedLine).toMatchObject({ code: "23505" });
    expect(logged()).not.toMatch(LEAK);
  });

  it("a thrown error: the line carries a closed class, not the message", async () => {
    const { recordPractitionerNotification } = await import("@/lib/notifications/practitioner-notifications");
    hold.admin = () => ({
      rpc: () => undefined,
      from: () => ({ insert: () => Promise.reject(Object.assign(new Error(HOSTILE), { code: "ECONNRESET" })) }),
    });
    recordPractitionerNotification(input);
    await flush();
    const threwLine = lines().find((l) => l.event === "practitioner_notification_insert_threw");
    expect(threwLine).toMatchObject({ err_class: "network" });
    expect(logged()).not.toMatch(LEAK);
  });

  it("a thrown string is 'non_error' and its text is never logged", async () => {
    const { recordPractitionerNotification } = await import("@/lib/notifications/practitioner-notifications");
    hold.admin = () => ({ rpc: () => undefined, from: () => ({ insert: () => Promise.reject(HOSTILE) }) });
    recordPractitionerNotification(input);
    await flush();
    expect(lines().find((l) => l.event === "practitioner_notification_insert_threw")).toMatchObject({ err_class: "non_error" });
    expect(logged()).not.toMatch(LEAK);
  });
});

// ---------------------------------------------------------------------------
// The Twilio inbound webhook: thrown (body read, scan) and database (opt-out, audit)
// ---------------------------------------------------------------------------
describe("Twilio inbound STOP webhook", () => {
  type Row = { id: string; studio_id: string; phone: string | null; sms_opted_out_at: string | null };
  const row: Row = { id: "c1", studio_id: "s1", phone: "+16475551234", sms_opted_out_at: null };
  const state = { updateError: null as unknown, auditError: null as unknown };

  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = "token";
    hold.validSignature = true;
    state.updateError = null;
    state.auditError = null;
    hold.clientSource = pagedSource(() => [row]);
    hold.prospectSource = pagedSource(() => []);
    hold.admin = () => ({
      from(table: string) {
        if (table === "audit_logs") return { insert: () => Promise.resolve({ error: state.auditError }) };
        return {
          select: () => hold.clientSource.query(),
          update: () => ({ eq: () => ({ is: () => Promise.resolve({ error: state.updateError }) }) }),
        };
      },
      rpc: (fn: string) =>
        fn === "waitlist_prospect_suppression_candidates"
          ? hold.prospectSource.query()
          : Promise.resolve({ data: null, error: null }),
    });
  });

  const stopRequest = () =>
    new Request("https://hone.care/api/twilio/inbound-sms", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "sig" },
      body: new URLSearchParams({ From: "+16475551234", To: "+15550001111", Body: "STOP", MessageSid: "SM1" }).toString(),
    }) as never;

  it("THROWN: a request body that cannot be read logs a closed class, not the message", async () => {
    const { POST } = await import("@/app/api/twilio/inbound-sms/route");
    const req = {
      text: () => Promise.reject(Object.assign(new Error(HOSTILE), { code: "ECONNRESET" })),
      headers: new Headers({ "x-twilio-signature": "sig" }),
      url: "https://hone.care/api/twilio/inbound-sms",
    } as unknown as Request;
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(lines()[0]).toMatchObject({ event: "twilio_inbound_body_read_failed", errorClass: "network" });
    expect(logged()).not.toMatch(LEAK);
  });

  it("THROWN: a client scan that fails is logged as a class; the route's own wording and the transport text stay out", async () => {
    const { POST } = await import("@/app/api/twilio/inbound-sms/route");
    hold.clientSource = pagedSource(() => [row], { throws: () => true });
    await POST(stopRequest());
    const scan = lines().find((l) => l.event === "twilio_inbound_client_scan_failed");
    expect(scan).toMatchObject({ errorClass: "error" });
    expect(scan).not.toHaveProperty("error");
    expect(logged()).not.toMatch(LEAK);
  });

  it("DATABASE: an opt-out write error logs the SQLSTATE only", async () => {
    const { POST } = await import("@/app/api/twilio/inbound-sms/route");
    state.updateError = { code: "42501", message: HOSTILE, details: HOSTILE };
    const res = await POST(stopRequest());
    expect(res.status).toBe(500);
    expect(lines().find((l) => l.event === "twilio_inbound_client_optout_failed")).toMatchObject({ code: "42501" });
    expect(logged()).not.toMatch(LEAK);
  });

  it("DATABASE: an audit insert error logs the SQLSTATE only", async () => {
    const { POST } = await import("@/app/api/twilio/inbound-sms/route");
    state.auditError = { code: "23514", message: HOSTILE };
    await POST(stopRequest());
    expect(lines().find((l) => l.event === "twilio_inbound_audit_insert_failed")).toMatchObject({ code: "23514" });
    expect(logged()).not.toMatch(LEAK);
  });

  it("DATABASE: a code that is free text becomes 'unknown'", async () => {
    const { POST } = await import("@/app/api/twilio/inbound-sms/route");
    state.updateError = { code: HOSTILE, message: HOSTILE };
    await POST(stopRequest());
    expect(lines().find((l) => l.event === "twilio_inbound_client_optout_failed")).toMatchObject({ code: "unknown" });
    expect(logged()).not.toMatch(LEAK);
  });
});

// ---------------------------------------------------------------------------
// THROWN class through a wrapped SDK: the rate-limit backend alarm
// ---------------------------------------------------------------------------
describe("rate-limit backend outage alarm", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) saved[k] = process.env[k];
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.invalid";
    process.env.UPSTASH_REDIS_REST_TOKEN = "t";
    vi.resetModules();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.doUnmock("@upstash/redis");
    vi.doUnmock("@upstash/ratelimit");
  });

  async function outage(thrown: unknown) {
    vi.doMock("@upstash/redis", () => ({ Redis: class {} }));
    vi.doMock("@upstash/ratelimit", () => {
      class Ratelimit {
        static slidingWindow() {
          return { kind: "slidingWindow" };
        }
        async limit() {
          throw thrown;
        }
      }
      return { Ratelimit };
    });
    const { limitMobileVerificationIp } = await import("@/lib/rate-limit/public");
    const result = await limitMobileVerificationIp("start", { headers: new Headers({ "x-forwarded-for": "203.0.113.9" }) });
    expect(result).toEqual({ allowed: true }); // fail open is unchanged
  }

  it("a network failure is logged as 'network', with the SDK's text left out", async () => {
    await outage(Object.assign(new Error(HOSTILE), { code: "ECONNRESET" }));
    const alarm = lines().find((l) => l.event === "ratelimit_backend_unavailable");
    expect(alarm).toMatchObject({ errorClass: "network" });
    expect(alarm).not.toHaveProperty("error");
    expect(logged()).not.toMatch(LEAK);
  });

  it("any other thrown error is 'error'; a thrown string is 'non_error'", async () => {
    await outage(new Error(HOSTILE));
    expect(lines().find((l) => l.event === "ratelimit_backend_unavailable")).toMatchObject({ errorClass: "error" });
    expect(logged()).not.toMatch(LEAK);
    errors = [];
    vi.resetModules();
    await outage(HOSTILE);
    expect(lines().find((l) => l.event === "ratelimit_backend_unavailable")).toMatchObject({ errorClass: "non_error" });
    expect(logged()).not.toMatch(LEAK);
  });
});

// ---------------------------------------------------------------------------
// card-on-file: a thrown failure keeps its synthetic 'unavailable' code AND gains a class
// ---------------------------------------------------------------------------
describe("card-on-file batch lookup (the one site whose structure changed)", () => {
  it("a returned database error logs its SQLSTATE only", async () => {
    const { getCardOnFileStatuses } = await import("@/lib/payment-methods/card-on-file");
    hold.admin = () => ({
      rpc: () => undefined,
      from: () => ({
        select: () => ({
          eq: () => ({ in: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: null, error: { code: "42501", message: HOSTILE } }) }) }) }),
        }),
      }),
    });
    expect(await getCardOnFileStatuses("studio-1", ["client-1"])).toEqual({ ok: false });
    expect(lines()[0]).toMatchObject({ event: "card_on_file_batch_lookup_failed", code: "42501" });
    expect(lines()[0]).not.toHaveProperty("errorClass");
    expect(logged()).not.toMatch(LEAK);
  });

  it("a thrown failure logs the fixed 'unavailable' code and a closed class, never the message", async () => {
    const { getCardOnFileStatuses } = await import("@/lib/payment-methods/card-on-file");
    hold.admin = () => {
      throw Object.assign(new Error(HOSTILE), { code: "ECONNREFUSED" });
    };
    expect(await getCardOnFileStatuses("studio-1", ["client-1"])).toEqual({ ok: false });
    expect(lines()[0]).toMatchObject({ event: "card_on_file_batch_lookup_failed", code: "card_on_file_client_unavailable", errorClass: "network" });
    expect(logged()).not.toMatch(LEAK);
  });
});
