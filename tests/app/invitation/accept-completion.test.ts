import { beforeEach, describe, expect, it, vi } from "vitest";

const ctx = vi.hoisted(() => ({
  result: null as unknown,
  user: { id: "session-user" } as { id: string } | null,
  error: null as { message: string } | null,
  rpc: vi.fn(),
  tables: { practitioners: [] as unknown[], studio_receptionists: [] as unknown[] },
  clearSelection: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: ctx.user } }) },
    from: (t: string) => {
      const q: Record<string, unknown> = { select: () => q, eq: () => q, limit: async () => ({ data: ctx.tables[t as keyof typeof ctx.tables], error: null }) };
      return q;
    },
  }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ rpc: ctx.rpc }) }));
vi.mock("@/lib/supabase/selected-studio", () => ({ clearSelectedStudioId: ctx.clearSelection }));
const { acceptInvitationAction } = await import("@/app/(auth)/accept-invitation/actions");
const consented = () => { const fd = new FormData(); fd.set("consent", "on"); return fd; };
const failed = { error: "Something went wrong. Please try again." };

beforeEach(() => {
  ctx.result = null;
  ctx.user = { id: "session-user" };
  ctx.error = null;
  ctx.rpc.mockReset();
  ctx.rpc.mockImplementation(async () => ({ data: ctx.result, error: ctx.error }));
  ctx.clearSelection.mockReset();
  ctx.tables = { practitioners: [], studio_receptionists: [] };
  vi.unstubAllEnvs();
});

describe("invitation completion requires an explicit command success", () => {
  it.each([
    { label: "null", result: null },
    { label: "empty array", result: [] },
    { label: "missing status", result: {} },
    { label: "unknown status requesting chooser", result: { status: "unknown", choose_studio: true } },
    { label: "acceptance_required", result: { status: "acceptance_required", choose_studio: true } },
  ])("refuses $label without changing studio selection", async ({ result }) => {
    ctx.result = result;
    expect(await acceptInvitationAction(null, consented())).toEqual(failed);
    expect(ctx.rpc).toHaveBeenCalledExactlyOnceWith("admin_accept_pending_invitation", { p_user_id: "session-user" });
    expect(ctx.clearSelection).not.toHaveBeenCalled();
  });
  it.each(["linked", "already_linked"])("preserves %s dashboard completion", async (status) => {
    ctx.result = { status, choose_studio: false };
    await expect(acceptInvitationAction(null, consented())).rejects.toThrow("REDIRECT:/dashboard");
    expect(ctx.clearSelection).not.toHaveBeenCalled();
  });
  it.each(["linked", "already_linked"])("preserves %s multi-studio selection clearing", async (status) => {
    ctx.result = { status, choose_studio: true };
    await expect(acceptInvitationAction(null, consented())).rejects.toThrow("REDIRECT:/dashboard");
    expect(ctx.clearSelection).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["conflict", "/no-access?reason=invite-conflict"],
    ["ambiguous", "/no-access?reason=invite-ambiguous"],
    ["no_invitation", "/no-access"],
  ])("preserves %s refusal", async (status, target) => {
    ctx.result = { status, choose_studio: true };
    await expect(acceptInvitationAction(null, consented())).rejects.toThrow(`REDIRECT:${target}`);
    expect(ctx.clearSelection).not.toHaveBeenCalled();
  });
  it("requires consent before calling acceptance", async () => {
    expect((await acceptInvitationAction(null, new FormData()))?.error).toContain("Please confirm");
    expect(ctx.rpc).not.toHaveBeenCalled();
  });
  it("rejects signed-out acceptance before RPC", async () => {
    ctx.user = null;
    await expect(acceptInvitationAction(null, consented())).rejects.toThrow("REDIRECT:/login");
    expect(ctx.rpc).not.toHaveBeenCalled();
  });
  it("uses only authenticated identity despite forged form authority", async () => {
    ctx.result = { status: "linked" };
    const fd = consented();
    for (const key of ["user_id", "email", "studio_id", "role"]) fd.set(key, "forged");
    await expect(acceptInvitationAction(null, fd)).rejects.toThrow("REDIRECT:/dashboard");
    expect(ctx.rpc).toHaveBeenCalledExactlyOnceWith("admin_accept_pending_invitation", { p_user_id: "session-user" });
  });
  it("keeps RPC failure generic even with a success payload", async () => {
    ctx.result = { status: "linked", choose_studio: true };
    ctx.error = { message: "private database detail" };
    expect(await acceptInvitationAction(null, consented())).toEqual(failed);
    expect(ctx.clearSelection).not.toHaveBeenCalled();
  });
});

describe("desk landing after explicit acceptance (Codex #1303)", () => {
  it("receptionist-only user with the flag on lands on /desk", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
    ctx.tables = { practitioners: [], studio_receptionists: [{ id: "r1" }] };
    ctx.result = { status: "linked", choose_studio: false };
    await expect(acceptInvitationAction(null, consented())).rejects.toThrow("REDIRECT:/desk");
  });
  it("a practitioner membership keeps /dashboard even with the flag on", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
    ctx.tables = { practitioners: [{ studio_id: "s" }], studio_receptionists: [{ id: "r1" }] };
    ctx.result = { status: "linked", choose_studio: false };
    await expect(acceptInvitationAction(null, consented())).rejects.toThrow("REDIRECT:/dashboard");
  });
  it("flag off keeps /dashboard for a receptionist-only user", async () => {
    ctx.tables = { practitioners: [], studio_receptionists: [{ id: "r1" }] };
    ctx.result = { status: "linked", choose_studio: false };
    await expect(acceptInvitationAction(null, consented())).rejects.toThrow("REDIRECT:/dashboard");
  });
});
