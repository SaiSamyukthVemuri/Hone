import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBillingInvoices, readBillingProfile } from "@/lib/subscriptions/billing-overview";

const stripe = new Stripe("sk_test_local_fixture");
const customer = { id: "cus_1", livemode: false, invoice_settings: { default_payment_method: null },
  tax_ids: { data: [{ customer: "cus_1", livemode: false, value: "001234567", type: "us_ein" }] } };
const method = { type: "card", customer: "cus_1", livemode: false,
  card: { brand: "visa", last4: "4242", exp_month: 3, exp_year: 2030 } };
const sub = { id: "sub_1", customer: "cus_1", livemode: false, default_payment_method: method,
  status: "active", items: { data: [{ current_period_end: 1900000000 }] }, collection_method: "charge_automatically" };
const invoice = { id: "in_1", customer: "cus_1", livemode: false, parent: { subscription_details: { subscription: "sub_1" } },
  currency: "usd", total: 4900, amount_remaining: 0, status: "paid", created: 1800000000, effective_at: null,
  invoice_pdf: "https://pay.stripe.com/invoice/demo/pdf", hosted_invoice_url: "https://invoice.stripe.com/i/demo" };

describe("owner billing overview", () => {
  beforeEach(() => {
    vi.spyOn(Object.getPrototypeOf(stripe.customers), "retrieve").mockResolvedValue(customer);
    vi.spyOn(Object.getPrototypeOf(stripe.subscriptions), "retrieve").mockResolvedValue(sub);
    vi.spyOn(Object.getPrototypeOf(stripe.invoices), "list").mockResolvedValue({ data: [invoice], has_more: false });
  });
  afterEach(() => vi.restoreAllMocks());
  const profile = () => readBillingProfile(stripe, customer.id, sub.id);
  it("returns only masked identifiers and the effective card and renewal", async () => {
    expect(await profile()).toEqual({ hasMethod: true, card: { brand: "visa", last4: "4242", expires: "03/2030" },
      ends: null, renews: 1900000000, taxIds: [{ type: "US EIN", last4: "4567" }] });
    const getSub = vi.mocked(Object.getPrototypeOf(stripe.subscriptions).retrieve);
    getSub.mockResolvedValue({ ...sub, default_payment_method: null, default_source: "card_legacy", cancel_at_period_end: true });
    expect(await profile()).toMatchObject({ hasMethod: true, card: null, ends: 1900000000, renews: null });
    getSub.mockResolvedValue({ ...sub, default_payment_method: null, status: "past_due" });
    const getCustomer = vi.mocked(Object.getPrototypeOf(stripe.customers).retrieve);
    getCustomer.mockResolvedValue({ ...customer, invoice_settings: { default_payment_method: method } });
    expect(await profile()).toMatchObject({ card: { last4: "4242" }, renews: null });
  });
  it("rejects mismatched profile ownership or live data", async () => {
    const getSub = vi.mocked(Object.getPrototypeOf(stripe.subscriptions).retrieve);
    for (const patch of [{ customer: "cus_other" }, { livemode: true }, { default_payment_method: { ...method, customer: "cus_other" } }]) {
      getSub.mockResolvedValue({ ...sub, ...patch });
      await expect(profile()).rejects.toThrow("Unexpected");
    }
  });
  it("paginates inside the studio subscription and exposes only finalized documents from Stripe", async () => {
    const list = vi.mocked(Object.getPrototypeOf(stripe.invoices).list);
    list.mockResolvedValue({ data: [invoice, { ...invoice, id: "in_2", status: "draft" },
      { ...invoice, id: "in_3", status: "open", amount_remaining: 4900, invoice_pdf: "https://other.example/pdf" }], has_more: true });
    const page = await readBillingInvoices(stripe, customer.id, sub.id, "in_last");
    expect(list).toHaveBeenCalledWith({ customer: "cus_1", subscription: "sub_1", starting_after: "in_last", limit: 6 });
    expect(page.rows.map(row => row.id)).toEqual(["in_1", "in_3"]);
    expect(page.rows[0].pdf).toBe(invoice.invoice_pdf);
    expect(page.rows[1]).toMatchObject({ pdf: null, payable: true });
    expect(page.next).toBe("in_3");
    for (const patch of [{ livemode: true }, { customer: "cus_other" }, { parent: { subscription_details: { subscription: "sub_other" } } }]) {
      list.mockResolvedValue({ data: [{ ...invoice, ...patch }], has_more: false });
      await expect(readBillingInvoices(stripe, customer.id, sub.id)).rejects.toThrow();
    }
  });
});
