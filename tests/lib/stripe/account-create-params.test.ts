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
