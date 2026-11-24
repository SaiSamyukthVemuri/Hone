import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { TeamSeats } from "@/lib/subscriptions/team-seats";

const deps = vi.hoisted(() => ({
  insert: vi.fn(),
  seats: vi.fn(),
  send: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/email/client", () => ({
  resend: { emails: { send: deps.send } },
  FROM_ADDRESS: "test@example.test",
}));
vi.mock("@/lib/subscriptions/owner-team-seats", () => ({
  getOwnerTeamSeats: deps.seats,
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "owner", role: "owner", display_name: "Owner" },
    studio: { id: "studio", name: "Test" },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        ilike: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: deps.insert,
      };
      return chain;
    },
  }),
}));
import { InviteForm } from "@/app/(app)/settings/team/InviteForm";
import { invitePractitionerAction } from "@/app/(app)/settings/team/actions";

const studio: TeamSeats = {
  plan: "studio",
  practitioner_limit: 3,
  practitioner_used: 1,
  receptionist_limit: 1,
  receptionist_used: 0,
};
const solo: TeamSeats = {
  plan: "solo",
  practitioner_limit: 1,
  practitioner_used: 1,
  receptionist_limit: 0,
  receptionist_used: 0,
};
function submit(role: string) {
  const form = new FormData();
  form.set("email", "desk@example.test");
  form.set("role", role);
  return invitePractitionerAction(form);
}
beforeEach(() => {
  vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
  vi.resetAllMocks();
  deps.seats.mockResolvedValue(studio);
  deps.insert.mockResolvedValue({ error: null });
  deps.send.mockResolvedValue({ error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("paid team invitations", () => {
  it("Solo shows the full-team state and has no receptionist invite control", () => {
    const html = renderToStaticMarkup(
      createElement(InviteForm, { seats: solo, deskEnabled: true }),
    );
    expect(html).toContain("No team seats");
    expect(html).not.toContain("<form");
  });
  it("offers a receptionist independently when the practitioner seats are full", () => {
    const html = renderToStaticMarkup(
      createElement(InviteForm, {
        seats: { ...studio, practitioner_used: 3 },
        deskEnabled: true,
      }),
    );
    expect(html).toMatch(/<option[^>]+value="receptionist"[^>]*selected/);
    expect(html).toMatch(/<option[^>]+value="owner"[^>]*disabled/);
  });
  it("supports the existing desk rollout switch and the one-receptionist limit", () => {
    expect(
      renderToStaticMarkup(
        createElement(InviteForm, { seats: studio, deskEnabled: false }),
      ),
    ).not.toContain('value="receptionist"');
    expect(
      renderToStaticMarkup(
        createElement(InviteForm, {
          seats: { ...studio, receptionist_used: 1 },
          deskEnabled: true,
        }),
      ),
    ).toMatch(/<option[^>]+value="receptionist"[^>]*disabled/);
  });
  it("creates a receptionist invitation for a subscribed Studio", async () => {
    expect(await submit("receptionist")).toMatchObject({ ok: true });
    expect(deps.insert).toHaveBeenCalledWith(
      expect.objectContaining({ role: "receptionist" }),
    );
    expect(deps.send).toHaveBeenCalledOnce();
  });
  it("refuses receptionist requests for Solo even when the form is submitted directly", async () => {
    deps.seats.mockResolvedValue(solo);
    expect(await submit("receptionist")).toMatchObject({ ok: false });
    expect(deps.insert).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });
  it.each([
    ["owner", "HN001", "practitioner"],
    ["receptionist", "HN002", "receptionist"],
  ])(
    "returns a useful seat error for %s without emailing",
    async (role, code, label) => {
      deps.insert.mockResolvedValue({ error: { code } });
      const res = await submit(role);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain(label);
      expect(deps.send).not.toHaveBeenCalled();
    },
  );
  it("reports a plan lookup failure without offering or emailing the seat", async () => {
    deps.seats.mockRejectedValue(new Error("database unavailable"));
    expect(await submit("receptionist")).toMatchObject({
      ok: false,
      error: expect.stringContaining("Try again"),
    });
    expect(deps.insert).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });
});
