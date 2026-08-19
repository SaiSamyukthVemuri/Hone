import { describe, expect, it, vi } from "vitest";
import {
  sendWaitlistEmailIdempotent,
  waitlistIdempotencyKey,
  IDEMPOTENCY_KEY_MAX,
  type IdempotentEmailTransport,
} from "@/lib/email/new-client-waitlist-send";
import {
  buildNewClientWaitlistStudioEmail,
  buildNewClientWaitlistClientEmail,
} from "@/lib/email/templates/new-client-waitlist";

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

const FROM = "Hone <hello@hone.care>";
const STUDIO_TO = "owner@studio.test";

type Payload = { from: string; to: string; subject: string; html: string; text: string };

/** The exact payload the action hands the sender for a studio notification. */
function studioPayload(over: Partial<{
  studioName: string; name: string; email: string; phone: string | null; to: string;
}> = {}): Payload {
  const built = buildNewClientWaitlistStudioEmail({
    studioName: over.studioName ?? "Willow Electrolysis",
    name: over.name ?? "Ada Lovelace",
    email: over.email ?? "ada@example.test",
    phone: over.phone === undefined ? "+15555550100" : over.phone,
  });
  return { from: FROM, to: over.to ?? STUDIO_TO, ...built };
}

describe("the design invariant: same key <=> byte-identical payload", () => {
  it("the key is a pure function of the payload, so an identical resubmission at ANY wall-clock time collapses", () => {
    // The defect this replaces: the body carried a minute-resolution timestamp
    // that the key did not cover, so a resubmit a minute later presented the
    // SAME key with DIFFERENT bytes — which the provider rejects outright.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00Z"));
    const first = studioPayload();
    vi.setSystemTime(new Date("2026-08-19T10:47:31Z")); // >1 minute later
    const later = studioPayload();
    vi.setSystemTime(new Date("2027-03-02T23:59:59Z")); // a year later
    const muchLater = studioPayload();
    vi.useRealTimers();

    expect(later, "the rendered payload must not vary with the clock").toEqual(first);
    expect(muchLater).toEqual(first);
    expect(waitlistIdempotencyKey("studio", later)).toBe(waitlistIdempotencyKey("studio", first));
    expect(waitlistIdempotencyKey("studio", muchLater)).toBe(waitlistIdempotencyKey("studio", first));
  });

  it("carries no wall clock at all in the rendered studio notice", () => {
    const p = studioPayload();
    expect(p.text).not.toMatch(/Joined:/i);
    expect(p.html).not.toMatch(/Joined:/i);
    // No year-like token anywhere in the body.
    expect(p.text).not.toMatch(/20\d\d/);
  });

  it("the same payload always yields the same key", () => {
    expect(waitlistIdempotencyKey("studio", studioPayload())).toBe(
      waitlistIdempotencyKey("studio", studioPayload()),
    );
  });

  it("ANY provider-payload field changing changes the key", () => {
    const base = studioPayload();
    const baseKey = waitlistIdempotencyKey("studio", base);
    const mutations: Array<[string, Payload]> = [
      ["from", { ...base, from: "Other <other@hone.care>" }],
      ["to", { ...base, to: "someone.else@studio.test" }],
      ["subject", { ...base, subject: `${base.subject} ` }],
      ["html", { ...base, html: `${base.html}<!-- x -->` }],
      ["text", { ...base, text: `${base.text}\n` }],
    ];
    for (const [field, payload] of mutations) {
      expect(
        waitlistIdempotencyKey("studio", payload),
        `changing ${field} must change the key`,
      ).not.toBe(baseKey);
    }
  });

  it("a STUDIO NAME change changes the rendered payload and therefore the key", () => {
    // The old design keyed on form fields only, so a rename would have kept
    // the key while changing the subject line — the same latent failure.
    const renamed = studioPayload({ studioName: "Willow Electrolysis Studio" });
    expect(renamed.subject).not.toBe(studioPayload().subject);
    expect(waitlistIdempotencyKey("studio", renamed)).not.toBe(
      waitlistIdempotencyKey("studio", studioPayload()),
    );
  });

  it("a STUDIO RECIPIENT change changes the key", () => {
    expect(
      waitlistIdempotencyKey("studio", studioPayload({ to: "new-owner@studio.test" })),
    ).not.toBe(waitlistIdempotencyKey("studio", studioPayload()));
  });

  it("changed submitter details change the rendered payload and the key", () => {
    const base = waitlistIdempotencyKey("studio", studioPayload());
    for (const over of [
      { name: "Ada Lovelace Jr" },
      { email: "ada2@example.test" },
      { phone: "+15555550101" },
      { phone: null },
    ]) {
      expect(
        waitlistIdempotencyKey("studio", studioPayload(over)),
        JSON.stringify(over),
      ).not.toBe(base);
    }
  });

  it("the studio and client namespaces never collide, even for an identical payload", () => {
    const p = studioPayload();
    expect(waitlistIdempotencyKey("client", p)).not.toBe(waitlistIdempotencyKey("studio", p));
    // And in the real pairing the payloads differ too.
    const clientBuilt = buildNewClientWaitlistClientEmail({
      studioName: "Willow Electrolysis",
      name: "Ada Lovelace",
    });
    const clientPayload: Payload = { from: FROM, to: "ada@example.test", ...clientBuilt };
    expect(waitlistIdempotencyKey("client", clientPayload)).not.toBe(
      waitlistIdempotencyKey("studio", p),
    );
  });

  it("the canonical serialization is INJECTIVE — content cannot shift across field boundaries", () => {
    const a: Payload = { from: "f", to: "ab", subject: "c", html: "d", text: "e" };
    const b: Payload = { from: "f", to: "a", subject: "bc", html: "d", text: "e" };
    expect(waitlistIdempotencyKey("studio", a)).not.toBe(waitlistIdempotencyKey("studio", b));
    const withSep: Payload = { from: "f", to: "x:1y", subject: "z", html: "h", text: "t" };
    const shifted: Payload = { from: "f", to: "x", subject: "1yz", html: "h", text: "t" };
    expect(waitlistIdempotencyKey("studio", withSep)).not.toBe(
      waitlistIdempotencyKey("studio", shifted),
    );
  });

  it("carries NO raw PII and stays within the provider key ceiling", () => {
    const p = studioPayload();
    for (const ns of ["studio", "client"] as const) {
      const key = waitlistIdempotencyKey(ns, p);
      expect(key).not.toContain("Ada");
      expect(key).not.toContain("ada@example.test");
      expect(key).not.toContain("+15555550100");
      expect(key).not.toContain("owner@studio.test");
      expect(key).not.toContain("Willow");
      expect(key.length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_MAX);
      expect(key).toMatch(/^hone-waitlist-(studio|client)-v1\/[0-9a-f]{64}$/);
    }
  });
});

// --- transport harness ------------------------------------------------------

type Attempt = { key: string | undefined; to: string; payload: unknown };

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
        attempts.push({ key: options?.idempotencyKey, to: payload.to, payload: { ...payload } });
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

const SEND_ARGS = {
  namespace: "studio" as const,
  to: "owner@studio.test",
  subject: "s",
  html: "<p>h</p>",
  text: "t",
};
/** The key the sender MUST derive for SEND_ARGS. Computed independently here. */
const EXPECTED_KEY = waitlistIdempotencyKey("studio", { from: FROM, ...SEND_ARGS });

const send = (transport: IdempotentEmailTransport) =>
  sendWaitlistEmailIdempotent({ ...SEND_ARGS, transport });

describe("idempotent send — the key is actually transmitted", () => {
  it("passes the idempotency key to the provider on the first attempt", async () => {
    const { transport, attempts } = transportFrom([{ kind: "ok", id: "re_1" }]);
    const out = await send(transport);
    expect(out).toEqual({ status: "accepted", messageId: "re_1" });
    expect(attempts).toHaveLength(1);
    // Derived from the payload actually transmitted, not supplied by the caller.
    expect(attempts[0].key).toBe(EXPECTED_KEY);
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
    expect(attempts[0].key).toBe(EXPECTED_KEY);
    expect(
      attempts[1].key,
      "the retry MUST reuse the key or the provider cannot collapse it",
    ).toBe(EXPECTED_KEY);
    // ...and the identical payload, so the key/payload pairing holds on the retry.
    expect(attempts[1].payload).toEqual(attempts[0].payload);
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
    expect(attempts[0].key).toBe(EXPECTED_KEY);
    expect(attempts[1].key).toBe(EXPECTED_KEY);
    expect(attempts[1].payload).toEqual(attempts[0].payload);
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
    const missing = await sendWaitlistEmailIdempotent({ ...SEND_ARGS, transport: null });
    expect(missing).toEqual({ status: "rejected", code: "not_configured" });

    const { transport, attempts } = transportFrom([{ kind: "ok", id: "x" }]);
    const bad = await sendWaitlistEmailIdempotent({
      ...SEND_ARGS,
      to: "not-an-email",
      transport,
    });
    expect(bad).toEqual({ status: "rejected", code: "invalid_recipient" });
    expect(attempts).toEqual([]);
  });
});
