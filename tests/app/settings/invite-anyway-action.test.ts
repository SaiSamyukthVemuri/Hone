import { beforeEach, describe, expect, it, vi } from "vitest";

// The action decides whether the owner's "Invite anyway" reaches the command. The service and the dates stay what the existing flow sends; only the one
// explicit field, from an owner, lifts the estimate.

const estimate = vi.fn();
const getCurrentPractitionerWithStudio = vi.fn();
const getNewClientAdmissionMode = vi.fn();
const inviteToBook = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/(app)/settings/waitlist/window-capacity-actions", () => ({ estimateWindowCapacityAction: (...a: unknown[]) => estimate(...a) }));
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
const room = (open: number) => ({ ok: true, fit: 5, outstanding: 5 - open, open, outstandingScope: "window" });
const sentInput = () => inviteToBook.mock.calls[0][0] as { beyondEstimate?: boolean; scope: { serviceId: string; windowDays: number } };

beforeEach(() => {
  for (const m of [getCurrentPractitionerWithStudio, getNewClientAdmissionMode, inviteToBook, estimate]) m.mockReset();
  estimate.mockResolvedValue(room(5));
  asRole("owner");
  getNewClientAdmissionMode.mockResolvedValue({ ok: true, mode: "waitlist" });
  inviteToBook.mockResolvedValue({ state: "refused", code: "no_capacity" });
});

describe("a plain invitation is unchanged", () => {
  it("sends the command no override, and the command's own refusal comes back unchanged", async () => {
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

const FLAG = { allow_beyond_estimate: "true" };

describe("the server works out the estimate itself", () => {
  it("asks for the estimate of exactly this scope", async () => {
    await inviteToBookAction(form());
    expect(estimate).toHaveBeenCalledWith({ serviceId: "22222222-2222-4222-8222-222222222222", windowDays: 14, allowedWeekdays: null });
  });
  it.each([[{}], [FLAG]])("an estimate that cannot be read sends nothing and says to try again, even with the override (%j)", async (extra) => {
    estimate.mockResolvedValue({ ok: false });
    const r = await inviteToBookAction(form(extra));
    expect(inviteToBook).not.toHaveBeenCalled();
    expect(r).toEqual({ outcome: { state: "refused", code: "estimate_unreadable" } });
  });
  it("an estimate that throws is the same: nothing sent, not treated as zero", async () => {
    estimate.mockRejectedValue(new Error("down"));
    await expect(inviteToBookAction(form(FLAG))).rejects.toThrow();
    expect(inviteToBook).not.toHaveBeenCalled();
  });
});

describe("at an estimate of zero", () => {
  beforeEach(() => estimate.mockResolvedValue(room(0)));
  it("without the override sends nothing and asks for confirmation (the page thought there was room)", async () => {
    const r = await inviteToBookAction(form());
    expect(inviteToBook).not.toHaveBeenCalled();
    expect(r).toEqual({ outcome: { state: "refused", code: "needs_estimate_confirmation" } });
  });
  it.each(["True", "1", "on", "yes", "false", ""])("the value %j is not an override", async (v) => {
    const r = await inviteToBookAction(form({ allow_beyond_estimate: v }));
    expect(inviteToBook).not.toHaveBeenCalled();
    expect(r).toEqual({ outcome: { state: "refused", code: "needs_estimate_confirmation" } });
  });
  it("with an owner's explicit override sends exactly one invitation, with the same scope", async () => {
    await inviteToBookAction(form(FLAG));
    expect(inviteToBook).toHaveBeenCalledTimes(1);
    expect(sentInput().beyondEstimate).toBe(true);
    expect(sentInput().scope).toMatchObject({ serviceId: "22222222-2222-4222-8222-222222222222", windowDays: 14 });
  });
  it.each(["member", "assistant", "practitioner", ""])("a %s role never gets the override: the usual path, no estimate check, no override", async (role) => {
    asRole(role);
    await inviteToBookAction(form(FLAG));
    expect(estimate).not.toHaveBeenCalled();
    expect(inviteToBook).toHaveBeenCalledTimes(1);
    expect(sentInput().beyondEstimate).toBeUndefined();
  });
  it("a refusal for an already-invited person comes back unchanged", async () => {
    inviteToBook.mockResolvedValue({ state: "refused", code: "already_invited" });
    expect(await inviteToBookAction(form(FLAG))).toEqual({ outcome: { state: "refused", code: "already_invited" } });
  });
});

describe("with room in the estimate", () => {
  it("a plain invitation takes the normal path", async () => {
    await inviteToBookAction(form());
    expect(inviteToBook).toHaveBeenCalledTimes(1);
    expect(sentInput().beyondEstimate).toBeUndefined();
  });
  it("the override field is ignored completely (the page thought zero, the server finds room)", async () => {
    await inviteToBookAction(form(FLAG));
    expect(inviteToBook).toHaveBeenCalledTimes(1);
    expect(sentInput().beyondEstimate).toBeUndefined();
  });
});

describe("what is unchanged", () => {
  it("closed or unreadable admission still refuses before anything else", async () => {
    getNewClientAdmissionMode.mockRejectedValue(new Error("boom"));
    const r = await inviteToBookAction(form(FLAG));
    expect(inviteToBook).not.toHaveBeenCalled();
    expect(estimate).not.toHaveBeenCalled();
    expect(r).toEqual({ outcome: null, reason: "admission_unreadable" });
  });
  it("a malformed submission is still refused and the override does not rescue it", async () => {
    const f = form(FLAG);
    f.delete("entry_id");
    expect(await inviteToBookAction(f)).toEqual({ outcome: null, reason: "malformed_submission" });
    expect(inviteToBook).not.toHaveBeenCalled();
  });
});
