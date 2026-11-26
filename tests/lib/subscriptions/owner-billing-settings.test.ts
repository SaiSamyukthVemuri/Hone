import Stripe from "stripe";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SubscriptionPage from "@/app/(app)/settings/subscription/page";
import { loadOlderInvoices, openOwnerBilling, payOutstandingInvoice, updateBillingCard } from "@/app/(app)/settings/subscription/actions";
import { SETTINGS_NAV } from "@/lib/settings/nav-registry";
import { resolveSettingsNavWithReachable } from "@/lib/settings/nav";
import type { Studio } from "@/lib/types/database";

const h = vi.hoisted(() => ({
  rpc: vi.fn(), actor: vi.fn(), portal: vi.fn(), invoice: vi.fn(),
  profile: vi.fn(), invoices: vi.fn(), taxEdit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/queries", () => ({ requirePractitionerWithStudio: h.actor }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/subscriptions/billing-client", () => ({
  createBillingStripeClient: () => ({ ownerPortal: h.portal, readNoticeInvoice: h.invoice, billingProfile: h.profile, billingInvoices: h.invoices, canEditTaxId: h.taxEdit }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error("redirect " + url); },
  notFound: () => { throw new Error("404"); },
}));

const studio = { id: "studio-1", name: "Example Studio", timezone: "America/Toronto" } as Studio;
const billing = {
  plan: "studio", customer: "cus_1", subscription: "sub_1",
  invoice: "in_1", status: "past_due", deadline: "2026-12-07T15:00:00Z",
};
const invoice = { live: false, id: "in_1", customer: "cus_1", subscription: "sub_1",
  status: "open", amountRemaining: 9900, hostedUrl: "https://invoice.stripe.com/i/example" };
const path = "/settings/subscription";
const page = async () => renderToStaticMarkup(await SubscriptionPage({ searchParams: Promise.resolve({}) }));
const nav = (role: "owner" | "practitioner") => resolveSettingsNavWithReachable(
  SETTINGS_NAV.filter(entry => entry.id === "subscription"), { studio, role },
);
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "true");
  vi.stubEnv("HONE_BILLING_PORTAL_CONFIGURATION", "bpc_test");
  vi.stubEnv("NEXT_PUBLIC_APP_ORIGIN", "https://hone.example.test");
  h.actor.mockResolvedValue({ studio, practitioner: { role: "owner" } });
  h.rpc.mockResolvedValue({ data: billing });
  h.portal.mockResolvedValue("https://billing.stripe.com/p/session/test");
  h.invoice.mockResolvedValue(invoice);
  h.profile.mockResolvedValue({ hasMethod: true, card: { brand: "visa", last4: "4242", expires: "12/2030" }, taxIds: [], renews: 1798200000, ends: null });
  h.invoices.mockResolvedValue({ rows: [], next: null });
  h.taxEdit.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

it("lists Billing for subscribed owners, including paused owners, and shows local deadlines", async () => {
  expect((await nav("owner")).items.map(i => i.label)).toEqual(["Billing"]);
  const overdue = await page();
  for (const label of ["Studio plan", "US$99 per month", "Payment overdue", "10:00", "EST", "Update card", "Pay outstanding invoice", "View invoices and receipts"]) {
    expect(overdue).toContain(label);
  }
  h.rpc.mockResolvedValue({ data: { ...billing, status: "paused" } });
  expect((await nav("owner")).items).toHaveLength(1);
  expect(await page()).toContain("Access paused");
  h.rpc.mockResolvedValue({ data: { ...billing, plan: "solo", status: "active", deadline: null, invoice: null } });
  const active = await page();
  for (const label of ["Solo plan", "US$49 per month", "Active", "no receptionist", "Update card"]) expect(active).toContain(label);
  expect(active).not.toContain("Pay outstanding invoice");
});

it("never mistakes a failed ledger read for an active subscription", async () => {
  h.rpc.mockResolvedValue({ data: null, error: { code: "503" } });
  expect((await nav("owner")).items).toHaveLength(1);
  expect(await page()).toContain("couldn’t load your subscription");
  await expect(openOwnerBilling(studio.id)).rejects.toThrow(path + "?error=billing");
  expect(h.portal).not.toHaveBeenCalled();
});

it("keeps unsubscribed studios and disabled or unauthorized sessions out", async () => {
  h.rpc.mockResolvedValue({ data: null });
  expect(await nav("owner")).toEqual({ items: [], reachable: [] });
  await expect(page()).rejects.toThrow("404");
  h.rpc.mockClear();
  for (const role of ["practitioner", "receptionist"]) {
    h.actor.mockResolvedValue({ studio, practitioner: { role } });
    expect(await page()).toContain("This page is for the studio owner");
    for (const action of [updateBillingCard, payOutstandingInvoice, openOwnerBilling]) {
      await expect(action(studio.id)).rejects.toThrow("redirect /settings");
    }
  }
  expect(await nav("practitioner")).toEqual({ items: [], reachable: [] });
  h.actor.mockResolvedValue({ studio, practitioner: { role: "owner" } });
  await expect(payOutstandingInvoice("stale-studio")).rejects.toThrow("redirect /settings");
  vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "false");
  expect(await nav("owner")).toEqual({ items: [], reachable: [] });
  await expect(page()).rejects.toThrow("404");
  await expect(updateBillingCard(studio.id)).rejects.toThrow("redirect /settings");
  expect(h.rpc).not.toHaveBeenCalled();
  expect(h.portal).not.toHaveBeenCalled();
  expect(h.invoice).not.toHaveBeenCalled();
});

it("opens the signed-in studio's Stripe card flow and invoice history separately", async () => {
  for (const [action, flow] of [[updateBillingCard, { subscription: billing.subscription }], [openOwnerBilling, undefined]] as const) {
    await expect(action(studio.id)).rejects.toThrow("redirect https://billing.stripe.com/");
    expect(h.portal).toHaveBeenLastCalledWith(billing.customer, "https://hone.example.test" + path, "bpc_test", flow);
  }
  expect(h.rpc).toHaveBeenCalledWith("my_hone_billing_status", { p_studio: studio.id });
});

it("opens the verified invoice, only while it has a payable balance", async () => {
  await expect(payOutstandingInvoice(studio.id)).rejects.toThrow("redirect " + invoice.hostedUrl);
  expect(h.invoice).toHaveBeenCalledWith(billing.invoice);
  for (const patch of [{ live: true }, { id: "in_other" }, { customer: "cus_other" },
    { subscription: "sub_other" }, { amountRemaining: 0 }, { status: "void" },
    { hostedUrl: "https://invoice.stripe.com.evil.test/" }, { hostedUrl: null }, { hostedUrl: "invalid" }]) {
    h.invoice.mockResolvedValue({ ...invoice, ...patch });
    await expect(payOutstandingInvoice(studio.id)).rejects.toThrow(path + "?error=invoice");
  }
  h.invoice.mockResolvedValue({ ...invoice, status: "paid", amountRemaining: 0 });
  await expect(payOutstandingInvoice(studio.id)).rejects.toThrow(path + "?notice=settling");
  h.invoice.mockRejectedValue(new Error("unavailable"));
  await expect(payOutstandingInvoice(studio.id)).rejects.toThrow(path + "?error=invoice");
  h.rpc.mockResolvedValue({ data: { ...billing, invoice: null } });
  h.invoice.mockClear();
  await expect(payOutstandingInvoice(studio.id)).rejects.toThrow("redirect " + path);
  expect(h.invoice).not.toHaveBeenCalled();
});

it("creates the Stripe update-card deep link with a return to Hone and uses a normal portal for history", async () => {
  const { createBillingStripeClient } = await vi.importActual<typeof import("@/lib/subscriptions/billing-client")>(
    "@/lib/subscriptions/billing-client",
  );
  const key = "sk_test_local_fixture";
  const sdk = new Stripe(key);
  const create = vi.spyOn(Object.getPrototypeOf(sdk.billingPortal.sessions), "create")
    .mockResolvedValue({ url: "https://billing.stripe.com/p/session/test" });
  const sub = { id: "sub_1", customer: "cus_1", livemode: false };
  const retrieve = vi.spyOn(Object.getPrototypeOf(sdk.subscriptions), "retrieve")
    .mockResolvedValue(sub);
  const client = createBillingStripeClient({ HONE_BILLING_STRIPE_SECRET_KEY: key });
  const returnUrl = "https://hone.example.test" + path;
  const options = { customer: "cus_1", configuration: "bpc_test", return_url: returnUrl };
  try {
    await client.ownerPortal("cus_1", returnUrl, "bpc_test", { subscription: "sub_1" });
    expect(create).toHaveBeenLastCalledWith({
      ...options,
      flow_data: { type: "payment_method_update", after_completion: { type: "redirect", redirect: { return_url: returnUrl } } },
    });
    retrieve.mockResolvedValue({ ...sub, default_payment_method: "pm_existing" });
    await client.ownerPortal("cus_1", returnUrl, "bpc_test", { subscription: "sub_1" });
    expect(create).toHaveBeenLastCalledWith(options);
    retrieve.mockResolvedValue({ ...sub, customer: "cus_other" });
    await expect(client.ownerPortal("cus_1", returnUrl, "bpc_test", { subscription: "sub_1" }))
      .rejects.toThrow("Unexpected billing subscription");
    expect(create).toHaveBeenCalledTimes(2);
    retrieve.mockClear();
    await client.ownerPortal("cus_1", returnUrl, "bpc_test");
    expect(retrieve).not.toHaveBeenCalled();
    expect(create).toHaveBeenLastCalledWith(options);
  } finally {
    retrieve.mockRestore();
    create.mockRestore();
  }
});


it("shows the renewal, masked card, editable tax ID and real invoice links for an active studio", async () => {
  h.rpc.mockResolvedValue({ data: { ...billing, status: "active", invoice: null } });
  h.invoices.mockResolvedValue({ rows: [{ id: "in_paid", date: 1795600000, total: 9900, currency: "usd",
    status: "paid", pdf: "https://pay.stripe.com/invoice/example/pdf", hosted: null, payable: false }], next: "in_paid" });
  const html = await page();
  for (const label of ["Renews December", "4242", "12/2030", "Add tax ID", "US$99.00", "Download PDF", "Load more", "Change tier", "Cancel subscription now"]) expect(html).toContain(label);
  h.profile.mockResolvedValue({ hasMethod: false, taxIds: [], renews: null, ends: 1798200000 });
  h.taxEdit.mockResolvedValue(false);
  const ending = await page();
  expect(ending).toContain("Scheduled to end");
  expect(ending).toContain("Add card");
  expect(ending).toContain("Cancel subscription now");
  expect(ending).not.toContain("Change tier");
  expect(ending).not.toContain("Add tax ID");
});

it("keeps billing recovery reachable if Stripe's inline details fail independently", async () => {
  h.invoices.mockRejectedValue(new Error("unavailable"));
  const historyOffline = await page();
  expect(historyOffline).toContain("Invoice history is temporarily unavailable");
  expect(historyOffline).toContain("4242");
  h.profile.mockRejectedValue(new Error("unavailable"));
  const offline = await page();
  expect(offline).toContain("Card details are temporarily unavailable");
  expect(offline).toContain("Pay outstanding invoice");
  expect(offline).not.toContain("No payment method on file");
});

it("scopes each page of older invoices to the current studio owner and billing subscription", async () => {
  await loadOlderInvoices(studio.id, "in_last");
  expect(h.invoices).toHaveBeenCalledWith("cus_1", "sub_1", "in_last");
  h.invoices.mockClear();
  expect(await loadOlderInvoices(studio.id, "unrecognized")).toBeNull();
  await expect(loadOlderInvoices("other", "in_last")).rejects.toThrow("redirect /settings");
  h.actor.mockResolvedValue({ studio, practitioner: { role: "receptionist" } });
  await expect(loadOlderInvoices(studio.id, "in_last")).rejects.toThrow("redirect /settings");
  expect(h.invoices).not.toHaveBeenCalled();
});

it("replaces the single Stripe item at renewal pricing and cancels immediately, scoped to its owner and customer", async () => {
  const { createBillingStripeClient } = await vi.importActual<typeof import("@/lib/subscriptions/billing-client")>("@/lib/subscriptions/billing-client");
  const key = "sk_test_local";
  const sdk = new Stripe(key);
  const client = createBillingStripeClient({HONE_BILLING_STRIPE_SECRET_KEY:key, HONE_STRIPE_PRICE_SOLO:"price_solo", HONE_STRIPE_PRICE_STUDIO:"price_studio"});
  const change = {id:"op_1", user:"owner", attempt:"purchase", plan:"solo", target:"studio", subscription:"sub_1", customer:"cus_1"} as const;
  const metadata = {hone_user_id:"owner",hone_attempt_id:"purchase",hone_plan:"solo"};
  const sub = {id:"sub_1",customer:"cus_1",livemode:false,status:"active",metadata,items:{data:[{id:"si_1",quantity:1,price:{id:"price_solo",livemode:false}}]}};
  const retrieve = vi.spyOn(Object.getPrototypeOf(sdk.subscriptions),"retrieve").mockResolvedValue(sub);
  const cancelNow = vi.spyOn(Object.getPrototypeOf(sdk.subscriptions),"cancel").mockResolvedValue({...sub,status:"canceled"});
  const update = vi.spyOn(Object.getPrototypeOf(sdk.subscriptions),"update").mockResolvedValue({...sub,metadata:{...metadata,hone_plan:"studio"},items:{data:[{price:{id:"price_studio"}}]}});
  const price = vi.spyOn(Object.getPrototypeOf(sdk.prices),"retrieve").mockResolvedValue({id:"price_studio",livemode:false,active:true,currency:"usd",type:"recurring",unit_amount:9900,recurring:{interval:"month",interval_count:1}});
  try {
    expect(await client.applyOwnerChange(change)).toBe("applied");
    expect(update).toHaveBeenCalledWith("sub_1",{items:[{id:"si_1",quantity:1,price:"price_studio"}],metadata:{hone_plan:"studio"},proration_behavior:"none",payment_behavior:"error_if_incomplete"},{idempotencyKey:"hone-tier-op_1"});
    expect(await client.applyOwnerChange({...change,target:"cancel"})).toBe("canceled");
    expect(cancelNow).toHaveBeenCalledWith("sub_1",{invoice_now:false,prorate:false});
    retrieve.mockResolvedValue({...sub,status:"canceled"});
    expect(await client.applyOwnerChange({...change,target:"cancel"})).toBe("canceled");
    retrieve.mockResolvedValue({...sub,customer:"cus_other"});
    await expect(client.applyOwnerChange({...change,target:"cancel"})).rejects.toThrow("Unexpected billing subscription");
    expect(cancelNow).toHaveBeenCalledTimes(1);
  } finally { retrieve.mockRestore(); cancelNow.mockRestore(); update.mockRestore(); price.mockRestore(); }
});

it("retains billing and invoice history after voluntary cancellation", async () => {
  h.rpc.mockResolvedValue({data:{...billing,status:"canceled",invoice:null}});
  const html = await page();
  expect(html).toContain("Studio access is paused");
  expect(html).toContain("View invoices and receipts");
  for (const text of ["Renews December", "Change tier", "Cancel subscription now"]) expect(html).not.toContain(text);
});
