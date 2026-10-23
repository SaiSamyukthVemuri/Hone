import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// STUDIO-READY-02b (#824), Codex P2 4243953164 on #850: a front-desk acceptance
// lands on the front desk, whatever other memberships the person holds, and a
// second desk studio goes through the receptionist chooser, never a stale
// selection.

const ctx = vi.hoisted(() => ({ result: {} as Record<string, unknown>, cleared: 0 }));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ rpc: async () => ({ data: ctx.result, error: null }) }),
}));
vi.mock("@/lib/supabase/selected-studio", () => ({
  clearSelectedStudioId: async () => {
    ctx.cleared += 1;
  },
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
  ctx.cleared = 0;
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
  });

  // Production's completion guard (accept only a confirmed linked /
  // already_linked) met this routing when production was merged into #850.
  // The guard runs first, so a receptionist role never routes on its own.
  it.each([
    { status: "unknown", role: "receptionist", choose_studio: true },
    { role: "receptionist", choose_studio: false },
  ])("an unconfirmed receptionist acceptance routes nowhere and clears nothing: %j", async (result) => {
    expect(await destination(result)).toBe("no redirect");
    expect(ctx.cleared).toBe(0);
  });

  it("an already_linked receptionist still lands on /front-desk", async () => {
    expect(await destination({ status: "already_linked", role: "receptionist", choose_studio: false })).toBe("/front-desk");
  });

  it("a conflict still goes to the conflict page", async () => {
    expect(await destination({ status: "conflict", choose_studio: false })).toBe("/no-access?reason=invite-conflict");
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
