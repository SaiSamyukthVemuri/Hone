import { beforeEach, describe, expect, it, vi } from "vitest";

// The action decides whether the owner's "Invite anyway" reaches the command. The service and the dates stay what the existing flow sends; only the one
// explicit field, from an owner, lifts the estimate.

const getCurrentPractitionerWithStudio = vi.fn();
const getNewClientAdmissionMode = vi.fn();
const inviteToBook = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: (...a: unknown[]) => getCurrentPractitionerWithStudio(...a) }));
vi.mock("@/lib/booking/new-client-admission", async (orig) => ({
  ...((await orig()) as object),
  getNewClientAdmissionMode: (...a: unknown[]) => getNewClientAdmissionMode(...a),
  invitedBookingRefusalKind: async () => null,
}));
vi.mock("@/lib/waitlist/lifecycle-notice-cookie", () => ({ clearLifecycleNotice: async () => {} }));
vi.mock("@/lib/waitlist/invite-to-book-adapter", async (orig) => ({
  ...((await orig()) as object),
  admissionCommandAdapter: { inviteToBook: (...a: unknown[]) => inviteToBook(...a) },
}));

const { inviteToBookAction } = await import("@/app/(app)/settings/waitlist/invite-actions");

const form = (extra: Record<string, string> = {}) => {
  const f = new FormData();
  f.set("entry_id", "11111111-1111-4111-8111-111111111111");
  f.set("service_id", "22222222-2222-4222-8222-222222222222");
  f.set("allowed_days_preset", "every");
  f.set("window_days", "14");
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
};
const asRole = (role: string) => getCurrentPractitionerWithStudio.mockResolvedValue({ studio: { id: "s", slug: "a" }, practitioner: { role } });
const sentInput = () => inviteToBook.mock.calls[0][0] as { beyondEstimate?: boolean; scope: { serviceId: string; windowDays: number } };

beforeEach(() => {
  for (const m of [getCurrentPractitionerWithStudio, getNewClientAdmissionMode, inviteToBook]) m.mockReset();
  asRole("owner");
  getNewClientAdmissionMode.mockResolvedValue({ ok: true, mode: "waitlist" });
  inviteToBook.mockResolvedValue({ state: "refused", code: "no_capacity" });
});

describe("a plain invitation is unchanged", () => {
  it("sends the command no override, and a refusal at zero is the same refusal as today", async () => {
    const r = await inviteToBookAction(form());
    expect(inviteToBook).toHaveBeenCalledTimes(1);
    expect(sentInput().beyondEstimate).toBeUndefined();
    expect(r).toEqual({ outcome: { state: "refused", code: "no_capacity" } });
  });
  it("keeps the service and window the existing flow sends", async () => {
    await inviteToBookAction(form());
    expect(sentInput().scope).toMatchObject({ serviceId: "22222222-2222-4222-8222-222222222222", windowDays: 14 });
  });
});

describe("Invite anyway", () => {
  it("an owner's explicit field reaches the command once, with the same scope", async () => {
    await inviteToBookAction(form({ allow_beyond_estimate: "true" }));
    expect(inviteToBook).toHaveBeenCalledTimes(1);
    expect(sentInput().beyondEstimate).toBe(true);
    expect(sentInput().scope).toMatchObject({ serviceId: "22222222-2222-4222-8222-222222222222", windowDays: 14 });
  });
  it.each(["member", "assistant", "practitioner", ""])("a %s role gets the plain at-zero path: the field is ignored and no override is sent", async (role) => {
    asRole(role);
    await inviteToBookAction(form({ allow_beyond_estimate: "true" }));
    expect(sentInput().beyondEstimate).toBeUndefined();
  });
  it.each(["True", "1", "on", "yes", "false", ""])("the value %j is not an override", async (v) => {
    await inviteToBookAction(form({ allow_beyond_estimate: v }));
    expect(sentInput().beyondEstimate).toBeUndefined();
  });
  it("closed admission still refuses before the command, override or not", async () => {
    vi.resetModules();
    getNewClientAdmissionMode.mockRejectedValue(new Error("boom"));
    const r = await inviteToBookAction(form({ allow_beyond_estimate: "true" }));
    expect(inviteToBook).not.toHaveBeenCalled();
    expect(r).toEqual({ outcome: null, reason: "admission_unreadable" });
  });
  it("a refusal for an already-invited person comes back unchanged", async () => {
    inviteToBook.mockResolvedValue({ state: "refused", code: "already_invited" });
    const r = await inviteToBookAction(form({ allow_beyond_estimate: "true" }));
    expect(r).toEqual({ outcome: { state: "refused", code: "already_invited" } });
  });
  it("a malformed submission is still refused and the override does not rescue it", async () => {
    const f = form({ allow_beyond_estimate: "true" });
    f.delete("entry_id");
    const r = await inviteToBookAction(f);
    expect(inviteToBook).not.toHaveBeenCalled();
    expect(r).toEqual({ outcome: null, reason: "malformed_submission" });
  });
});
