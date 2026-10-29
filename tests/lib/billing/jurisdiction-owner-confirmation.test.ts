import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const rpc = vi.fn();
const read = vi.fn();
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ rpc }) }));
vi.mock("@/lib/billing/payment-jurisdiction-server", () => ({
  getStudioPaymentJurisdiction: (...a: unknown[]) => read(...a),
}));

import {
  confirmStudioJurisdictionAsOwner,
  OWNER_CONFIRMATION_ENV,
} from "@/lib/billing/jurisdiction-owner-confirmation";

const base = { studioId: "s1", practitionerId: "p1", country: "US", currency: "usd", confirmed: true };

beforeEach(() => {
  rpc.mockReset();
  read.mockReset();
  read.mockResolvedValue({ ok: false, reason: "missing" });
  process.env[OWNER_CONFIRMATION_ENV] = "true";
});
afterEach(() => {
  delete process.env[OWNER_CONFIRMATION_ENV];
});

const reply = (out_result: string) => rpc.mockResolvedValue({ data: [{ out_result }], error: null });

describe("owner jurisdiction confirmation (Gate A)", () => {
  it("is default-off: no read, no write", async () => {
    delete process.env[OWNER_CONFIRMATION_ENV];
    const r = await confirmStudioJurisdictionAsOwner(base);
    expect(r.ok).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("saves through the existing command with owner actor, reason and reference", async () => {
    reply("initialized");
    const r = await confirmStudioJurisdictionAsOwner({ ...base, now: new Date("2026-11-01T00:00:00Z") });
    expect(r).toEqual({ ok: true, outcome: "confirmed" });
    expect(rpc).toHaveBeenCalledWith("set_studio_payment_jurisdiction", {
      p_studio_id: "s1",
      p_payment_country: "US",
      p_payment_currency: "usd",
      p_actor: "owner:p1",
      p_reason: "owner onboarding confirmation",
      p_acknowledge_configured_prices: false,
      p_verification_reference: "owner-confirmed:p1:2026-11-01T00:00:00.000Z:US/usd",
    });
  });

  it.each([
    [{ country: "", currency: "usd" }],
    [{ country: "US", currency: "" }],
    [{ country: "US", currency: "cad" }],
    [{ country: "GB", currency: "gbp" }],
    [{ confirmed: false }],
  ])("refuses without a call: %j", async (patch) => {
    const r = await confirmStudioJurisdictionAsOwner({ ...base, ...patch });
    expect(r.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an identical stored pair is already confirmed and writes nothing", async () => {
    read.mockResolvedValue({ ok: true, jurisdiction: { country: "US", currency: "usd" } });
    expect(await confirmStudioJurisdictionAsOwner(base)).toEqual({ ok: true, outcome: "already_confirmed" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a different stored pair is never overwritten", async () => {
    read.mockResolvedValue({ ok: true, jurisdiction: { country: "CA", currency: "cad" } });
    const r = await confirmStudioJurisdictionAsOwner(base);
    expect(r.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(["read_failed", "invalid"])("an unreadable stored row (%s) writes nothing", async (reason) => {
    read.mockResolvedValue({ ok: false, reason });
    expect((await confirmStudioJurisdictionAsOwner(base)).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    "refused_payment_account",
    "refused_monetary_history",
    "refused_priced_configuration",
    "invalid_input",
    "verification_required",
    "not_found",
    "changed",
  ])("command result %s is a refusal, not success", async (code) => {
    reply(code);
    expect((await confirmStudioJurisdictionAsOwner(base)).ok).toBe(false);
  });

  it("PEER C2: refused_priced_configuration names prices, not payment history or a Stripe account", async () => {
    reply("refused_priced_configuration");
    const r = await confirmStudioJurisdictionAsOwner(base);
    expect(r.ok).toBe(false);
    const msg = (r as { error: string }).error;
    expect(msg).toMatch(/prices/i);
    expect(msg).not.toMatch(/payment history|Stripe account/i);
    // the account / history refusals keep their own message
    for (const code of ["refused_payment_account", "refused_monetary_history"]) {
      reply(code);
      expect(((await confirmStudioJurisdictionAsOwner(base)) as { error: string }).error).toMatch(/payment history or a Stripe account/);
    }
  });

  it("unchanged from the command is already confirmed", async () => {
    reply("unchanged");
    expect(await confirmStudioJurisdictionAsOwner(base)).toEqual({ ok: true, outcome: "already_confirmed" });
  });

  it("an rpc error does not leak and is a refusal", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom secret" } });
    const r = await confirmStudioJurisdictionAsOwner(base);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});
