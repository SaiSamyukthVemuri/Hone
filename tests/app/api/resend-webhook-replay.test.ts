import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

// ===========================================================================
// MSG-009 — the Resend webhook route against a FAKE PROVIDER and an in-memory
// model of the hosted 0212 receipt commands.
//
// tests/app/api/resend-webhook.test.ts scripts each RPC answer. This file
// instead lets the route drive a small stateful model of
// record_email_provider_event / claim_email_provider_events /
// process_email_provider_event (unique on svix-id, attempts counted before
// they are made, a two-minute claim, forward-only status), and a fake Resend
// that signs each delivery exactly as Svix does. Captured requests are then
// replayed byte-for-byte, re-labelled, tampered with, and retried, and the
// cases assert on the resulting STATE: how many receipts exist and what the
// ledger row says, not which calls were made.
//
// No network: the fake provider is a signer, and the database is a Map.
// ===========================================================================

const SECRET = `whsec_${Buffer.from("msg-009 fake provider replay secret").toString("base64")}`;
const LEDGER_ID = "3c2b1a09-8f7e-4d6c-9b5a-4a3b2c1d0e9f";
const EMAIL_ID = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
const STUDIO = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";

// ---------------------------------------------------------------------------
// The in-memory 0212 model. Only the semantics the route depends on.
// ---------------------------------------------------------------------------

type Receipt = {
  id: string;
  deliveryId: string;
  eventType: string;
  providerEmailId: string | null;
  honeMessageId: string | null;
  state: "pending" | "applied" | "stale" | "unmatched" | "ignored" | "quarantined";
  attempts: number;
  claimedAtMs: number | null;
  receivedAtMs: number;
};

const RANK: Record<string, number> = {
  claimed: 0,
  accepted: 1,
  sent: 2,
  delivery_delayed: 3,
  delivered: 4,
  bounced: 5,
};
const TARGET: Record<string, string> = {
  "email.sent": "sent",
  "email.delivery_delayed": "delivery_delayed",
  "email.delivered": "delivered",
  "email.bounced": "bounced",
};
const CLAIM_TTL_MS = 2 * 60 * 1000;
const SWEEP_AGE_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

const db: {
  receipts: Map<string, Receipt>;
  ledger: Map<string, { studioId: string; status: string; providerEmailId: string }>;
  processFailures: number;
  calls: string[];
  admins: number;
} = { receipts: new Map(), ledger: new Map(), processFailures: 0, calls: [], admins: 0 };

let nextReceipt = 0;
function receiptId(): string {
  nextReceipt += 1;
  return `00000000-0000-4000-8000-${String(nextReceipt).padStart(12, "0")}`;
}

function rpc(fn: string, args: Record<string, unknown>): { data: unknown; error: unknown } {
  db.calls.push(fn);
  const now = Date.now();
  if (fn === "record_email_provider_event") {
    const deliveryId = args.p_provider_event_id as string;
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(deliveryId)) {
      return { data: [{ result: "invalid_input", receipt_id: null, receipt_state: null }], error: null };
    }
    const existing = [...db.receipts.values()].find((r) => r.deliveryId === deliveryId);
    if (existing) {
      return {
        data: [{ result: "duplicate", receipt_id: existing.id, receipt_state: existing.state }],
        error: null,
      };
    }
    const r: Receipt = {
      id: receiptId(),
      deliveryId,
      eventType: args.p_event_type as string,
      providerEmailId: (args.p_provider_email_id as string | null) ?? null,
      honeMessageId: (args.p_hone_message_id as string | null) ?? null,
      state: "pending",
      attempts: 0,
      claimedAtMs: null,
      receivedAtMs: now,
    };
    db.receipts.set(r.id, r);
    return { data: [{ result: "recorded", receipt_id: r.id, receipt_state: "pending" }], error: null };
  }
  if (fn === "claim_email_provider_events") {
    const id = args.p_event_id as string | null;
    const free = (r: Receipt) =>
      r.state === "pending" && (r.claimedAtMs === null || r.claimedAtMs < now - CLAIM_TTL_MS);
    const named = (r: Receipt) => (id ? r.id === id : r.receivedAtMs < now - SWEEP_AGE_MS);
    const candidates = [...db.receipts.values()].filter((r) => named(r) && free(r));
    for (const r of candidates) {
      if (r.attempts >= MAX_ATTEMPTS) r.state = "quarantined";
    }
    const claimed = candidates.filter((r) => r.state === "pending").slice(0, id ? 1 : 5);
    for (const r of claimed) {
      r.attempts += 1;
      r.claimedAtMs = now;
    }
    return { data: claimed.map((r) => ({ receipt_id: r.id })), error: null };
  }
  if (fn === "process_email_provider_event") {
    const r = db.receipts.get(args.p_event_id as string);
    if (!r) return { data: [{ result: "not_found" }], error: null };
    if (r.state !== "pending") return { data: [{ result: "already_processed" }], error: null };
    if (db.processFailures > 0) {
      // The transaction rolls back: the receipt stays pending, its attempt
      // already counted and its claim still held.
      db.processFailures -= 1;
      return { data: null, error: { message: "canceling statement due to statement timeout" } };
    }
    const target = TARGET[r.eventType];
    const row = r.honeMessageId ? db.ledger.get(r.honeMessageId) : undefined;
    r.claimedAtMs = null;
    if (!target) {
      r.state = "quarantined";
      return { data: [{ result: "quarantined", reason: "unknown_event_type" }], error: null };
    }
    if (!row) {
      r.state = "unmatched";
      return { data: [{ result: "unmatched", reason: "unmatched_tag" }], error: null };
    }
    const forward = RANK[target] > RANK[row.status];
    if (forward) row.status = target;
    r.state = forward ? "applied" : "stale";
    return {
      data: [
        {
          result: r.state,
          reason: forward ? "status_advanced" : "not_forward",
          message_id: r.honeMessageId,
          message_studio_id: row.studioId,
          message_status: row.status,
        },
      ],
      error: null,
    };
  }
  return { data: null, error: { message: `unmodelled ${fn}` } };
}

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    db.admins += 1;
    return { rpc: async (fn: string, args: Record<string, unknown>) => rpc(fn, args) };
  },
}));

// Next's after(): run the deferred sweep once the response exists.
const deferred: Array<() => Promise<void>> = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (work: () => Promise<void>) => {
    deferred.push(work);
  },
}));

const { POST } = await import("@/app/api/resend/webhook/route");

// ---------------------------------------------------------------------------
// The fake provider: signs a delivery the way Svix signs Resend's webhooks.
// A retry keeps the svix-id and is signed afresh with a new timestamp.
// ---------------------------------------------------------------------------

type Captured = { headers: Record<string, string>; body: string };

function signedDelivery(deliveryId: string, body: string, atMs = Date.now()): Captured {
  const ts = String(Math.floor(atMs / 1000));
  const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
  const sig = crypto.createHmac("sha256", key).update(`${deliveryId}.${ts}.${body}`).digest("base64");
  return {
    headers: {
      "content-type": "application/json",
      "svix-id": deliveryId,
      "svix-timestamp": ts,
      "svix-signature": `v1,${sig}`,
    },
    body,
  };
}

function event(type: string, createdAt = "2026-10-24T01:00:00.000Z"): string {
  return JSON.stringify({
    type,
    created_at: createdAt,
    data: {
      email_id: EMAIL_ID,
      from: "Hone <hello@hone.care>",
      to: ["replay.client@example.test"],
      subject: "Reminder",
      tags: { hone_m: LEDGER_ID },
    },
  });
}

async function post(req: Captured): Promise<Response> {
  const res = await POST(
    new Request("https://hone.care/api/resend/webhook", {
      method: "POST",
      headers: req.headers,
      body: req.body,
    }),
  );
  for (const work of deferred.splice(0)) await work();
  return res;
}

const receipts = () => [...db.receipts.values()];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T01:00:05.000Z"));
  db.receipts = new Map();
  db.ledger = new Map([[LEDGER_ID, { studioId: STUDIO, status: "accepted", providerEmailId: EMAIL_ID }]]);
  db.processFailures = 0;
  db.calls = [];
  db.admins = 0;
  deferred.length = 0;
  nextReceipt = 0;
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.RESEND_WEBHOOK_SECRET;
});

describe("a captured delivery replayed against the route", () => {
  it("is applied once: a byte-identical replay inside the window is acknowledged and changes nothing", async () => {
    const captured = signedDelivery("msg_replay_delivered_01", event("email.delivered"));

    expect((await post(captured)).status).toBe(200);
    expect(db.ledger.get(LEDGER_ID)?.status).toBe("delivered");

    db.calls = [];
    vi.setSystemTime(new Date("2026-10-24T01:03:00.000Z"));
    expect((await post(captured)).status).toBe(200);

    expect(receipts()).toHaveLength(1);
    expect(receipts()[0]).toMatchObject({ state: "applied", attempts: 1 });
    expect(db.ledger.get(LEDGER_ID)?.status).toBe("delivered");
    // The duplicate was recognised at record time: no claim, no processing.
    expect(db.calls).toEqual(["record_email_provider_event"]);
  });

  it("is refused with 403 and reaches no database once it is outside the five-minute window", async () => {
    const captured = signedDelivery("msg_replay_late_01", event("email.bounced"));
    vi.setSystemTime(new Date("2026-10-24T01:06:06.000Z"));

    expect((await post(captured)).status).toBe(403);
    expect(db.admins).toBe(0);
    expect(db.calls).toEqual([]);
    expect(db.ledger.get(LEDGER_ID)?.status).toBe("accepted");
  });

  it("cannot dodge deduplication by re-labelling the svix-id: the signature covers it", async () => {
    const captured = signedDelivery("msg_replay_label_01", event("email.delivered"));
    expect((await post(captured)).status).toBe(200);

    const relabelled = { ...captured, headers: { ...captured.headers, "svix-id": "msg_replay_label_02" } };
    expect((await post(relabelled)).status).toBe(403);
    expect(receipts()).toHaveLength(1);
  });

  it("cannot be turned into a different event: a tampered body fails verification", async () => {
    const captured = signedDelivery("msg_replay_tamper_01", event("email.delivered"));
    const tampered = { ...captured, body: captured.body.replace("email.delivered", "email.bounced") };

    expect((await post(tampered)).status).toBe(403);
    expect(db.admins).toBe(0);
    expect(receipts()).toHaveLength(0);
    expect(db.ledger.get(LEDGER_ID)?.status).toBe("accepted");
  });

  it("is refused when signed with another endpoint's secret", async () => {
    const captured = signedDelivery("msg_replay_secret_01", event("email.delivered"));
    process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("a different endpoint").toString("base64")}`;

    expect((await post(captured)).status).toBe(403);
    expect(db.admins).toBe(0);
  });
});

describe("the provider's own retries", () => {
  it("recover a receipt whose processing failed, exactly once, after the failed attempt's claim expires", async () => {
    const id = "msg_retry_recover_01";
    const body = event("email.delivered");
    db.processFailures = 1;

    // First delivery: durable, but processing failed -> 500, provider retries.
    expect((await post(signedDelivery(id, body))).status).toBe(500);
    expect(receipts()).toEqual([expect.objectContaining({ state: "pending", attempts: 1 })]);
    expect(db.ledger.get(LEDGER_ID)?.status).toBe("accepted");

    // Resend's 5-second retry lands inside the two-minute claim -> 500 again.
    vi.setSystemTime(new Date("2026-10-24T01:00:10.000Z"));
    expect((await post(signedDelivery(id, body))).status).toBe(500);
    expect(receipts()[0]).toMatchObject({ state: "pending", attempts: 1 });

    // The 5-minute retry finds the claim expired, reclaims and applies it.
    vi.setSystemTime(new Date("2026-10-24T01:05:10.000Z"));
    expect((await post(signedDelivery(id, body))).status).toBe(200);
    expect(receipts()).toEqual([expect.objectContaining({ state: "applied", attempts: 2 })]);
    expect(db.ledger.get(LEDGER_ID)?.status).toBe("delivered");

    // A late duplicate of the same delivery is acknowledged and inert.
    vi.setSystemTime(new Date("2026-10-24T01:35:10.000Z"));
    expect((await post(signedDelivery(id, body))).status).toBe(200);
    expect(receipts()).toHaveLength(1);
  });

  it("stop at a bounded number of attempts: an always-failing receipt is quarantined and then acknowledged", async () => {
    const id = "msg_retry_poison_01";
    const body = event("email.delivered");
    db.processFailures = 100;

    let at = Date.parse("2026-10-24T01:00:05.000Z");
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      vi.setSystemTime(new Date(at));
      statuses.push((await post(signedDelivery(id, body, at))).status);
      at += 3 * 60 * 1000; // each retry lands after the previous claim expired
    }

    // Five counted attempts fail; the sixth delivery finds them spent and the
    // claim quarantines the receipt; the seventh finds it processed.
    expect(statuses).toEqual([500, 500, 500, 500, 500, 500, 200]);
    expect(receipts()).toEqual([expect.objectContaining({ state: "quarantined", attempts: 5 })]);
    expect(db.ledger.get(LEDGER_ID)?.status).toBe("accepted");
  });
});

describe("independent deliveries arriving out of order", () => {
  it("keep the ledger forward-only: a late `sent` after `delivered` is stale", async () => {
    expect((await post(signedDelivery("msg_order_delivered", event("email.delivered")))).status).toBe(200);
    expect((await post(signedDelivery("msg_order_sent", event("email.sent")))).status).toBe(200);

    expect(receipts().map((r) => r.state)).toEqual(["applied", "stale"]);
    expect(db.ledger.get(LEDGER_ID)?.status).toBe("delivered");
  });

  it("record an event for a row this deployment never created as unmatched, attributable to no studio", async () => {
    db.ledger.clear();
    expect((await post(signedDelivery("msg_order_foreign", event("email.delivered")))).status).toBe(200);
    expect(receipts()).toEqual([expect.objectContaining({ state: "unmatched" })]);
  });
});
