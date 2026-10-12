import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

// ===========================================================================
// DELIVERY-EVENTS-01 — the Resend webhook route, with the REAL signature check.
//
// Every request below is signed exactly as Svix signs Resend's webhooks, so
// these cases prove the route's own security model rather than a mock of it.
// A refused request reaches no database at all; an accepted one is durable
// before it is acknowledged; a delivery the receipt could not record is
// refused, so the provider retries it.
//
// Substituted: the database (rpc only). Real: the verifier, the payload
// minimiser and the receipt/claim/process wrappers.
// ===========================================================================

type RpcCall = { fn: string; args: Record<string, unknown> };
type Answer = { data: unknown; error: unknown } | (() => never);

const h: {
  calls: RpcCall[];
  admins: number;
  answers: Record<string, Answer[]>;
} = { calls: [], admins: 0, answers: {} };

function answer(fn: string): Promise<{ data: unknown; error: unknown }> {
  const queue = h.answers[fn] ?? [];
  const next = queue.length > 1 ? queue.shift()! : queue[0];
  if (!next) return Promise.resolve({ data: null, error: { message: `unscripted ${fn}` } });
  if (typeof next === "function") return Promise.reject(new Error("connection reset"));
  return Promise.resolve(next);
}

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    h.admins += 1;
    return {
      rpc(fn: string, args: Record<string, unknown>) {
        h.calls.push({ fn, args });
        return answer(fn);
      },
    };
  },
}));

const { POST } = await import("@/app/api/resend/webhook/route");

const SECRET = `whsec_${Buffer.from("delivery-events-01 route test secret").toString("base64")}`;
const DELIVERY_ID = "msg_2qRouteTestDelivery0001";
const EMAIL_ID = "9f1d2c3b-4a5e-4f60-8172-839405a6b7c8";
const LEDGER_ID = "0b8f1c1e-6a52-4c0e-9f3e-2f6c3c1a7d10";
const RECEIPT_ID = "6e5d4c3b-2a19-4807-a6b5-c4d3e2f1a0b9";
const STUDIO = "4f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b";
const RECIPIENT = "route.client@example.test";
const SUBJECT = "Reminder: your appointment";

function payload(type = "email.delivered", data: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type,
    created_at: "2026-10-11T18:30:00.000Z",
    data: {
      email_id: EMAIL_ID,
      from: "Hone <hello@hone.care>",
      to: [RECIPIENT],
      subject: SUBJECT,
      tags: { hone_m: LEDGER_ID },
      ...data,
    },
  });
}

function sign(raw: string, ts: number, id = DELIVERY_ID, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${crypto.createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64")}`;
}

function deliver(
  raw: string,
  opts: { ts?: number; signature?: string | null; tamper?: (raw: string) => string } = {},
): Promise<Response> {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "svix-id": DELIVERY_ID,
    "svix-timestamp": String(ts),
  };
  const signature = opts.signature === undefined ? sign(raw, ts) : opts.signature;
  if (signature !== null) headers["svix-signature"] = signature;
  return POST(
    new Request("https://hone.care/api/resend/webhook", {
      method: "POST",
      headers,
      body: opts.tamper ? opts.tamper(raw) : raw,
    }),
  );
}

const ok = (data: unknown) => ({ data, error: null });
const recorded = (state = "pending", result = "recorded") =>
  ok([{ result, receipt_id: RECEIPT_ID, receipt_state: state }]);
const claimedOwn = ok([{ receipt_id: RECEIPT_ID }]);
const claimedNone = ok([]);
const appliedDelivered = ok([
  { result: "applied", reason: "status_advanced", message_id: LEDGER_ID, message_studio_id: STUDIO, message_status: "delivered" },
]);

let logged: string[] = [];

beforeEach(() => {
  h.calls = [];
  h.admins = 0;
  h.answers = {};
  logged = [];
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  const capture = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.RESEND_WEBHOOK_SECRET;
});

const fns = () => h.calls.map((c) => c.fn);

describe("refusals reach no database", () => {
  it("answers 500 and writes nothing when no signing secret is configured", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const res = await deliver(payload());
    expect(res.status).toBe(500);
    expect(h.admins).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it.each([
    ["no signature header", { signature: null }],
    ["a forged signature", { signature: `v1,${Buffer.alloc(32).toString("base64")}` }],
    ["a body changed after signing", { tamper: (raw: string) => raw.replace("email.delivered", "email.bounced") }],
    ["a replay from an hour ago", { ts: Math.floor(Date.now() / 1000) - 3600 }],
    ["a timestamp in the future", { ts: Math.floor(Date.now() / 1000) + 3600 }],
  ] as const)("refuses %s with 403 and no database work", async (_label, opts) => {
    const res = await deliver(payload(), opts as Parameters<typeof deliver>[1]);
    expect(res.status).toBe(403);
    expect(h.admins).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("refuses a body far larger than any delivery event with 413, before verifying", async () => {
    const res = await deliver(payload("email.delivered", { padding: "x".repeat(300 * 1024) }));
    expect(res.status).toBe(413);
    expect(h.calls).toEqual([]);
  });

  // Codex P2 4248920477: the limit bounds what is READ, not only what is verified.
  it("refuses an oversized declared Content-Length with 413 without reading the body", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const res = await POST(
      new Request("https://hone.care/api/resend/webhook", {
        method: "POST",
        headers: { "content-length": String(10 * 1024 * 1024) },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(1);
    expect(h.admins).toBe(0);
  });

  it("stops reading an undeclared stream as soon as it passes the limit, and cancels it", async () => {
    let sent = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = await POST(
      new Request("https://hone.care/api/resend/webhook", { method: "POST", body: stream, duplex: "half" } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(cancelled).toBe(true);
    // An endless body: reading stopped one chunk past 256 KiB, not at the end.
    expect(sent).toBeLessThanOrEqual(256 * 1024 + 3 * 64 * 1024);
    expect(h.admins).toBe(0);
  });

  it("still verifies a multi-byte UTF-8 body exactly as signed", async () => {
    const res = await deliver(payload("email.delivered", { note: "café ✓ – ünïcode" }));
    expect(res.status).not.toBe(403);
  });
});

describe("an accepted delivery is durable before it is acknowledged", () => {
  it("records, claims and processes its own receipt, then sweeps, and answers 200", async () => {
    h.answers = {
      record_email_provider_event: [recorded()],
      claim_email_provider_events: [claimedOwn, claimedNone],
      process_email_provider_event: [appliedDelivered],
    };
    const res = await deliver(payload());
    expect(res.status).toBe(200);
    expect(fns()).toEqual([
      "record_email_provider_event",
      "claim_email_provider_events",
      "process_email_provider_event",
      "claim_email_provider_events",
    ]);
    expect(h.calls[1]!.args).toEqual({ p_event_id: RECEIPT_ID, p_limit: null });
    expect(h.calls[2]!.args).toEqual({ p_event_id: RECEIPT_ID });
    expect(h.calls[3]!.args).toEqual({ p_event_id: null, p_limit: 5 });
  });

  it("stores only the normalised minimum: no address, subject or tag other than the ledger id", async () => {
    h.answers = {
      record_email_provider_event: [recorded()],
      claim_email_provider_events: [claimedOwn, claimedNone],
      process_email_provider_event: [appliedDelivered],
    };
    await deliver(payload("email.bounced", { bounce: { type: "Permanent", subType: "NoEmail", message: `no such user ${RECIPIENT}` } }));
    expect(h.calls[0]!.args).toEqual({
      p_provider_event_id: DELIVERY_ID,
      p_event_type: "email.bounced",
      p_provider_email_id: EMAIL_ID,
      p_hone_message_id: LEDGER_ID,
      p_provider_created_at: "2026-10-11T18:30:00.000Z",
      p_bounce_type: "permanent",
      p_bounce_subtype: "no_email",
      p_failure_reason: null,
      p_suppression_type: null,
    });
    const everything = JSON.stringify(h.calls) + logged.join("\n");
    expect(everything).not.toContain(RECIPIENT);
    expect(everything).not.toContain(SUBJECT);
    expect(everything).not.toContain("no such user");
  });

  it("refuses with 500 when the receipt cannot be written, so the provider retries", async () => {
    h.answers = { record_email_provider_event: [{ data: null, error: { message: "db down" } }] };
    const res = await deliver(payload());
    expect(res.status).toBe(500);
    expect(fns()).toEqual(["record_email_provider_event"]);
  });

  it("refuses with 500 when the database connection drops mid-record", async () => {
    h.answers = { record_email_provider_event: [() => { throw new Error("unused"); }] };
    const res = await deliver(payload());
    expect(res.status).toBe(500);
  });

  it("answers 500 when its own processing fails, so the provider's retry recovers the still-pending receipt (Codex P2 4244387538)", async () => {
    h.answers = {
      record_email_provider_event: [recorded()],
      claim_email_provider_events: [claimedOwn, claimedNone],
      process_email_provider_event: [{ data: null, error: { message: "deadlock detected" } }],
    };
    const res = await deliver(payload());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, recorded: true });
    expect(logged.join("\n")).toContain("processing_failed");
  });

  it("answers 500 when the claim itself fails, for the same reason", async () => {
    h.answers = {
      record_email_provider_event: [recorded()],
      claim_email_provider_events: [{ data: null, error: { message: "db blip" } }],
    };
    expect((await deliver(payload())).status).toBe(500);
  });

  it("acknowledges the provider's retry once the receipt is processed or quarantined after its bounded attempts", async () => {
    // The database quarantines a receipt after five attempts; the retry that
    // follows finds it processed and gets 200, so a poison event cannot keep
    // the provider retrying until it disables the endpoint.
    h.answers = { record_email_provider_event: [recorded("quarantined", "duplicate")] };
    const res = await deliver(payload());
    expect(res.status).toBe(200);
    expect(fns()).toEqual(["record_email_provider_event"]);
  });

  it("keeps the provider retrying while a failed attempt's claim is still held (Codex P2 4244798597)", async () => {
    // The 5-second retry lands inside the two-minute claim a failed attempt
    // left behind: the claim comes back empty. Answering 200 here would stop
    // Resend's retries and strand the receipt, so the answer is 500 until a
    // retry lands after the claim expires.
    h.answers = {
      record_email_provider_event: [recorded("pending", "duplicate")],
      claim_email_provider_events: [claimedNone, claimedNone],
    };
    const res = await deliver(payload());
    expect(res.status).toBe(500);
    expect(fns()).not.toContain("process_email_provider_event");
  });


  it("acknowledges a malformed but signed body as a receipt rather than refusing it", async () => {
    h.answers = {
      record_email_provider_event: [recorded()],
      claim_email_provider_events: [claimedOwn, claimedNone],
      process_email_provider_event: [
        ok([{ result: "quarantined", reason: "unknown_event_type", message_id: null, message_studio_id: null, message_status: null }]),
      ],
    };
    const res = await deliver("this is not json");
    expect(res.status).toBe(200);
    expect(h.calls[0]!.args.p_event_type).toBe("malformed");
  });
});

describe("retries and replays", () => {
  it("acknowledges a duplicate that was already processed without touching it again", async () => {
    h.answers = { record_email_provider_event: [recorded("applied", "duplicate")] };
    const res = await deliver(payload());
    expect(res.status).toBe(200);
    expect(fns()).toEqual(["record_email_provider_event"]);
  });

  it("finishes a duplicate whose first delivery died before processing (crash recovery by provider retry)", async () => {
    h.answers = {
      record_email_provider_event: [recorded("pending", "duplicate")],
      claim_email_provider_events: [claimedOwn, claimedNone],
      process_email_provider_event: [appliedDelivered],
    };
    const res = await deliver(payload());
    expect(res.status).toBe(200);
    expect(fns()).toContain("process_email_provider_event");
  });

  it("leaves a receipt another worker holds to that worker, and asks the provider to try again later", async () => {
    h.answers = {
      record_email_provider_event: [recorded("pending", "duplicate")],
      claim_email_provider_events: [claimedNone],
    };
    const res = await deliver(payload());
    expect(res.status).toBe(500);
    expect(fns()).not.toContain("process_email_provider_event");
  });


  it("uses its turn to recover older receipts, without letting their outcome change its answer", async () => {
    const OLDER = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    h.answers = {
      record_email_provider_event: [recorded()],
      claim_email_provider_events: [claimedOwn, ok([{ receipt_id: OLDER }])],
      process_email_provider_event: [appliedDelivered, { data: null, error: { message: "boom" } }],
    };
    const res = await deliver(payload());
    expect(res.status).toBe(200);
    expect(h.calls.filter((c) => c.fn === "process_email_provider_event").map((c) => c.args.p_event_id)).toEqual([
      RECEIPT_ID,
      OLDER,
    ]);
    expect(logged.join("\n")).toContain('"failed":1');
  });
});
