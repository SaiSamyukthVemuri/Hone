import { beforeEach, describe, expect, it, vi } from "vitest";

// SMS-SENDER-REG-01: the operator's record action, through its form entry
// point. Every refusal is RETURNED as state for the form to render; none is
// thrown (Codex P2 4244484024). The submitted number is the one the command
// compares, and the form can no longer name a kind (Codex P2 4244484022).

const rpc = vi.fn();
const cache = vi.hoisted(() => ({ throws: false }));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(() => {
    if (cache.throws) throw new Error("revalidate failed");
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1", email: "ops@example.test" } } }) } }),
}));
const adminCtl = vi.hoisted(() => ({ throws: false }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    if (adminCtl.throws) throw new Error("no service role");
    return { rpc };
  },
}));
vi.mock("@/lib/admin", () => ({ isAdmin: () => true }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://example.test" }));
vi.mock("@/lib/email/send-welcome", () => ({ deliverWelcomeEmail: vi.fn() }));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, throwOn: null as string | null }));
vi.mock("@/lib/audit/admin-actions", () => ({
  logAdminAction: vi.fn(async (input: Record<string, unknown>) => {
    audit.calls.push(input);
    if (audit.throwOn && input.outcome === audit.throwOn) throw new Error("audit store down");
  }),
}));

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
  audit.calls.length = 0;
  cache.throws = false;
  adminCtl.throws = false;
  audit.throwOn = null;
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

  // Codex P2 4249989480: once the command may have run, nothing claims it did not.
  it("a command whose answer was lost (an error, a throw, no row) is an UNKNOWN outcome, never 'nothing was saved'", async () => {
    for (const answer of [
      () => rpc.mockResolvedValue({ data: null, error: { message: "down" } }),
      () => rpc.mockRejectedValue(new Error("network")),
      () => rpc.mockResolvedValue({ data: [], error: null }),
    ]) {
      rpc.mockReset();
      answer();
      const out = await recordSmsRegistrationFormAction(STUDIO, null, form(valid));
      expect(out).toMatchObject({ ok: false, result: "outcome_unknown" });
      expect(out.error).toMatch(/could not confirm whether the registration was recorded/);
      expect(out.error).not.toMatch(/Nothing was saved|Nothing was recorded/);
    }
  });

  it("an exception AFTER the command ran (the final audit write) is an unknown outcome too", async () => {
    rpc.mockResolvedValue({ data: [{ result: "recorded", registration_id: "r", kind: "us_10dlc" }], error: null });
    audit.throwOn = "succeeded";
    const out = await recordSmsRegistrationFormAction(STUDIO, null, form(valid));
    expect(out).toMatchObject({ ok: false, result: "outcome_unknown" });
    expect(out.error).not.toMatch(/Nothing was saved/);
  });

  it("a failure BEFORE the command is sent says nothing was saved", async () => {
    adminCtl.throws = true;
    const out = await recordSmsRegistrationFormAction(STUDIO, null, form(valid));
    expect(out).toMatchObject({ ok: false, result: "error" });
    expect(out.error).toMatch(/Nothing was saved/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a recorded write stays recorded even if refreshing the page cache throws", async () => {
    rpc.mockResolvedValue({ data: [{ result: "recorded", registration_id: "r", kind: "us_10dlc" }], error: null });
    cache.throws = true;
    expect(await recordSmsRegistrationFormAction(STUDIO, null, form(valid))).toEqual({ ok: true, result: "recorded" });
  });

  it("refuses before the command without a sender id or a supported number", async () => {
    expect(await recordSmsRegistrationFormAction(STUDIO, null, form({ ...valid, expected_sender_id: "" }))).toMatchObject({ ok: false, result: "missing_sender" });
    for (const n of ["", "+18765550123", "2125550123"]) {
      expect(await recordSmsRegistrationFormAction(STUDIO, null, form({ ...valid, expected_phone_number: n }))).toMatchObject({ ok: false, result: "unsupported_number" });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("every audit event carries the studio, on every path (Codex P2 4248698146)", async () => {
    rpc.mockResolvedValue({ data: [{ result: "recorded", registration_id: "r", kind: "us_10dlc" }], error: null });
    await recordSmsRegistrationFormAction(STUDIO, null, form(valid));
    rpc.mockResolvedValue({ data: [{ result: "sender_changed", registration_id: null, kind: null }], error: null });
    await recordSmsRegistrationFormAction(STUDIO, null, form(valid));
    await recordSmsRegistrationFormAction(STUDIO, null, form({ ...valid, expected_sender_id: "" }));
    await recordSmsRegistrationFormAction(STUDIO, null, form({ ...valid, expected_phone_number: "" }));
    expect(audit.calls).toHaveLength(4);
    for (const call of audit.calls) expect(call).toMatchObject({ action: "sms_registration_recorded", studioId: STUDIO, targetId: STUDIO });
  });

  // Codex P2 4249989482: EVERY return path writes exactly one audit event.
  it("every return path is audited exactly once, the invalid status included", async () => {
    const paths: Array<[string, () => void, Record<string, string>]> = [
      ["recorded", () => rpc.mockResolvedValue({ data: [{ result: "recorded" }], error: null }), valid],
      ["refused", () => rpc.mockResolvedValue({ data: [{ result: "sender_changed" }], error: null }), valid],
      ["lost answer", () => rpc.mockResolvedValue({ data: null, error: { message: "x" } }), valid],
      ["thrown", () => rpc.mockRejectedValue(new Error("x")), valid],
      ["missing sender", () => undefined, { ...valid, expected_sender_id: "" }],
      ["unsupported number", () => undefined, { ...valid, expected_phone_number: "+18765550123" }],
      ["invalid status", () => undefined, { ...valid, status: "delivered" }],
    ];
    for (const [label, arrange, fields] of paths) {
      rpc.mockReset();
      audit.calls.length = 0;
      arrange();
      await recordSmsRegistrationFormAction(STUDIO, null, form(fields));
      expect(audit.calls, label).toHaveLength(1);
      expect(audit.calls[0], label).toMatchObject({ action: "sms_registration_recorded", studioId: STUDIO });
      expect(audit.calls[0].outcome, label).toBe(label === "recorded" ? "succeeded" : "failed");
    }
  });

  it("source guard: the action audits only through its one helper", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/admin/studios/[id]/actions.ts", "utf8");
    const body = src.slice(src.indexOf("export async function recordSmsRegistrationAction("));
    const fn = body.slice(0, body.indexOf("\n}\n") + 3);
    // One logAdminAction call, and it is the helper's; every path above calls the helper.
    expect(fn.match(/logAdminAction\(/g)).toHaveLength(1);
    expect(fn).toMatch(/const audit = \(outcome[^)]*\) =>\s+logAdminAction\(/);
  });
});
