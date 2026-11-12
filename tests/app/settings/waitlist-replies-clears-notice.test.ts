import { beforeEach, describe, expect, it, vi } from "vitest";

// A stale lifecycle notice must not survive an acknowledgement: every waitlist
// action that redirects clears the one-shot notice cookie first (#1401 pattern).

const order: string[] = [];

vi.mock("@/lib/waitlist/lifecycle-notice-cookie", () => ({
  clearLifecycleNotice: async () => {
    order.push("clear");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    order.push(`redirect:${to}`);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => {
    order.push("session");
    return { practitioner: { role: "owner", user_id: "u1" }, studio: { id: "s1" } };
  },
}));
vi.mock("@/lib/waitlist/times-feedback-owner", () => ({
  acknowledgeTimesFeedback: async () => true,
}));

const { acknowledgeReplyAction } = await import("@/app/(app)/settings/waitlist/replies/actions");

beforeEach(() => {
  order.length = 0;
});

describe("acknowledgeReplyAction clears the lifecycle notice", () => {
  it("clears before anything else on a valid acknowledgement", async () => {
    const fd = new FormData();
    fd.set("invitationId", "11111111-1111-4111-8111-111111111111");
    await expect(acknowledgeReplyAction(fd)).rejects.toThrow("NEXT_REDIRECT");
    expect(order[0]).toBe("clear");
  });

  it("clears even when the input is refused", async () => {
    const fd = new FormData();
    fd.set("invitationId", "not-a-uuid");
    await expect(acknowledgeReplyAction(fd)).rejects.toThrow("NEXT_REDIRECT");
    expect(order[0]).toBe("clear");
    expect(order).toContain("redirect:/settings/waitlist/replies?ack=failed");
  });
});
