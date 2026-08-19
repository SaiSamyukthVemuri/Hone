import { describe, expect, it, vi } from "vitest";
import {
  sendWaitlistEmailIdempotent,
  waitlistIdempotencyKey,
  IDEMPOTENCY_KEY_MAX,
  type IdempotentEmailTransport,
  type ProviderPayload,
} from "@/lib/email/new-client-waitlist-send";
import {
  buildNewClientWaitlistStudioEmail,
  buildNewClientWaitlistClientEmail,
} from "@/lib/email/templates/new-client-waitlist";

// ===========================================================================
// THE IDEMPOTENCY KEY IDENTITY — tenant scope AND exact payload
// ===========================================================================
//
// Two consecutive defects in earlier attempts define these tests:
//
//   1. The key did not cover the full provider payload (a wall clock in the
//      body drifted while the key stayed fixed), so an honest resubmission was
//      refused as invalid_idempotent_request instead of collapsing.
//
//   2. A payload-only key did not cover TENANT identity. Neither
//      `studios.name` nor `studios.owner_email` is unique — only `slug` is — so
//      two distinct studio rows can render byte-identical operational emails.
//      Those two genuinely different requests shared a key, the provider
//      replayed the first message id, and the second submission reported
//      SUCCESS while producing no distinct record: a false success.
//
// The key is therefore:
//   <namespace> / <server-resolved studios.id> / SHA256(exact payload)

const STUDIO_A = "11111111-1111-4111-8111-111111111111";
const STUDIO_B = "22222222-2222-4222-8222-222222222222";
const FROM = "Hone <hello@hone.care>";
const SHARED_OWNER = "chloe@example.test";

/** The exact payload the action hands the sender for a studio notification. */
function studioPayload(over: Partial<{
  studioName: string; name: string; email: string; phone: string | null; to: string;
}> = {}): ProviderPayload {
  const built = buildNewClientWaitlistStudioEmail({
    studioName: over.studioName ?? "Willow Electrolysis",
    name: over.name ?? "Ada Lovelace",
    email: over.email ?? "ada@example.test",
    phone: over.phone === undefined ? "+15555550100" : over.phone,
  });
  return { from: FROM, to: over.to ?? SHARED_OWNER, ...built };
}

describe("tenant scope — the defect that killed the previous vehicle", () => {
  it("TWO studios with identical name, identical owner email and an identical visitor get DIFFERENT keys", () => {
    // Neither studios.name nor studios.owner_email is unique; only slug is. So
    // this configuration is reachable, and the payloads really are identical.
    const payloadA = studioPayload({ studioName: "Willow Electrolysis", to: SHARED_OWNER });
    const payloadB = studioPayload({ studioName: "Willow Electrolysis", to: SHARED_OWNER });
    expect(payloadB, "precondition: the rendered payloads are byte-identical").toEqual(payloadA);

    const keyA = waitlistIdempotencyKey("studio", STUDIO_A, payloadA);
    const keyB = waitlistIdempotencyKey("studio", STUDIO_B, payloadB);
    expect(
      keyB,
      "two distinct studios must never share a key, or the provider replays the first send and the second reports a FALSE SUCCESS",
    ).not.toBe(keyA);
  });

  it("the tenant component is present and is the studio id", () => {
    const key = waitlistIdempotencyKey("studio", STUDIO_A, studioPayload());
    expect(key).toContain(STUDIO_A);
    expect(key).toMatch(
      /^hone-waitlist-(studio|client)-v2\/[0-9a-f-]{36}\/[0-9a-f]{64}$/,
    );
  });

  it("SAME studio + SAME payload => SAME key", () => {
    expect(waitlistIdempotencyKey("studio", STUDIO_A, studioPayload())).toBe(
      waitlistIdempotencyKey("studio", STUDIO_A, studioPayload()),
    );
  });

  it("SAME studio + ANY changed payload field => DIFFERENT key", () => {
    const base = studioPayload();
    const baseKey = waitlistIdempotencyKey("studio", STUDIO_A, base);
    const mutations: Array<[string, ProviderPayload]> = [
      ["from", { ...base, from: "Other <other@hone.care>" }],
      ["to", { ...base, to: "someone.else@studio.test" }],
      ["subject", { ...base, subject: `${base.subject} ` }],
      ["html", { ...base, html: `${base.html}<!-- x -->` }],
      ["text", { ...base, text: `${base.text}\\n` }],
    ];
    for (const [field, payload] of mutations) {
      expect(
        waitlistIdempotencyKey("studio", STUDIO_A, payload),
        `changing ${field} must change the key`,
      ).not.toBe(baseKey);
    }
  });

  it("a studio RENAME or RECIPIENT change changes the payload and therefore the key", () => {
    const base = waitlistIdempotencyKey("studio", STUDIO_A, studioPayload());
    expect(
      waitlistIdempotencyKey("studio", STUDIO_A, studioPayload({ studioName: "Willow Studio" })),
    ).not.toBe(base);
    expect(
      waitlistIdempotencyKey("studio", STUDIO_A, studioPayload({ to: "new-owner@studio.test" })),
    ).not.toBe(base);
  });

  it("changed submitter details change the key", () => {
    const base = waitlistIdempotencyKey("studio", STUDIO_A, studioPayload());
    for (const over of [
      { name: "Ada Lovelace Jr" },
      { email: "ada2@example.test" },
      { phone: "+15555550101" },
      { phone: null },
    ]) {
      expect(
        waitlistIdempotencyKey("studio", STUDIO_A, studioPayload(over)),
        JSON.stringify(over),
      ).not.toBe(base);
    }
  });
});

describe("payload determinism — the defect before that", () => {
  it("an identical resubmission at ANY wall-clock time renders identical bytes and one key", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00Z"));
    const first = studioPayload();
    vi.setSystemTime(new Date("2026-08-19T10:47:31Z"));
    const later = studioPayload();
    vi.setSystemTime(new Date("2027-03-02T23:59:59Z"));
    const muchLater = studioPayload();
    vi.useRealTimers();

    expect(later).toEqual(first);
    expect(muchLater).toEqual(first);
    expect(waitlistIdempotencyKey("studio", STUDIO_A, later)).toBe(
      waitlistIdempotencyKey("studio", STUDIO_A, first),
    );
  });

  it("the studio notice carries no wall clock at all", () => {
    const p = studioPayload();
    expect(p.text).not.toMatch(/Joined:/i);
    expect(p.html).not.toMatch(/Joined:/i);
    expect(p.text).not.toMatch(/20\d\d/);
  });
});

describe("namespaces, encoding and hygiene", () => {
  it("studio and client namespaces never collide, even at the same tenant and payload", () => {
    const p = studioPayload();
    expect(waitlistIdempotencyKey("client", STUDIO_A, p)).not.toBe(
      waitlistIdempotencyKey("studio", STUDIO_A, p),
    );
    const clientBuilt = buildNewClientWaitlistClientEmail({
      studioName: "Willow Electrolysis",
      name: "Ada Lovelace",
    });
    const clientPayload: ProviderPayload = {
      from: FROM, to: "ada@example.test", ...clientBuilt,
    };
    expect(waitlistIdempotencyKey("client", STUDIO_A, clientPayload)).not.toBe(
      waitlistIdempotencyKey("studio", STUDIO_A, p),
    );
  });

  it("the canonical serialization is INJECTIVE — content cannot shift across boundaries", () => {
    const a: ProviderPayload = { from: "f", to: "ab", subject: "c", html: "d", text: "e" };
    const b: ProviderPayload = { from: "f", to: "a", subject: "bc", html: "d", text: "e" };
    expect(waitlistIdempotencyKey("studio", STUDIO_A, a)).not.toBe(
      waitlistIdempotencyKey("studio", STUDIO_A, b),
    );
    const withSep: ProviderPayload = { from: "f", to: "x:1y", subject: "z", html: "h", text: "t" };
    const shifted: ProviderPayload = { from: "f", to: "x", subject: "1yz", html: "h", text: "t" };
    expect(waitlistIdempotencyKey("studio", STUDIO_A, withSep)).not.toBe(
      waitlistIdempotencyKey("studio", STUDIO_A, shifted),
    );
  });

  it("carries NO raw PII and stays within the provider key ceiling", () => {
    const p = studioPayload();
    for (const ns of ["studio", "client"] as const) {
      const key = waitlistIdempotencyKey(ns, STUDIO_A, p);
      expect(key).not.toContain("Ada");
      expect(key).not.toContain("ada@example.test");
      expect(key).not.toContain("+15555550100");
      expect(key).not.toContain(SHARED_OWNER);
      expect(key).not.toContain("Willow");
      expect(key.length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_MAX);
    }
  });
});

// --- transport harness ------------------------------------------------------

type Attempt = { key: string | undefined; payload: unknown };

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
        attempts.push({ key: options?.idempotencyKey, payload: { ...payload } });
        const r = responses[Math.min(i++, responses.length - 1)];
        if (r.kind === "throw") throw new Error("network exploded");
        if (r.kind === "hang") return new Promise(() => {});
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
  studioId: STUDIO_A,
  to: SHARED_OWNER,
  subject: "s",
  html: "<p>h</p>",
  text: "t",
};
/** Independently computed: what the sender MUST derive for SEND_ARGS. */
const EXPECTED_KEY = waitlistIdempotencyKey("studio", STUDIO_A, {
  from: FROM, to: SEND_ARGS.to, subject: SEND_ARGS.subject, html: SEND_ARGS.html, text: SEND_ARGS.text,
});

const send = (transport: IdempotentEmailTransport, over: Record<string, unknown> = {}) =>
  sendWaitlistEmailIdempotent({ ...SEND_ARGS, ...over, transport });

describe("the sender derives the key it transmits", () => {
  it("sends the tenant-scoped payload-derived key on the first attempt", async () => {
    const { transport, attempts } = transportFrom([{ kind: "ok", id: "re_1" }]);
    expect(await send(transport)).toEqual({ status: "accepted", messageId: "re_1" });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].key).toBe(EXPECTED_KEY);
  });

  it("a different studioId with the SAME payload produces a different transmitted key", async () => {
    const { transport, attempts } = transportFrom([{ kind: "ok", id: "re_1" }]);
    await send(transport);
    await send(transport, { studioId: STUDIO_B });
    expect(attempts).toHaveLength(2);
    expect(attempts[1].key).not.toBe(attempts[0].key);
    expect(attempts[1].payload).toEqual(attempts[0].payload);
  });

  it("refuses to send at all without a tenant scope, rather than minting an unscoped key", async () => {
    const { transport, attempts } = transportFrom([{ kind: "ok", id: "x" }]);
    expect(await send(transport, { studioId: "" })).toEqual({
      status: "rejected",
      code: "missing_tenant_scope",
    });
    expect(attempts).toEqual([]);
  });
});

describe("ambiguous first attempt retries with the SAME key and payload", () => {
  it("TIMEOUT then acceptance: exactly one retry, identical key, identical payload", async () => {
    vi.useFakeTimers();
    const { transport, attempts } = transportFrom([{ kind: "hang" }, { kind: "ok", id: "re_same" }]);
    const promise = send(transport);
    await vi.advanceTimersByTimeAsync(15_001);
    const out = await promise;
    vi.useRealTimers();

    expect(out).toEqual({ status: "accepted", messageId: "re_same" });
    expect(attempts, "exactly one retry, never a loop").toHaveLength(2);
    expect(attempts[0].key).toBe(EXPECTED_KEY);
    expect(attempts[1].key).toBe(EXPECTED_KEY);
    expect(attempts[1].payload).toEqual(attempts[0].payload);
  });

  it("NETWORK THROW then acceptance: same single retry, same key", async () => {
    const { transport, attempts } = transportFrom([{ kind: "throw" }, { kind: "ok", id: "re_x" }]);
    expect(await send(transport)).toEqual({ status: "accepted", messageId: "re_x" });
    expect(attempts).toHaveLength(2);
    expect(attempts[0].key).toBe(EXPECTED_KEY);
    expect(attempts[1].key).toBe(EXPECTED_KEY);
  });

  it("still ambiguous after the retry -> ambiguous, and never an unbounded loop", async () => {
    const { transport, attempts } = transportFrom([{ kind: "throw" }, { kind: "throw" }]);
    expect(await send(transport)).toEqual({ status: "ambiguous", reason: "timeout" });
    expect(attempts).toHaveLength(2);
  });

  it("concurrent_idempotent_requests is AMBIGUOUS, not a refusal", async () => {
    const { transport } = transportFrom([
      { kind: "error", name: "concurrent_idempotent_requests" },
      { kind: "error", name: "concurrent_idempotent_requests" },
    ]);
    expect(await send(transport)).toEqual({ status: "ambiguous", reason: "concurrent" });
  });

  it("acceptance with NO message id is AMBIGUOUS, never success", async () => {
    const { transport, attempts } = transportFrom([{ kind: "ok" }, { kind: "ok" }]);
    expect(await send(transport)).toEqual({ status: "ambiguous", reason: "no_message_id" });
    expect(attempts).toHaveLength(2);
  });

  it("an empty-string message id is treated as absent", async () => {
    const { transport } = transportFrom([{ kind: "ok", id: "   " }, { kind: "ok", id: "" }]);
    expect((await send(transport)).status).toBe("ambiguous");
  });
});

describe("definite refusals", () => {
  it("invalid_idempotent_request (same key, DIFFERENT payload) is a REFUSAL, never success", async () => {
    const { transport, attempts } = transportFrom([
      { kind: "error", name: "invalid_idempotent_request" },
    ]);
    expect(await send(transport)).toEqual({
      status: "rejected",
      code: "invalid_idempotent_request",
    });
    expect(attempts, "a definite answer is not retried").toHaveLength(1);
  });

  it("an ordinary provider error is a refusal and is NOT retried", async () => {
    const { transport, attempts } = transportFrom([{ kind: "error", name: "validation_error" }]);
    expect(await send(transport)).toEqual({ status: "rejected", code: "validation_error" });
    expect(attempts).toHaveLength(1);
  });

  it("no transport, or an invalid recipient, refuses without calling out", async () => {
    expect(await sendWaitlistEmailIdempotent({ ...SEND_ARGS, transport: null })).toEqual({
      status: "rejected",
      code: "not_configured",
    });
    const { transport, attempts } = transportFrom([{ kind: "ok", id: "x" }]);
    expect(await send(transport, { to: "not-an-email" })).toEqual({
      status: "rejected",
      code: "invalid_recipient",
    });
    expect(attempts).toEqual([]);
  });
});
