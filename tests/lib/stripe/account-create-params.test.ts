import { describe, expect, it } from "vitest";
import { connectedAccountCreateParams } from "@/lib/stripe/account-create-params";

// The Canadian account-creation payload is pinned byte-for-byte: Willow and Canada must not move.
const CA_PAYLOAD_AS_SENT_BEFORE_HON90 =
  '{"type":"express","country":"CA","capabilities":{"card_payments":{"requested":true},"transfers":{"requested":true}},"metadata":{"hone_studio_id":"11111111-1111-1111-1111-111111111111"}}';

describe("connectedAccountCreateParams", () => {
  it("CA: exactly the legacy Express payload, byte for byte (key order included)", () => {
    expect(JSON.stringify(connectedAccountCreateParams("CA", "11111111-1111-1111-1111-111111111111"))).toBe(CA_PAYLOAD_AS_SENT_BEFORE_HON90);
  });

  it("CA: no controller property is sent (the legacy `type` alone decides Dashboard, fee payer and loss liability)", () => {
    expect(connectedAccountCreateParams("CA", "s")).not.toHaveProperty("controller");
  });

  it("the studio id is the only studio-specific value", () => {
    expect(connectedAccountCreateParams("CA", "a")).toEqual({ ...connectedAccountCreateParams("CA", "b"), metadata: { hone_studio_id: "a" } });
  });
});

import { usAccountCreateParams } from "@/lib/stripe/account-create-params";

describe("usAccountCreateParams (Option A: Accounts v2, full Dashboard, Stripe-managed losses)", () => {
  const US_PAYLOAD =
    '{"identity":{"country":"us"},"dashboard":"full","defaults":{"currency":"usd","responsibilities":{"fees_collector":"stripe","losses_collector":"stripe"}},"configuration":{"merchant":{"capabilities":{"card_payments":{"requested":true}}}},"metadata":{"hone_studio_id":"11111111-1111-1111-1111-111111111111"}}';
  it("is exactly the payload verified against the US sandbox, byte for byte", () => {
    expect(JSON.stringify(usAccountCreateParams("11111111-1111-1111-1111-111111111111"))).toBe(US_PAYLOAD);
  });
  it("never asks Stripe to put losses on Hone, to use the Express Dashboard (refused with Stripe-managed losses), or to collect a Hone fee", () => {
    const p = usAccountCreateParams("s");
    expect(p.defaults.responsibilities.losses_collector).toBe("stripe");
    expect(p.dashboard).toBe("full");
    expect(p.defaults.responsibilities.fees_collector).toBe("stripe");
    expect(JSON.stringify(p)).not.toMatch(/express|application|transfers/);
  });
  it("the Canadian payload is unaffected by it (the CA function accepts only CA)", () => {
    expect(JSON.stringify(connectedAccountCreateParams("CA", "11111111-1111-1111-1111-111111111111"))).toBe(CA_PAYLOAD_AS_SENT_BEFORE_HON90);
  });
});
