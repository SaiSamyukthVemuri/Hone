import { describe, expect, it, vi } from "vitest";
import {
  deliverSubscriptionNotice,
  subscriptionEmail,
  type Notice,
} from "@/lib/subscriptions/notice-email";
import {
  ENV_ON,
  SOLO_PRICE,
  STUDIO_PRICE,
} from "./helpers/fake-billing-client";

const notice: Notice = {
  id: "test",
  lease: "lease",
  kind: "receipt",
  invoice_id: "in_1",
  customer_id: "cus_1",
  subscription_id: "sub_1",
  recipient: "owner@example.test",
  timezone: "America/Toronto",
  deadline: "2026-12-02T15:30:00.000Z",
};
const invoice = {
  id: "in_1",
  customer: "cus_1",
  subscription: "sub_1",
  live: false,
  status: "paid" as const,
  number: "HONE-0042",
  currency: "usd",
  amountPaid: 4900,
  total: 4900,
  subtotal: 4900,
  tax: 0,
  amountRemaining: 0,
  paidAt: 1795611600,
  price: SOLO_PRICE,
  period: { start: 1795611600, end: 1798203600 },
  hostedUrl: "https://invoice.stripe.com/i/example",
};
const billingUrl = "https://hone.example.test/settings/subscription";
const from = "Hone <billing@example.test>";
const unpaid = {
  ...invoice,
  status: "open" as const,
  amountRemaining: 4900,
  amountPaid: 0,
};
const inputs = () => ({
  env: ENV_ON,
  readInvoice: vi.fn(async () => invoice),
  authorize: vi.fn(async () => true),
  finish: vi.fn(async () => true),
  send: vi.fn(async () => ({ data: { id: "email_1" }, error: null })),
  billingUrl,
  from,
});

describe("owner subscription email", () => {
  it.each([
    [SOLO_PRICE, "Solo", 4900],
    [STUDIO_PRICE, "Studio", 9900],
  ] as const)("renders real invoice values for %s", (price, label, base) => {
    const result = subscriptionEmail(
      notice,
      {
        ...invoice,
        price,
        subtotal: base,
        tax: 350,
        total: base + 350,
        amountPaid: base + 350,
      },
      ENV_ON,
      billingUrl,
      from,
    )!;
    expect(result.to).toBe(notice.recipient);
    for (const value of [
      label,
      "HONE-0042",
      "Billing period",
      "Paid on",
      "3.50",
      ((base + 350) / 100).toFixed(2),
      invoice.hostedUrl,
      "download PDFs",
      billingUrl,
    ])
      expect(result.text).toContain(value);
  });
  it("warns with the exact local deadline, and makes paused access and recovery explicit", () => {
    for (const kind of ["warning", "paused"] as const) {
      const mail = subscriptionEmail(
        { ...notice, kind },
        unpaid,
        ENV_ON,
        billingUrl,
        from,
      )!;
      expect(mail.text).toContain("Dec 2, 2026");
      expect(mail.text).toContain("10:30");
      expect(mail.text).toContain("EST");
      expect(mail.text).toContain(
        kind === "warning" ? "keep using Hone" : "view your records",
      );
      expect(mail.text).toContain("Pay invoice");
    }
  });
  it("skips a paid or void invoice before a late failure notice", () => {
    for (const status of ["paid", "void"] as const)
      expect(
        subscriptionEmail(
          { ...notice, kind: "paused" },
          { ...invoice, status },
          ENV_ON,
          billingUrl,
          from,
        ),
      ).toBeNull();
  });
  it("refuses another account, subscription or invoice and live data", () => {
    for (const patch of [
      { customer: "other" },
      { subscription: "other" },
      { id: "other" },
      { live: true },
    ]) {
      expect(() =>
        subscriptionEmail(
          notice,
          { ...invoice, ...patch },
          ENV_ON,
          billingUrl,
          from,
        ),
      ).toThrow();
    }
  });
  it("uses trusted billing links if the hosted invoice URL is missing or foreign", () => {
    for (const hostedUrl of [
      null,
      "https://invoice.stripe.com.example.test/i",
    ]) {
      const mail = subscriptionEmail(
        notice,
        { ...invoice, hostedUrl },
        ENV_ON,
        billingUrl,
        from,
      )!;
      expect(mail.html).toContain(billingUrl);
      expect(mail.html).not.toContain("stripe.com.example");
    }
  });
  it("uses a stable key, rechecks eligibility, requires provider acceptance and persistence", async () => {
    const ports = inputs();
    ports.authorize.mockResolvedValueOnce(false);
    expect(await deliverSubscriptionNotice(notice, ports)).toBe("skipped");
    expect(ports.send).not.toHaveBeenCalled();
    ports.finish.mockResolvedValueOnce(false);
    await expect(deliverSubscriptionNotice(notice, ports)).rejects.toThrow();
    expect(await deliverSubscriptionNotice(notice, ports)).toBe("accepted");
    expect(ports.send.mock.calls[0]).toEqual(ports.send.mock.calls[1]);
    expect(ports.authorize.mock.calls[0]).toEqual(
      ports.authorize.mock.calls[2],
    );
  });
});
