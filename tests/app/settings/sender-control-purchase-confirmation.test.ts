import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// HON-50 G3, proven at the SERVER ACTION: a direct call to the provisioning
// action without the owner's confirmation for THAT number is refused before
// any provider is constructed, and the fake provider records ZERO purchases.
// In live mode the owner's own phone and agreement to the test text are also
// required; the real adapter is replaced by a fake (no Twilio credential).

const STUDIO = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const NUMBER = "+12125550101";

const runSenderProvision = vi.fn(async () => ({ ok: true, result: "activated", phoneNumber: NUMBER }));
const runSenderAdoption = vi.fn(async () => ({ ok: true, result: "adopted", phoneNumber: NUMBER }));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "http://127.0.0.1:3000" }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { role: "owner", user_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    studio: { id: STUDIO },
  }),
}));

// The live provider: arming and the resolver are injected, so no credential
// is read and nothing can reach Twilio.
const liveFake = { marker: "live-fake" };
let liveArmed = false;
vi.mock("@/lib/sms/provider", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sms/provider")>();
  return { ...real, liveProvisioningArmed: () => liveArmed, resolveProvisioningProvider: () => liveFake };
});
vi.mock("@/lib/sms/sender-controls", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sms/sender-controls")>();
  return { ...real, runSenderProvision, runSenderAdoption };
});

const ENV_KEYS = [
  "HONE_SMS_SENDER_CONTROLS",
  "HONE_SMS_SENDER_CONTROLS_LIVE_STUDIO_IDS",
  "VERCEL_ENV",
  "NEXT_PUBLIC_SUPABASE_URL",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  runSenderProvision.mockClear();
  runSenderAdoption.mockClear();
  liveArmed = false;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("fake mode: no purchase without confirmation", () => {
  beforeEach(() => {
    process.env.HONE_SMS_SENDER_CONTROLS = "fake";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  });

  async function fakeFor() {
    const { senderControlsFakeProvider } = await import("@/lib/sms/sender-controls");
    const fake = senderControlsFakeProvider("http://127.0.0.1:3000", STUDIO);
    fake.reset?.();
    return fake;
  }

  it.each([
    ["no confirmation at all", { country: "US", phone_number: NUMBER }],
    ["cost not confirmed", { country: "US", phone_number: NUMBER, confirm_number: NUMBER }],
    ["confirmed for ANOTHER number", { country: "US", phone_number: NUMBER, confirm_number: "+12125550102", confirm_cost: "yes" }],
    ["checkbox value forged", { country: "US", phone_number: NUMBER, confirm_number: NUMBER, confirm_cost: "on" }],
  ])("%s: refused, the orchestration never runs, zero purchases", async (_label, fields) => {
    const fake = await fakeFor();
    const { provisionSenderNumberAction } = await import("@/app/(app)/settings/integrations/sender-control-actions");
    const r = await provisionSenderNumberAction(null, form(fields));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Nothing was bought/);
    expect(runSenderProvision).not.toHaveBeenCalled();
    expect(fake.calls.purchase).toBe(0);
    expect(fake.calls.search).toBe(0);
  });

  it("confirmed for this number: the orchestration runs with the fake and the fake destination", async () => {
    await fakeFor();
    const { provisionSenderNumberAction } = await import("@/app/(app)/settings/integrations/sender-control-actions");
    const r = await provisionSenderNumberAction(null, form({ country: "US", phone_number: NUMBER, confirm_number: NUMBER, confirm_cost: "yes" }));
    expect(r).toEqual({ ok: true, message: `Studio number ${NUMBER} is set up (fake provider).` });
    expect(runSenderProvision).toHaveBeenCalledTimes(1);
    const [deps] = runSenderProvision.mock.calls[0] as unknown as [{ provider: unknown; testDestination: string }];
    expect(deps.provider).not.toBe(liveFake);
    expect(deps.testDestination).toBe("+14165550199");
  });
});

describe("live mode (allowlisted, armed by injection): owner's phone required", () => {
  beforeEach(() => {
    process.env.HONE_SMS_SENDER_CONTROLS = "live";
    process.env.VERCEL_ENV = "production";
    process.env.HONE_SMS_SENDER_CONTROLS_LIVE_STUDIO_IDS = STUDIO;
    liveArmed = true;
  });

  const confirmed = { country: "US", phone_number: NUMBER, confirm_number: NUMBER, confirm_cost: "yes" };

  it("cost confirmed but no test-text agreement or phone: refused before the orchestration", async () => {
    const { provisionSenderNumberAction } = await import("@/app/(app)/settings/integrations/sender-control-actions");
    const extras: Record<string, string>[] = [{}, { confirm_test_text: "yes" }, { test_destination: "+14165550123" }, { confirm_test_text: "yes", test_destination: "+18885550123" }];
    for (const extra of extras) {
      const r = await provisionSenderNumberAction(null, form({ ...confirmed, ...extra }));
      expect(r.ok, JSON.stringify(extra)).toBe(false);
    }
    expect(runSenderProvision).not.toHaveBeenCalled();
  });

  it("everything confirmed: the live provider, the OWNER'S phone, no fake tag", async () => {
    const { provisionSenderNumberAction } = await import("@/app/(app)/settings/integrations/sender-control-actions");
    const r = await provisionSenderNumberAction(null, form({ ...confirmed, confirm_test_text: "yes", test_destination: "+14165550123" }));
    expect(r).toEqual({ ok: true, message: `Studio number ${NUMBER} is set up.` });
    const [deps] = runSenderProvision.mock.calls[0] as unknown as [{ provider: unknown; testDestination: string }];
    expect(deps.provider).toBe(liveFake);
    expect(deps.testDestination).toBe("+14165550123");
  });

  it("live adoption needs the owner's phone too, and never the invented destination", async () => {
    const { adoptSenderNumberAction } = await import("@/app/(app)/settings/integrations/sender-control-actions");
    const base = { country: "US", phone_number: NUMBER, messaging_service_sid: "MG00000000000000000000000000000000" };
    expect((await adoptSenderNumberAction(null, form(base))).ok).toBe(false);
    expect(runSenderAdoption).not.toHaveBeenCalled();
    await adoptSenderNumberAction(null, form({ ...base, confirm_test_text: "yes", test_destination: "+12125550123" }));
    const [deps] = runSenderAdoption.mock.calls[0] as unknown as [{ provider: unknown; testDestination: string }];
    expect(deps.provider).toBe(liveFake);
    expect(deps.testDestination).toBe("+12125550123");
  });

  it("a studio NOT on the allowlist is refused before anything", async () => {
    process.env.HONE_SMS_SENDER_CONTROLS_LIVE_STUDIO_IDS = "11111111-2222-4333-8444-555555555555";
    const { provisionSenderNumberAction } = await import("@/app/(app)/settings/integrations/sender-control-actions");
    const r = await provisionSenderNumberAction(null, form({ ...confirmed, confirm_test_text: "yes", test_destination: "+14165550123" }));
    expect(r).toEqual({ ok: false, message: "Studio number controls are not available here (live_not_allowlisted)." });
    expect(runSenderProvision).not.toHaveBeenCalled();
  });

  it("no Twilio credential is present in this test", () => {
    expect(process.env.TWILIO_ACCOUNT_SID).toBeUndefined();
    expect(process.env.TWILIO_AUTH_TOKEN).toBeUndefined();
  });
});
