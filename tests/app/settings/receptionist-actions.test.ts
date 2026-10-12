import { beforeEach, describe, expect, it, vi } from "vitest";

// STUDIO-READY-02d (#824): the owner's deactivate/reactivate action. The owner
// is resolved on the server; the browser supplies only the receptionist id and
// the desired state; the 0216 command is called only after the owner check.

const ctx = vi.hoisted(() => ({
  role: "owner" as "owner" | "practitioner",
  rpc: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "owner-practitioner", role: ctx.role },
    studio: { id: "studio-1" },
  }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ rpc: ctx.rpc }),
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
    await expect(setReceptionistActiveAction(form({ id: "rec-1", active: "true" }))).rejects.toThrow(
      /Only studio owners/,
    );
    expect(ctx.rpc).not.toHaveBeenCalled();
  });

  it("refuses a malformed state or a missing id before any database call", async () => {
    await expect(setReceptionistActiveAction(form({ id: "rec-1", active: "yes" }))).rejects.toThrow();
    await expect(setReceptionistActiveAction(form({ active: "true" }))).rejects.toThrow();
    expect(ctx.rpc).not.toHaveBeenCalled();
  });

  it("surfaces the database's refusal for another studio's receptionist", async () => {
    ctx.rpc.mockResolvedValue({ data: "not_found", error: null });
    await expect(setReceptionistActiveAction(form({ id: "other-studio-rec", active: "false" }))).rejects.toThrow(
      /not found in this studio/,
    );
  });

  it("treats no_change as success", async () => {
    ctx.rpc.mockResolvedValue({ data: "no_change", error: null });
    await expect(setReceptionistActiveAction(form({ id: "rec-1", active: "true" }))).resolves.toBeUndefined();
  });
});
