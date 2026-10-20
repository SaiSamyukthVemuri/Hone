import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// STUDIO-READY-02b (#824), Codex P2 4243953164 on #850: a front-desk acceptance
// lands on the front desk, whatever other memberships the person holds, and a
// second desk studio goes through the receptionist chooser, never a stale
// selection.

const ctx = vi.hoisted(() => ({
  result: {} as Record<string, unknown>,
  user: { id: "user-1" } as { id: string } | null,
  rpc: vi.fn(),
  rpcError: null as { code: string; message: string } | null,
  cleared: 0, adminCleared: 0, fulfilled: 0,
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: ctx.user } }) } }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ rpc: ctx.rpc }),
}));
vi.mock("@/lib/supabase/selected-studio", () => ({
  clearSelectedStudioId: async () => {
    ctx.cleared += 1;
  },
}));

// This routing test has no Next request/cookie jar. Admin-return behavior has
// its own tests; model its absent remembered target at this boundary.
vi.mock("@/lib/auth/admin-return", () => ({
  clearAdminReturn: async () => { ctx.adminCleared += 1; },
  fulfilAdminReturn: async () => { ctx.fulfilled += 1; return null; },
}));

const { acceptInvitationAction } = await import("@/app/(auth)/accept-invitation/actions");

const consented = () => {
  const f = new FormData();
  f.set("consent", "on");
  return f;
};
const destination = (result: Record<string, unknown>) => {
  ctx.result = result;
  return acceptInvitationAction({} as never, consented()).then(
    () => "no redirect",
    (e: Error) => e.message.replace("REDIRECT:", ""),
  );
};

beforeEach(() => {
  ctx.user = { id: "user-1" };
  ctx.rpcError = null;
  ctx.rpc.mockReset();
  ctx.rpc.mockImplementation(async () => ({ data: ctx.result, error: ctx.rpcError }));
  ctx.cleared = 0;
  ctx.adminCleared = 0;
  ctx.fulfilled = 0;
});

describe("acceptInvitationAction routes by the accepted role", () => {
  it("a receptionist lands on /front-desk, even if they practise elsewhere", async () => {
    expect(await destination({ status: "linked", role: "receptionist", choose_studio: false })).toBe("/front-desk");
    expect(ctx.cleared).toBe(0);
  });

  it("a receptionist at 2+ desks clears the stale selection and goes to the receptionist chooser", async () => {
    expect(await destination({ status: "linked", role: "receptionist", choose_studio: true })).toBe("/front-desk/select");
    expect(ctx.cleared).toBe(1);
  });

  it("a practitioner acceptance is unchanged: /dashboard", async () => {
    expect(await destination({ status: "linked", role: "practitioner", choose_studio: false })).toBe("/dashboard");
    expect(ctx.fulfilled).toBe(1);
    expect(ctx.adminCleared).toBe(0);
  });

  it("a conflict still goes to the conflict page", async () => {
    expect(await destination({ status: "conflict", choose_studio: false })).toBe("/no-access?reason=invite-conflict");
    expect(ctx.adminCleared).toBe(1);
    expect(ctx.fulfilled).toBe(0);
  });
});

describe("the auth callback routes a reconciled receptionist the same way", () => {
  const ROUTE = readFileSync(path.join(process.cwd(), "app/(auth)/auth/callback/route.ts"), "utf8");

  it("sends role 'receptionist' to /front-desk or the chooser, before the practitioner multi-studio branch", () => {
    const desk = ROUTE.indexOf('status?.role === "receptionist"');
    expect(desk).toBeGreaterThan(-1);
    expect(ROUTE).toMatch(/dest = status\.choose_studio === true \? "\/front-desk\/select" : "\/front-desk";/);
    expect(desk).toBeLessThan(ROUTE.indexOf("Newly a multi-studio user"));
  });
});


describe("HON-44 invitation acceptance authority", () => {
  it("ignores forged identity, role and studio; acceptance receives only the authenticated user", async () => {
    ctx.result = { status: "linked", role: "receptionist", choose_studio: false };
    const fd = consented();
    for (const [key, value] of Object.entries({ user_id: "foreign-user", email: "forged@harness.local", studio_id: "foreign-studio", role: "owner" })) fd.set(key, value);
    await expect(acceptInvitationAction(null, fd)).rejects.toThrow("REDIRECT:/front-desk");
    expect(ctx.rpc).toHaveBeenCalledTimes(1);
    expect(ctx.rpc).toHaveBeenCalledWith("admin_accept_pending_invitation", { p_user_id: "user-1" });
    expect(ctx.fulfilled).toBe(1);
  });

  it("requires explicit consent before any privileged acceptance call", async () => {
    const result = await acceptInvitationAction(null, new FormData());
    expect(result?.error).toContain("Please confirm");
    expect(ctx.rpc).not.toHaveBeenCalled();
  });

  it("a signed-out request cannot accept an invitation or supply its own user", async () => {
    ctx.user = null;
    const fd = consented();
    fd.set("user_id", "foreign-user");
    await expect(acceptInvitationAction(null, fd)).rejects.toThrow("REDIRECT:/login");
    expect(ctx.rpc).not.toHaveBeenCalled();
  });

  it("a failed acceptance never redirects on returned role data or echoes database details", async () => {
    ctx.result = { status: "linked", role: "owner" };
    ctx.rpcError = { code: "42501", message: "private database detail" };
    expect(await acceptInvitationAction(null, consented())).toEqual({ error: "Something went wrong. Please try again." });
    expect(ctx.fulfilled).toBe(0);
  });

  it.each([ ["no_invitation", "/no-access"], ["ambiguous", "/no-access?reason=invite-ambiguous"] ])("refuses %s even if a role is returned", async (status, expected) => {
    expect(await destination({ status, role: "owner" })).toBe(expected);
    expect(ctx.adminCleared).toBe(1);
    expect(ctx.fulfilled).toBe(0);
  });
});
