import { describe, expect, it } from "vitest";
import { buildCardChangeNotification } from "@/lib/billing/card-change-notification";

// Chloe's card-change notification CONTENT contract + privacy proof. The
// builder is pure; the DB determination of isReplacement and the durable write
// are covered by the .db.test.ts + source-guard tests.

const CLIENT_ID = "11111111-1111-1111-1111-111111111111";

describe("buildCardChangeNotification — first add (card_added)", () => {
  const out = buildCardChangeNotification({
    clientName: "Jane Doe",
    brand: "visa",
    last4: "4242",
    isReplacement: false,
    clientId: CLIENT_ID,
  });

  it("uses the added event type + title", () => {
    expect(out.eventType).toBe("card_added");
    expect(out.title).toBe("Card added on file");
  });

  it("body is exactly '<name> added <brand> ending in <last4>.'", () => {
    expect(out.body).toBe("Jane Doe added visa ending in 4242.");
  });

  it("href deep-links to the client's overview tab", () => {
    expect(out.href).toBe(`/clients/${CLIENT_ID}?tab=overview`);
  });
});

describe("buildCardChangeNotification — replacement (card_replaced)", () => {
  const out = buildCardChangeNotification({
    clientName: "Jane Doe",
    brand: "mastercard",
    last4: "4444",
    isReplacement: true,
    clientId: CLIENT_ID,
  });

  it("uses the replaced event type + title", () => {
    expect(out.eventType).toBe("card_replaced");
    expect(out.title).toBe("Card replaced on file");
  });

  it("body is exactly '<name> replaced the card on file with <brand> ending in <last4>.'", () => {
    expect(out.body).toBe(
      "Jane Doe replaced the card on file with mastercard ending in 4444.",
    );
  });

  it("href deep-links to the client's overview tab", () => {
    expect(out.href).toBe(`/clients/${CLIENT_ID}?tab=overview`);
  });
});

describe("privacy — body/title/href carry only name + brand + last4", () => {
  // Simulate a rich card context and assert none of the forbidden fields can
  // leak into the rendered notification. The builder only receives name/brand/
  // last4/clientId, so this is a structural guarantee, verified here.
  const FORBIDDEN = [
    "4242424242424242", // full PAN
    "exp",
    "12/2030",
    "2030",
    "pm_123", // PaymentMethod id
    "cus_123", // customer id
    "seti_123", // SetupIntent id
    "evt_123", // event id
    "sig_123", // authorization signature id
    "jane@example.com", // email
    "+15555550123", // phone
  ];

  for (const isReplacement of [false, true]) {
    it(`no forbidden field appears (isReplacement=${isReplacement})`, () => {
      const out = buildCardChangeNotification({
        clientName: "Jane Doe",
        brand: "visa",
        last4: "4242",
        isReplacement,
        clientId: CLIENT_ID,
      });
      const blob = `${out.title}\n${out.body}\n${out.href}`;
      for (const f of FORBIDDEN) {
        expect(blob).not.toContain(f);
      }
      // last4 IS allowed; the full PAN is not — assert the body shows only 4242
      // and never a longer digit run.
      expect(out.body).toMatch(/\b4242\b/);
      expect(out.body).not.toMatch(/\d{5,}/);
    });
  }
});
