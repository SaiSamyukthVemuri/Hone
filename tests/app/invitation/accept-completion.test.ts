import { beforeEach, describe, expect, it, vi } from "vitest";

const ctx = vi.hoisted(() => ({
  result: null as unknown,
  user: { id: "session-user", email: "invitee@harness.local" } as { id: string; email: string } | null,
  amr: [{ method: "otp" }] as unknown[],
  otp: vi.fn(),
  error: null as { message: string } | null,
  rpc: vi.fn(),
  clearSelection: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: {
    getUser: async () => ({ data: { user: ctx.user } }),
    getClaims: async () => ({ data: { claims: { amr: ctx.amr } }, error: null }),
    signInWithOtp: ctx.otp,
  } }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ rpc: ctx.rpc }) }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://hone.example.test" }));
vi.mock("@/lib/supabase/selected-studio", () => ({ clearSelectedStudioId: ctx.clearSelection }));
const { acceptInvitationAction } = await import("@/app/(auth)/accept-invitation/actions");
const consented = () => { const fd = new FormData(); fd.set("consent", "on"); return fd; };
const failed = { error: "Something went wrong. Please try again." };

beforeEach(() => {
  ctx.result = null;
  ctx.user = { id: "session-user", email: "invitee@harness.local" };
  ctx.amr = [{ method: "otp" }];
  ctx.otp.mockReset();
  ctx.otp.mockResolvedValue({ error: null });
  ctx.error = null;
  ctx.rpc.mockReset();
  ctx.rpc.mockImplementation(async () => ({ data: ctx.result, error: ctx.error }));
  ctx.clearSelection.mockReset();
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

describe("invitation acceptance requires mailbox proof in THIS session (email-trust, 2 Nov)", () => {
  it("NEGATIVE: a password session on an auto-confirmed account cannot accept; the command is never called", async () => {
    ctx.amr = [{ method: "password" }];
    ctx.result = { status: "linked", choose_studio: false };
    expect(await acceptInvitationAction(null, consented())).toMatchObject({ needsVerification: true });
    expect(ctx.rpc).not.toHaveBeenCalled();
    expect(ctx.clearSelection).not.toHaveBeenCalled();
  });
  it("POSITIVE: an OTP/magic-link session accepts", async () => {
    ctx.result = { status: "linked", choose_studio: false };
    await expect(acceptInvitationAction(null, consented())).rejects.toThrow("REDIRECT:/dashboard");
    expect(ctx.rpc).toHaveBeenCalledOnce();
  });
  it("POSITIVE: verified Google for the same address accepts", async () => {
    ctx.amr = [{ method: "oauth", timestamp: 1 }];
    (ctx.user as unknown as Record<string, unknown>).identities = [{ provider: "google", identity_data: { email: "invitee@harness.local", email_verified: true } }];
    ctx.result = { status: "linked", choose_studio: false };
    await expect(acceptInvitationAction(null, consented())).rejects.toThrow("REDIRECT:/dashboard");
  });
});

describe("sendMailboxProofLinkAction", () => {
  it("sends the link ONLY to the session user's own address, never creating a user", async () => {
    const { sendMailboxProofLinkAction } = await import("@/app/(auth)/accept-invitation/actions");
    const fd = new FormData(); fd.set("email", "attacker-chosen@harness.local");
    expect(await sendMailboxProofLinkAction({ status: "idle" }, fd)).toEqual({ status: "sent" });
    expect(ctx.otp).toHaveBeenCalledExactlyOnceWith({
      email: "invitee@harness.local",
      options: { shouldCreateUser: false, emailRedirectTo: "https://hone.example.test/auth/callback?next=/accept-invitation" },
    });
  });
  it("redirects to login without a session and reports a send failure without leaking it", async () => {
    const { sendMailboxProofLinkAction } = await import("@/app/(auth)/accept-invitation/actions");
    ctx.otp.mockResolvedValue({ error: { message: "rate limit internal detail" } });
    expect(await sendMailboxProofLinkAction({ status: "idle" }, new FormData())).toEqual({ status: "error", message: expect.not.stringContaining("internal") });
    ctx.user = null;
    await expect(sendMailboxProofLinkAction({ status: "idle" }, new FormData())).rejects.toThrow("REDIRECT:/login");
  });
});
