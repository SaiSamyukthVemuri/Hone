import { beforeEach, describe, expect, it, vi } from "vitest";

// While new-client admission is Closed (until 0323 is applied) or unreadable, 0204 refuses an INVITED booking,
// so the owner's send is refused BEFORE the command: nothing is created or counted.

const getCurrentPractitionerWithStudio = vi.fn();
const getNewClientAdmissionMode = vi.fn();
const inviteToBook = vi.fn();
const readRule = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: (...a: unknown[]) => getCurrentPractitionerWithStudio(...a),
}));
vi.mock("@/lib/booking/new-client-admission", async (orig) => ({
  ...((await orig()) as object),
  getNewClientAdmissionMode: (...a: unknown[]) => getNewClientAdmissionMode(...a),
}));
// The 0323 marker, read through the admin client by the real predicate.
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc: async () => {
      const r = await readRule();
      if (r === "applied") return { data: true, error: null };
      return { data: null, error: { code: r === "absent" ? "PGRST202" : "XX000", message: "x" } };
    },
  }),
}));
vi.mock("@/lib/waitlist/invite-to-book-adapter", async (orig) => ({
  ...((await orig()) as object),
  admissionCommandAdapter: { inviteToBook: (...a: unknown[]) => inviteToBook(...a), capabilities: {} },
}));

import { inviteToBookAction } from "@/app/(app)/settings/waitlist/invite-actions";
import { INVITE_ADMISSION_CLOSED_COPY, INVITE_ADMISSION_UNREADABLE_COPY, invitationNoticeFor } from "@/lib/waitlist/invite-to-book-contract";

const SERVICE = "11111111-1111-4111-8111-111111111111";
const form = () => {
  const f = new FormData();
  f.set("entry_id", "22222222-2222-4222-8222-222222222222");
  f.set("service_id", SERVICE);
  f.set("window_days", "14");
  f.set("allowed_days_preset", "every");
  return f;
};

beforeEach(() => {
  for (const m of [getCurrentPractitionerWithStudio, getNewClientAdmissionMode, inviteToBook, readRule]) m.mockReset();
  getCurrentPractitionerWithStudio.mockResolvedValue({ studio: { id: "s", slug: "studio-a" } });
  inviteToBook.mockResolvedValue({ state: "refused" });
  readRule.mockResolvedValue("absent");
});

describe("inviteToBookAction under admission", () => {
  it.each([
    ["closed", { ok: true, mode: "closed", source: "persisted" }, "admission_closed"],
    ["unreadable", { ok: false }, "admission_unreadable"],
  ])("refuses the send when admission is %s, and never calls the command", async (_l, admission, reason) => {
    getNewClientAdmissionMode.mockResolvedValue(admission);
    const r = await inviteToBookAction(form());
    expect(r).toEqual({ outcome: null, reason });
    expect(inviteToBook).not.toHaveBeenCalled();
  });

  it("a CLOSED studio reaches the command once 0323 is applied", async () => {
    getNewClientAdmissionMode.mockResolvedValue({ ok: true, mode: "closed", source: "persisted" });
    readRule.mockResolvedValue("applied");
    await inviteToBookAction(form());
    expect(inviteToBook).toHaveBeenCalledTimes(1);
  });

  it("a CLOSED studio whose rule cannot be read is refused as UNREADABLE, not as closed", async () => {
    getNewClientAdmissionMode.mockResolvedValue({ ok: true, mode: "closed", source: "persisted" });
    readRule.mockResolvedValue("error");
    expect(await inviteToBookAction(form())).toEqual({ outcome: null, reason: "admission_unreadable" });
    expect(inviteToBook).not.toHaveBeenCalled();
  });

  it("fails closed, as UNREADABLE, when the studio cannot be resolved", async () => {
    getCurrentPractitionerWithStudio.mockRejectedValue(new Error("no session"));
    expect(await inviteToBookAction(form())).toEqual({ outcome: null, reason: "admission_unreadable" });
    expect(inviteToBook).not.toHaveBeenCalled();
  });

  it.each(["waitlist", "open"])("%s admission reaches the command", async (mode) => {
    getNewClientAdmissionMode.mockResolvedValue({ ok: true, mode, source: "persisted" });
    await inviteToBookAction(form());
    expect(inviteToBook).toHaveBeenCalledTimes(1);
  });

  it("the notice names the cause and the Settings → Booking fix, and says nothing was created", () => {
    const n = invitationNoticeFor(null, "admission_closed");
    expect(n.invitationExists).toBe(false);
    expect(n.message).toBe(INVITE_ADMISSION_CLOSED_COPY);
    expect(n.message).toContain("Closed");
    expect(n.message).toContain("Settings → Booking");
    expect(n.message).toContain("No invitation was created");
  });

  it("the unreadable notice does not claim the mode is Closed", () => {
    const n = invitationNoticeFor(null, "admission_unreadable");
    expect(n.invitationExists).toBe(false);
    expect(n.message).toBe(INVITE_ADMISSION_UNREADABLE_COPY);
    expect(n.message).toBe("We couldn’t check new-client admission, so invitations are paused. Check Settings → Booking.");
    expect(n.message).not.toContain("Closed");
  });
});
