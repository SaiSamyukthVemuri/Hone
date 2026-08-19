import { describe, expect, it, vi } from "vitest";
import {
  clientWaitlistIdempotencyKey,
  studioWaitlistIdempotencyKey,
  waitlistRequestDigest,
  IDEMPOTENCY_KEY_MAX,
  type WaitlistSubmission,
} from "@/lib/booking/new-client-waitlist";
import {
  sendWaitlistEmailIdempotent,
  type IdempotentEmailTransport,
} from "@/lib/email/new-client-waitlist-send";

// ===========================================================================
// DEFECT B — AMBIGUOUS PROVIDER TIMEOUT MUST NOT DUPLICATE THE RECORD
// ===========================================================================
//
// The predecessor sent with no idempotency key. Its timeout raced a promise it
// could not cancel, so a send could be reported failed and accepted moments
// later; a retry then produced a SECOND studio email and a SECOND client
// confirmation for one logical request, with no durable row to deduplicate on.
//
// These tests prove the key derivation is stable and injective, and that the
// send path retries the SAME key exactly once so the provider collapses the
// duplicate.

const STUDIO = "11111111-1111-4111-8111-111111111111";
const OTHER_STUDIO = "22222222-2222-4222-8222-222222222222";
const BASE: WaitlistSubmission = {
  name: "Ada Lovelace",
  email: "ada@example.test",
  phone: "+15555550100",
};

const digest = (studio: string, s: WaitlistSubmission) => waitlistRequestDigest(studio, s);

describe("idempotency key derivation", () => {
  it("the SAME canonical submission always yields the SAME studio key", () => {
    const a = studioWaitlistIdempotencyKey(digest(STUDIO, BASE));
    const b = studioWaitlistIdempotencyKey(digest(STUDIO, { ...BASE }));
    expect(a).toBe(b);
  });

  it("the SAME canonical submission always yields the SAME client key", () => {
    const a = clientWaitlistIdempotencyKey(digest(STUDIO, BASE));
    const b = clientWaitlistIdempotencyKey(digest(STUDIO, { ...BASE }));
    expect(a).toBe(b);
  });

  it("the studio key and the client key are DIFFERENT", () => {
    const d = digest(STUDIO, BASE);
    // Different recipient and different payload under one key is exactly what
    // the provider rejects as invalid_idempotent_request.
    expect(studioWaitlistIdempotencyKey(d)).not.toBe(clientWaitlistIdempotencyKey(d));
  });

  it("a changed name, email or phone yields a DIFFERENT key", () => {
    const base = studioWaitlistIdempotencyKey(digest(STUDIO, BASE));
    for (const changed of [
      { ...BASE, name: "Ada Lovelace Jr" },
      { ...BASE, email: "ada2@example.test" },
      { ...BASE, phone: "+15555550101" },
      { ...BASE, phone: null },
    ] as WaitlistSubmission[]) {
      expect(
        studioWaitlistIdempotencyKey(digest(STUDIO, changed)),
        `${JSON.stringify(changed)} must not reuse the base key`,
      ).not.toBe(base);
    }
  });

  it("a different studio yields a DIFFERENT key for identical personal details", () => {
    expect(studioWaitlistIdempotencyKey(digest(OTHER_STUDIO, BASE))).not.toBe(
      studioWaitlistIdempotencyKey(digest(STUDIO, BASE)),
    );
  });

  it("the canonical serialization is INJECTIVE — field contents cannot be shifted across boundaries", () => {
    // A naive separator-joined encoding would collide for these two: the
    // length-prefixed encoding must not.
    const a: WaitlistSubmission = { name: "ab", email: "c@d.co", phone: "ef" };
    const b: WaitlistSubmission = { name: "a", email: "bc@d.co", phone: "ef" };
    expect(digest(STUDIO, a)).not.toBe(digest(STUDIO, b));

    const withSeparators: WaitlistSubmission = {
      name: "x:1y",
      email: "z@e.co",
      phone: null,
    };
    const shifted: WaitlistSubmission = {
      name: "x",
      email: "1y@e.co",
      phone: "z",
    };
    expect(digest(STUDIO, withSeparators)).not.toBe(digest(STUDIO, shifted));
  });

  it("carries NO raw PII and stays within the provider key ceiling", () => {
    const d = digest(STUDIO, BASE);
    for (const key of [
      studioWaitlistIdempotencyKey(d),
      clientWaitlistIdempotencyKey(d),
    ]) {
      expect(key).not.toContain(BASE.name);
      expect(key).not.toContain(BASE.email);
      expect(key).not.toContain("Ada");
      expect(key).not.toContain("ada@");
      expect(key).not.toContain(BASE.phone as string);
      expect(key.length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_MAX);
      // versioned prefix + 64 hex chars
      expect(key).toMatch(/^hone-waitlist-(studio|client)-v1\/[0-9a-f]{64}$/);
    }
  });
});

// --- transport harness ------------------------------------------------------

type Attempt = { key: string | undefined; to: string };

function transportFrom(
  responses: Array<
    | { kind: "ok"; id?: string }
    | { kind: "error"; name: string }
    | { kind: "hang" }
    | { kind: "throw" }
  >,
): { transport: IdempotentEmailTransport; attempts: Attempt[] } {
  const attempts: Attempt[] = [];
  let i = 0;
  const transport: IdempotentEmailTransport = {
    emails: {
      send: async (payload, options) => {
        attempts.push({ key: options?.idempotencyKey, to: payload.to });
        const r = responses[Math.min(i++, responses.length - 1)];
        if (r.kind === "throw") throw new Error("network exploded");
        if (r.kind === "hang") return new Promise(() => {}); // never settles
        if (r.kind === "error") {
          return { data: null, error: { name: r.name, message: "provider said no" } };
        }
        return { data: r.id === undefined ? {} : { id: r.id }, error: null };
      },
    },
  };
  return { transport, attempts };
}

const send = (transport: IdempotentEmailTransport, key = "hone-waitlist-studio-v1/abc") =>
  sendWaitlistEmailIdempotent({
    to: "owner@studio.test",
    subject: "s",
    html: "<p>h</p>",
    text: "t",
    idempotencyKey: key,
    transport,
  });

describe("idempotent send — the key is actually transmitted", () => {
  it("passes the idempotency key to the provider on the first attempt", async () => {
    const { transport, attempts } = transportFrom([{ kind: "ok", id: "re_1" }]);
    const out = await send(transport);
    expect(out).toEqual({ status: "accepted", messageId: "re_1" });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].key).toBe("hone-waitlist-studio-v1/abc");
  });
});

describe("idempotent send — ambiguous first attempt retries with the SAME key", () => {
  it("TIMEOUT then acceptance: exactly one retry, identical key, one message id", async () => {
    vi.useFakeTimers();
    const { transport, attempts } = transportFrom([
      { kind: "hang" },
      { kind: "ok", id: "re_same" },
    ]);
    const promise = send(transport);
    await vi.advanceTimersByTimeAsync(15_001);
    const out = await promise;
    vi.useRealTimers();

    expect(out).toEqual({ status: "accepted", messageId: "re_same" });
    expect(attempts, "exactly one retry, never a loop").toHaveLength(2);
    // Assert the ACTUAL key on both attempts, not merely that they match:
    // two `undefined`s also "match", which is exactly the unprotected send
    // this whole mechanism exists to prevent.
    expect(attempts[0].key).toBe("hone-waitlist-studio-v1/abc");
    expect(
      attempts[1].key,
      "the retry MUST reuse the key or the provider cannot collapse it",
    ).toBe("hone-waitlist-studio-v1/abc");
    // One logical email: the provider replays the original under one key.
    expect(new Set(attempts.map((a) => a.key)).size).toBe(1);
  });

  it("NETWORK THROW then acceptance: same single retry with the same key", async () => {
    const { transport, attempts } = transportFrom([
      { kind: "throw" },
      { kind: "ok", id: "re_after_throw" },
    ]);
    const out = await send(transport);
    expect(out).toEqual({ status: "accepted", messageId: "re_after_throw" });
    expect(attempts).toHaveLength(2);
    expect(attempts[0].key).toBe("hone-waitlist-studio-v1/abc");
    expect(attempts[1].key).toBe("hone-waitlist-studio-v1/abc");
  });

  it("still ambiguous after the retry -> ambiguous, and NEVER an unbounded loop", async () => {
    const { transport, attempts } = transportFrom([{ kind: "throw" }, { kind: "throw" }]);
    const out = await send(transport);
    expect(out).toEqual({ status: "ambiguous", reason: "timeout" });
    expect(attempts, "bounded at exactly two attempts").toHaveLength(2);
  });

  it("concurrent_idempotent_requests is AMBIGUOUS, not a refusal", async () => {
    // A prior attempt under this key is still processing and may yet succeed.
    const { transport } = transportFrom([
      { kind: "error", name: "concurrent_idempotent_requests" },
      { kind: "error", name: "concurrent_idempotent_requests" },
    ]);
    const out = await send(transport);
    expect(out).toEqual({ status: "ambiguous", reason: "concurrent" });
  });

  it("acceptance with NO message id is AMBIGUOUS, never success", async () => {
    const { transport, attempts } = transportFrom([{ kind: "ok" }, { kind: "ok" }]);
    const out = await send(transport);
    expect(out).toEqual({ status: "ambiguous", reason: "no_message_id" });
    expect(attempts).toHaveLength(2);
  });

  it("an empty-string message id is treated as absent", async () => {
    const { transport } = transportFrom([{ kind: "ok", id: "   " }, { kind: "ok", id: "" }]);
    const out = await send(transport);
    expect(out.status).toBe("ambiguous");
  });
});

describe("idempotent send — definite refusals", () => {
  it("invalid_idempotent_request (same key, DIFFERENT payload) is a REFUSAL, never success", async () => {
    const { transport, attempts } = transportFrom([
      { kind: "error", name: "invalid_idempotent_request" },
    ]);
    const out = await send(transport);
    expect(out).toEqual({ status: "rejected", code: "invalid_idempotent_request" });
    expect(attempts, "a definite answer is not retried").toHaveLength(1);
  });

  it("an ordinary provider error is a refusal and is NOT retried", async () => {
    const { transport, attempts } = transportFrom([
      { kind: "error", name: "validation_error" },
    ]);
    const out = await send(transport);
    expect(out).toEqual({ status: "rejected", code: "validation_error" });
    expect(attempts).toHaveLength(1);
  });

  it("no transport configured, or an invalid recipient, refuses without calling out", async () => {
    const missing = await sendWaitlistEmailIdempotent({
      to: "owner@studio.test",
      subject: "s",
      html: "h",
      text: "t",
      idempotencyKey: "k",
      transport: null,
    });
    expect(missing).toEqual({ status: "rejected", code: "not_configured" });

    const { transport, attempts } = transportFrom([{ kind: "ok", id: "x" }]);
    const bad = await sendWaitlistEmailIdempotent({
      to: "not-an-email",
      subject: "s",
      html: "h",
      text: "t",
      idempotencyKey: "k",
      transport,
    });
    expect(bad).toEqual({ status: "rejected", code: "invalid_recipient" });
    expect(attempts).toEqual([]);
  });
});
