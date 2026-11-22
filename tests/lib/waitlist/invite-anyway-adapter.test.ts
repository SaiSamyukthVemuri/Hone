import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// "INVITE ANYWAY" LIFTS THE AVAILABILITY ESTIMATE AND NOTHING ELSE
//
// The command refuses no_capacity when the live competing invitations plus this one exceed the number it is given. The owner's explicit override gives it
// the largest number it accepts, so that one refusal cannot happen; every other answer the command can give must still reach the owner unchanged.
// ===========================================================================

const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
let admitReplies: Array<{ data: unknown; error: unknown }> = [];
let fitCalls = 0;

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "admit_new_client_waitlist_entry") return admitReplies.shift() ?? { data: null, error: { code: "XX000" } };
      return { data: [{ result: "opened" }], error: null };
    },
  }),
}));
vi.mock("@/lib/waitlist/send-time-fit", () => ({
  computeConsultationFit: async () => {
    fitCalls += 1;
    return { ok: true, fit: 0, firstDate: "2026-09-22" };
  },
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { role: "owner", user_id: "user-1" },
    studio: { id: "studio-1", name: "Studio", timezone: "UTC", slug: "studio" },
  }),
}));
vi.mock("@/lib/booking/session-actor", () => ({
  sessionActor: async () => ({ studioId: "studio-1", actorUserId: "user-1" }),
}));

const { admissionCommandAdapter } = await import("@/lib/waitlist/invite-to-book-adapter");

const PLAIN = {
  entryId: "11111111-1111-4111-8111-111111111111",
  scope: { serviceId: "svc-1", windowDays: 14, allowedWeekdays: null as number[] | null },
};
const ANYWAY = { ...PLAIN, beyondEstimate: true };
const admits = () => calls.filter((c) => c.name === "admit_new_client_waitlist_entry");

beforeEach(() => {
  calls.length = 0;
  admitReplies = [];
  fitCalls = 0;
});

describe("a plain invitation is unchanged", () => {
  it("uses the computed estimate, and the command's refusal at zero reaches the owner", async () => {
    admitReplies = [{ data: [{ result: "no_capacity" }], error: null }];
    const out = await admissionCommandAdapter.inviteToBook(PLAIN);
    expect(out).toEqual({ state: "refused", code: "no_capacity" });
    expect(fitCalls).toBe(1);
    expect(admits()[0].args.p_fit).toBe(0);
  });
  it("a flag that is not exactly true changes nothing", async () => {
    for (const v of [false, undefined, "true", 1]) {
      calls.length = 0;
      admitReplies = [{ data: [{ result: "no_capacity" }], error: null }];
      await admissionCommandAdapter.inviteToBook({ ...PLAIN, beyondEstimate: v } as never);
      expect(admits()[0].args.p_fit).toBe(0);
    }
  });
});

describe("Invite anyway", () => {
  it("asks the command exactly once, with the largest accepted number, and does not compute the estimate", async () => {
    admitReplies = [{ data: [{ result: "no_capacity" }], error: null }];
    await admissionCommandAdapter.inviteToBook(ANYWAY);
    expect(admits()).toHaveLength(1);
    expect(admits()[0].args.p_fit).toBe(2_147_483_647);
    expect(fitCalls).toBe(0);
  });
  it("changes nothing else about the call: same studio, actor, entry, service and dates", async () => {
    admitReplies = [{ data: [{ result: "already_invited" }], error: null }, { data: [{ result: "already_invited" }], error: null }];
    await admissionCommandAdapter.inviteToBook(PLAIN);
    await admissionCommandAdapter.inviteToBook(ANYWAY);
    const [a, b] = admits().map((c) => ({ ...c.args, p_fit: undefined }));
    expect(b).toEqual(a);
  });
  it.each([
    "already_invited",
    "not_owner",
    "not_a_member",
    "pending_owner_review",
    "not_admissible",
    "unknown_studio",
    "invalid_input",
    "no_capacity",
  ])("every other refusal (%s) reaches the owner exactly as for a plain invitation", async (code) => {
    admitReplies = [{ data: [{ result: code }], error: null }, { data: [{ result: code }], error: null }];
    const plain = await admissionCommandAdapter.inviteToBook(PLAIN);
    const anyway = await admissionCommandAdapter.inviteToBook(ANYWAY);
    expect(anyway).toEqual(plain);
    expect(anyway).toMatchObject({ state: "refused" });
  });
  it("a lost answer is still indeterminate, never a refusal or a success", async () => {
    admitReplies = [{ data: null, error: { code: "XX000" } }];
    const out = await admissionCommandAdapter.inviteToBook(ANYWAY);
    expect(out).toMatchObject({ state: "indeterminate" });
  });
});
