import { beforeEach, describe, expect, it, vi } from "vitest";

// The owner's deactivate/reactivate action. The owner
// is resolved on the server; the browser supplies only the receptionist id and
// the desired state; the 0216 command is called only after the owner check.

const ctx = vi.hoisted(() => ({
  role: "owner" as "owner" | "practitioner",
  rpc: vi.fn(),
  adminCreated: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "owner-practitioner", role: ctx.role },
    studio: { id: "studio-1" },
  }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    ctx.adminCreated();
    return { rpc: ctx.rpc };
  },
}));

const { setReceptionistActiveAction } = await import("@/app/(app)/settings/team/receptionist-actions");

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(() => {
  ctx.role = "owner";
  ctx.rpc.mockReset();
  ctx.adminCreated.mockReset();
  ctx.rpc.mockResolvedValue({ data: "updated", error: null });
});

describe("setReceptionistActiveAction", () => {
  it("calls the 0216 command with the SERVER-resolved studio and owner, never form values", async () => {
    await setReceptionistActiveAction(
      form({ id: "rec-1", active: "false", studio_id: "forged-studio", owner: "forged-owner" }),
    );
    expect(ctx.rpc).toHaveBeenCalledTimes(1);
    expect(ctx.rpc).toHaveBeenCalledWith("set_studio_receptionist_active", {
      p_studio_id: "studio-1",
      p_owner_practitioner_id: "owner-practitioner",
      p_receptionist_id: "rec-1",
      p_active: false,
    });
  });

  it("refuses a non-owner before any database call", async () => {
    ctx.role = "practitioner";
    // HON-124 item 20: refusals are RETURNED sentences (a thrown message is redacted in production).
    expect(await setReceptionistActiveAction(form({ id: "rec-1", active: "true" }))).toEqual({ ok: false, error: "Only the studio owner can manage the team." });
    expect(ctx.rpc).not.toHaveBeenCalled();
  });

  it("never even CONSTRUCTS the admin client for a non-owner, or for a malformed request; the owner path constructs it exactly once", async () => {
    ctx.role = "practitioner";
    expect(await setReceptionistActiveAction(form({ id: "rec-1", active: "true" }))).toMatchObject({ ok: false });
    expect(ctx.adminCreated).not.toHaveBeenCalled();
    ctx.role = "owner";
    expect(await setReceptionistActiveAction(form({ id: "rec-1", active: "yes" }))).toMatchObject({ ok: false });
    expect(ctx.adminCreated).not.toHaveBeenCalled();
    // POSITIVE CONTROL: the owner's valid call does construct it, once, so the zero above is not a broken counter.
    await setReceptionistActiveAction(form({ id: "rec-1", active: "false" }));
    expect(ctx.adminCreated).toHaveBeenCalledTimes(1);
  });

  it("sends the SESSION's studio and owner, whatever studio or owner the form carries under any name", async () => {
    await setReceptionistActiveAction(
      form({
        id: "rec-1",
        active: "true",
        studio_id: "forged-studio",
        p_studio_id: "forged-studio",
        studioId: "forged-studio",
        p_owner_practitioner_id: "forged-owner",
        owner_practitioner_id: "forged-owner",
      }),
    );
    const args = ctx.rpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(args.p_studio_id).toBe("studio-1");
    expect(args.p_owner_practitioner_id).toBe("owner-practitioner");
    expect(JSON.stringify(args)).not.toMatch(/forged/);
  });

  it("refuses a malformed state or a missing id before any database call", async () => {
    expect(await setReceptionistActiveAction(form({ id: "rec-1", active: "yes" }))).toMatchObject({ ok: false });
    expect(await setReceptionistActiveAction(form({ active: "true" }))).toMatchObject({ ok: false });
    expect(ctx.rpc).not.toHaveBeenCalled();
  });

  it("surfaces the database's refusal for another studio's receptionist", async () => {
    ctx.rpc.mockResolvedValue({ data: "not_found", error: null });
    expect(await setReceptionistActiveAction(form({ id: "other-studio-rec", active: "false" }))).toMatchObject({ ok: false, error: expect.stringMatching(/could not be found/) });
  });

  it("names the one-active-row-per-email refusal (a database rule)", async () => {
    ctx.rpc.mockResolvedValue({ data: null, error: { code: "23505" } });
    expect(await setReceptionistActiveAction(form({ id: "rec-1", active: "true" }))).toMatchObject({ ok: false, error: expect.stringMatching(/already uses this email/) });
  });

  it("treats no_change as success", async () => {
    ctx.rpc.mockResolvedValue({ data: "no_change", error: null });
    await expect(setReceptionistActiveAction(form({ id: "rec-1", active: "true" }))).resolves.toEqual({ ok: true });
  });
});
