import { beforeEach, describe, expect, it, vi } from "vitest";

// SMS-SENDER-REG-01: the operator's record action, through its form entry
// point. Every refusal is RETURNED as state for the form to render; none is
// thrown (Codex P2 4244484024). The submitted number is the one the command
// compares, and the form can no longer name a kind (Codex P2 4244484022).

const rpc = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1", email: "ops@example.test" } } }) } }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ rpc }) }));
vi.mock("@/lib/admin", () => ({ isAdmin: () => true }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://example.test" }));
vi.mock("@/lib/email/send-welcome", () => ({ deliverWelcomeEmail: vi.fn() }));
vi.mock("@/lib/audit/admin-actions", () => ({ logAdminAction: vi.fn(async () => undefined) }));

import { recordSmsRegistrationFormAction } from "@/app/admin/studios/[id]/actions";

const STUDIO = "11111111-1111-4111-8111-111111111111";
const SENDER = "22222222-2222-4222-8222-222222222222";
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const valid = { expected_sender_id: SENDER, expected_phone_number: "+12125550123", status: "approved" };

beforeEach(() => {
  rpc.mockReset();
});

describe("recordSmsRegistrationFormAction", () => {
  it("passes the sender and NUMBER shown to the command, and no kind", async () => {
    rpc.mockResolvedValue({ data: [{ result: "recorded", registration_id: "r", kind: "us_10dlc" }], error: null });
    expect(await recordSmsRegistrationFormAction(STUDIO, null, form({ ...valid, kind: "toll_free_verification" }))).toMatchObject({ ok: true });
    expect(rpc).toHaveBeenCalledWith("record_studio_sms_sender_registration", {
      p_studio_id: STUDIO,
      p_expected_sender_id: SENDER,
      p_expected_phone: "+12125550123",
      p_status: "approved",
      p_missing: null,
      p_provider_reference: null,
    });
  });

  it.each([
    ["sender_changed", /number changed after this page loaded/],
    ["sender_has_no_number", /no number yet/],
    ["no_live_sender", /no live SMS sender/],
  ])("the command's %s comes back as an error message, not a throw", async (result, message) => {
    rpc.mockResolvedValue({ data: [{ result, registration_id: null, kind: null }], error: null });
    const out = await recordSmsRegistrationFormAction(STUDIO, null, form(valid));
    expect(out).toMatchObject({ ok: false, result });
    expect(out.error).toMatch(message);
  });

  it("an unavailable command, or one that throws, is still returned state", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    expect(await recordSmsRegistrationFormAction(STUDIO, null, form(valid))).toMatchObject({ ok: false, result: "error" });
    rpc.mockRejectedValue(new Error("network"));
    const out = await recordSmsRegistrationFormAction(STUDIO, null, form(valid));
    expect(out).toMatchObject({ ok: false, result: "error" });
    expect(out.error).toMatch(/Nothing was saved/);
  });

  it("refuses before the command without a sender id or a supported number", async () => {
    expect(await recordSmsRegistrationFormAction(STUDIO, null, form({ ...valid, expected_sender_id: "" }))).toMatchObject({ ok: false, result: "missing_sender" });
    for (const n of ["", "+18765550123", "2125550123"]) {
      expect(await recordSmsRegistrationFormAction(STUDIO, null, form({ ...valid, expected_phone_number: n }))).toMatchObject({ ok: false, result: "unsupported_number" });
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});
