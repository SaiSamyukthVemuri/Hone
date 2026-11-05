import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { Resend } from "resend";

import {
  EMAIL_LEDGER_TAG,
  SIGNATURE_TOLERANCE_SECONDS,
  normalizeResendEvent,
  providerCodeSlug,
  verifyResendWebhookSignature,
} from "@/lib/email/resend-webhook";

// ===========================================================================
// DELIVERY-EVENTS-01 — Resend webhook signature verification and payload
// minimisation, with synthetic fixtures only (no provider, no network).
//
// Every signature below is computed the way Svix signs (HMAC-SHA256 over
// `${id}.${timestamp}.${body}`, keyed with the base64 secret after `whsec_`),
// and the official Resend SDK verifier is run on the same fixtures as an
// oracle. The hand-rolled check must agree with it on every accept and every
// refusal.
// ===========================================================================

const SECRET = `whsec_${Buffer.from("delivery-events-01 synthetic signing secret").toString("base64")}`;
const OTHER_SECRET = `whsec_${Buffer.from("a different synthetic secret").toString("base64")}`;
const DELIVERY_ID = "msg_2qSyntheticDeliveryId0001";
const EMAIL_ID = "56761188-7520-42d8-8898-ff6fc54ce618";
const LEDGER_ID = "0b8f1c1e-6a52-4c0e-9f3e-2f6c3c1a7d10";
const RECIPIENT = "client.private@example.test";
const SUBJECT = "Your appointment tomorrow at 10:00";

function body(type: string, data: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type,
    created_at: "2026-10-11T18:30:00.000Z",
    data: {
      created_at: "2026-10-11T18:29:59.000Z",
      email_id: EMAIL_ID,
      from: "Hone <hello@hone.care>",
      to: [RECIPIENT],
      subject: SUBJECT,
      message_id: "<synthetic-123@mail.example.test>",
      tags: { [EMAIL_LEDGER_TAG]: LEDGER_ID, category: "reminder" },
      ...data,
    },
  });
}

function signature(secret: string, id: string, ts: number, raw: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${crypto.createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64")}`;
}

function headers(values: Record<string, string | undefined>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(values)) if (v !== undefined) h.set(k, v);
  return h;
}

function signed(raw: string, opts: { ts?: number; id?: string; secret?: string; sig?: string } = {}) {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const id = opts.id ?? DELIVERY_ID;
  return {
    ts,
    headers: headers({
      "svix-id": id,
      "svix-timestamp": String(ts),
      "svix-signature": opts.sig ?? signature(opts.secret ?? SECRET, id, ts, raw),
    }),
  };
}

const now = () => Math.floor(Date.now() / 1000);

describe("signature verification", () => {
  it("accepts a correctly signed delivery and returns its delivery id", () => {
    const raw = body("email.delivered");
    const { headers: h } = signed(raw);
    expect(verifyResendWebhookSignature({ secret: SECRET, headers: h, rawBody: raw, nowSeconds: now() })).toEqual({
      ok: true,
      deliveryId: DELIVERY_ID,
    });
  });

  it("refuses a body changed after signing, by one byte", () => {
    const raw = body("email.delivered");
    const { headers: h } = signed(raw);
    const tampered = raw.replace("email.delivered", "email.delivereD");
    expect(
      verifyResendWebhookSignature({ secret: SECRET, headers: h, rawBody: tampered, nowSeconds: now() }),
    ).toEqual({ ok: false, reason: "no_matching_signature" });
  });

  it("refuses a delivery signed with another secret", () => {
    const raw = body("email.bounced");
    const { headers: h } = signed(raw, { secret: OTHER_SECRET });
    expect(
      verifyResendWebhookSignature({ secret: SECRET, headers: h, rawBody: raw, nowSeconds: now() }),
    ).toEqual({ ok: false, reason: "no_matching_signature" });
  });

  it("binds the delivery id: a valid signature cannot be moved to another id", () => {
    const raw = body("email.delivered");
    const ts = now();
    const sig = signature(SECRET, DELIVERY_ID, ts, raw);
    const h = headers({ "svix-id": "msg_someOtherDelivery", "svix-timestamp": String(ts), "svix-signature": sig });
    expect(verifyResendWebhookSignature({ secret: SECRET, headers: h, rawBody: raw, nowSeconds: ts })).toEqual({
      ok: false,
      reason: "no_matching_signature",
    });
  });

  it("binds the timestamp: a valid signature cannot be re-dated", () => {
    const raw = body("email.delivered");
    const ts = now();
    const sig = signature(SECRET, DELIVERY_ID, ts - 10, raw);
    const h = headers({ "svix-id": DELIVERY_ID, "svix-timestamp": String(ts), "svix-signature": sig });
    expect(verifyResendWebhookSignature({ secret: SECRET, headers: h, rawBody: raw, nowSeconds: ts })).toEqual({
      ok: false,
      reason: "no_matching_signature",
    });
  });

  it.each(["svix-id", "svix-timestamp", "svix-signature"])("refuses a delivery missing %s", (name) => {
    const raw = body("email.delivered");
    const { headers: h } = signed(raw);
    h.delete(name);
    expect(verifyResendWebhookSignature({ secret: SECRET, headers: h, rawBody: raw, nowSeconds: now() })).toEqual({
      ok: false,
      reason: "missing_headers",
    });
  });

  it("refuses a non-numeric timestamp and a delivery id outside the stored shape", () => {
    const raw = body("email.delivered");
    const ts = now();
    const sig = signature(SECRET, DELIVERY_ID, ts, raw);
    expect(
      verifyResendWebhookSignature({
        secret: SECRET,
        headers: headers({ "svix-id": DELIVERY_ID, "svix-timestamp": "soon", "svix-signature": sig }),
        rawBody: raw,
        nowSeconds: ts,
      }),
    ).toEqual({ ok: false, reason: "malformed_timestamp" });
    expect(
      verifyResendWebhookSignature({
        secret: SECRET,
        headers: headers({ "svix-id": "msg with spaces", "svix-timestamp": String(ts), "svix-signature": sig }),
        rawBody: raw,
        nowSeconds: ts,
      }),
    ).toEqual({ ok: false, reason: "malformed_delivery_id" });
  });

  describe("replay window", () => {
    const raw = body("email.delivered");

    it("accepts exactly at the tolerance, in both directions", () => {
      for (const skew of [-SIGNATURE_TOLERANCE_SECONDS, SIGNATURE_TOLERANCE_SECONDS]) {
        const ts = 1_800_000_000;
        const { headers: h } = signed(raw, { ts });
        expect(
          verifyResendWebhookSignature({ secret: SECRET, headers: h, rawBody: raw, nowSeconds: ts + skew }).ok,
        ).toBe(true);
      }
    });

    it("refuses a captured delivery replayed after the window, and one dated in the future", () => {
      const ts = 1_800_000_000;
      const { headers: h } = signed(raw, { ts });
      for (const skew of [SIGNATURE_TOLERANCE_SECONDS + 1, -(SIGNATURE_TOLERANCE_SECONDS + 1), 86_400]) {
        expect(
          verifyResendWebhookSignature({ secret: SECRET, headers: h, rawBody: raw, nowSeconds: ts + skew }),
        ).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
      }
    });

    it("lets a replay INSIDE the window through the signature layer: deduplication is the receipt's job", () => {
      // The same signed request twice is indistinguishable here by design;
      // record_email_provider_event's unique delivery id is what stops it
      // being applied twice (tests/db/email-delivery-events.db.test.ts).
      const { headers: h, ts } = signed(raw);
      const first = verifyResendWebhookSignature({ secret: SECRET, headers: h, rawBody: raw, nowSeconds: ts });
      const second = verifyResendWebhookSignature({ secret: SECRET, headers: h, rawBody: raw, nowSeconds: ts + 30 });
      expect(first).toEqual(second);
      expect(first.ok).toBe(true);
    });
  });

  it("accepts any one matching v1 signature during secret rotation, and ignores other versions", () => {
    const raw = body("email.delivered");
    const ts = now();
    const good = signature(SECRET, DELIVERY_ID, ts, raw);
    const stale = signature(OTHER_SECRET, DELIVERY_ID, ts, raw);
    const rotated = headers({
      "svix-id": DELIVERY_ID,
      "svix-timestamp": String(ts),
      "svix-signature": `${stale} ${good}`,
    });
    expect(verifyResendWebhookSignature({ secret: SECRET, headers: rotated, rawBody: raw, nowSeconds: ts }).ok).toBe(
      true,
    );
    const wrongVersion = headers({
      "svix-id": DELIVERY_ID,
      "svix-timestamp": String(ts),
      "svix-signature": good.replace(/^v1,/, "v2,"),
    });
    expect(
      verifyResendWebhookSignature({ secret: SECRET, headers: wrongVersion, rawBody: raw, nowSeconds: ts }),
    ).toEqual({ ok: false, reason: "no_matching_signature" });
  });

  it("refuses everything when the configured secret is not usable", () => {
    const raw = body("email.delivered");
    const { headers: h } = signed(raw);
    for (const secret of ["whsec_", "whsec_not base64!"]) {
      expect(verifyResendWebhookSignature({ secret, headers: h, rawBody: raw, nowSeconds: now() })).toEqual({
        ok: false,
        reason: "unusable_secret",
      });
    }
  });

  it("reads the Standard Webhooks header names when the svix- ones are absent", () => {
    const raw = body("email.delivered");
    const ts = now();
    const h = headers({
      "webhook-id": DELIVERY_ID,
      "webhook-timestamp": String(ts),
      "webhook-signature": signature(SECRET, DELIVERY_ID, ts, raw),
    });
    expect(verifyResendWebhookSignature({ secret: SECRET, headers: h, rawBody: raw, nowSeconds: ts }).ok).toBe(true);
  });
});

describe("the official Resend SDK verifier agrees on every fixture", () => {
  // Oracle only. The route never constructs a Resend client to verify: that
  // would tie webhook verification to the sending API key.
  const oracle = new Resend("re_synthetic_oracle_only").webhooks;

  function sdkAccepts(raw: string, id: string, ts: string, sig: string): boolean {
    try {
      oracle.verify({ payload: raw, headers: { id, timestamp: ts, signature: sig }, webhookSecret: SECRET });
      return true;
    } catch {
      return false;
    }
  }

  const raw = body("email.delivered");
  const ts = now();
  const good = signature(SECRET, DELIVERY_ID, ts, raw);
  const cases: Array<[string, string, string, string, string]> = [
    ["valid", raw, DELIVERY_ID, String(ts), good],
    ["tampered body", raw.replace("delivered", "bounced"), DELIVERY_ID, String(ts), good],
    ["other secret", raw, DELIVERY_ID, String(ts), signature(OTHER_SECRET, DELIVERY_ID, ts, raw)],
    ["moved id", raw, "msg_moved", String(ts), good],
    ["rotation pair", raw, DELIVERY_ID, String(ts), `${signature(OTHER_SECRET, DELIVERY_ID, ts, raw)} ${good}`],
    ["expired", raw, DELIVERY_ID, String(ts - 3600), signature(SECRET, DELIVERY_ID, ts - 3600, raw)],
    ["future", raw, DELIVERY_ID, String(ts + 3600), signature(SECRET, DELIVERY_ID, ts + 3600, raw)],
  ];

  it.each(cases)("%s", (_label, payload, id, timestamp, sig) => {
    const ours = verifyResendWebhookSignature({
      secret: SECRET,
      headers: headers({ "svix-id": id, "svix-timestamp": timestamp, "svix-signature": sig }),
      rawBody: payload,
      nowSeconds: Math.floor(Date.now() / 1000),
    }).ok;
    expect(ours).toBe(sdkAccepts(payload, id, timestamp, sig));
  });
});

describe("normalizeResendEvent keeps the minimum and nothing else", () => {
  it("keeps type, email id, ledger tag, event time and reason codes", () => {
    const event = normalizeResendEvent(
      DELIVERY_ID,
      body("email.bounced", {
        bounce: {
          message: `550 5.1.1 <${RECIPIENT}>: Recipient address rejected: User unknown`,
          subType: "General",
          type: "Permanent",
        },
      }),
    );
    expect(event).toEqual({
      deliveryId: DELIVERY_ID,
      eventType: "email.bounced",
      providerEmailId: EMAIL_ID,
      honeMessageId: LEDGER_ID,
      providerCreatedAt: "2026-10-11T18:30:00.000Z",
      bounceType: "permanent",
      bounceSubtype: "general",
      failureReason: null,
      suppressionType: null,
    });
  });

  it("drops the recipient, sender, subject, message id, other tags and the bounce message", () => {
    const event = normalizeResendEvent(
      DELIVERY_ID,
      body("email.bounced", { bounce: { message: `rejected ${RECIPIENT}`, type: "Permanent" } }),
    );
    const kept = JSON.stringify(event);
    for (const secret of [RECIPIENT, SUBJECT, "hello@hone.care", "synthetic-123", "reminder", "rejected"]) {
      expect(kept).not.toContain(secret);
    }
  });

  it("normalises failure and suppression codes to slugs", () => {
    expect(normalizeResendEvent(DELIVERY_ID, body("email.failed", { failed: { reason: "reached_daily_quota" } })).failureReason).toBe(
      "reached_daily_quota",
    );
    expect(
      normalizeResendEvent(DELIVERY_ID, body("email.suppressed", { suppressed: { type: "OnAccountSuppressionList", message: "x" } }))
        .suppressionType,
    ).toBe("on_account_suppression_list");
  });

  it("turns any code that is not a plain identifier into `other`, so free text can never leak as a slug", () => {
    expect(providerCodeSlug("Recipient address rejected")).toBe("other");
    expect(providerCodeSlug(RECIPIENT)).toBe("other");
    expect(providerCodeSlug("x".repeat(80))).toBe("other");
    expect(providerCodeSlug(42)).toBe("other");
    expect(providerCodeSlug(undefined)).toBeNull();
    expect(providerCodeSlug("NoEmail")).toBe("no_email");
    expect(providerCodeSlug("MailboxFull")).toBe("mailbox_full");
  });

  it("reads the ledger tag from either tag shape, and only when it is a uuid", () => {
    const pairs = normalizeResendEvent(
      DELIVERY_ID,
      body("email.delivered", { tags: [{ name: "category", value: "x" }, { name: EMAIL_LEDGER_TAG, value: LEDGER_ID.toUpperCase() }] }),
    );
    expect(pairs.honeMessageId).toBe(LEDGER_ID);
    expect(normalizeResendEvent(DELIVERY_ID, body("email.delivered", { tags: { [EMAIL_LEDGER_TAG]: "not-a-uuid" } })).honeMessageId).toBeNull();
    expect(normalizeResendEvent(DELIVERY_ID, body("email.delivered", { tags: undefined })).honeMessageId).toBeNull();
  });

  it("keeps an id that is not a uuid out of the provider email id", () => {
    expect(normalizeResendEvent(DELIVERY_ID, body("email.delivered", { email_id: "fake-resend-message-id" })).providerEmailId).toBeNull();
  });

  it("records a body that is not a usable event as `malformed` rather than refusing it", () => {
    for (const raw of ["not json", "[]", "null", JSON.stringify({ type: "Email Delivered" }), JSON.stringify({ data: {} })]) {
      const event = normalizeResendEvent(DELIVERY_ID, raw);
      expect(event.eventType).toBe("malformed");
      expect(event.deliveryId).toBe(DELIVERY_ID);
      expect(event.providerEmailId).toBeNull();
    }
  });

  it("keeps an unknown but well-formed type as sent, for the database to quarantine", () => {
    expect(normalizeResendEvent(DELIVERY_ID, body("inbox.thread.created")).eventType).toBe("inbox.thread.created");
  });

  it("drops an event time it cannot read", () => {
    const raw = JSON.stringify({ type: "email.sent", created_at: "yesterday", data: { email_id: EMAIL_ID } });
    expect(normalizeResendEvent(DELIVERY_ID, raw).providerCreatedAt).toBeNull();
  });
});
