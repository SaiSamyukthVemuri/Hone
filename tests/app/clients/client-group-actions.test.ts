import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ identity: vi.fn(), db: vi.fn(), rpc: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: mocks.identity }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.db }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
import { changeClientGroup } from "@/app/(app)/clients/group-actions";
const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => {
  vi.clearAllMocks(); mocks.identity.mockResolvedValue({ practitioner: { role: "owner" }, studio: { id: "selected-studio" } });
  mocks.db.mockResolvedValue({ rpc: mocks.rpc }); mocks.rpc.mockResolvedValue({ data: { status: "created" }, error: null });
});
describe("client group actions", () => {
  it.each(["practitioner", "receptionist"])("denies %s before DB creation", async (role) => {
    mocks.identity.mockResolvedValue({ practitioner: { role }, studio: { id: "selected-studio" } });
    expect((await changeClientGroup({ kind: "create", name: "Active" })).ok).toBe(false);
    expect(mocks.db).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("resolves selected studio from session, trims names, revalidates affected surfaces", async () => {
    expect(await changeClientGroup({ kind: "create", name: "  Active  " })).toEqual({ ok: true, message: "Group created." });
    expect(mocks.rpc).toHaveBeenCalledWith("create_client_group", { p_studio_id: "selected-studio", p_name: "Active" });
    expect(mocks.revalidate).toHaveBeenCalledWith("/clients");
  });
  it("rejects invalid names and forged id shapes before RPC", async () => {
    for (const name of ["", "a".repeat(61), "a\nb"]) expect((await changeClientGroup({ kind: "create", name })).ok).toBe(false);
    expect((await changeClientGroup({ kind: "membership", groupId: "bad", clientId: id, assigned: true })).ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("membership changes exactly one pair through the selected studio command", async () => {
    mocks.rpc.mockResolvedValue({ data: { status: "saved" }, error: null });
    expect((await changeClientGroup({ kind: "membership", groupId: id, clientId: id, assigned: false })).ok).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("set_client_group_membership", { p_studio_id: "selected-studio", p_group_id: id, p_client_id: id, p_assigned: false });
    expect(mocks.revalidate).toHaveBeenCalledWith(`/clients/${id}`);
  });
  it("duplicate and stale outcomes are truthful failures with no success invalidation", async () => {
    for (const status of ["duplicate", "stale", "missing", "denied"]) {
      mocks.rpc.mockResolvedValue({ data: { status }, error: null });
      expect((await changeClientGroup({ kind: "rename", groupId: id, name: "Paused", expectedName: "Active", expectedUpdatedAt: "2030-01-01T00:00:00Z" })).ok).toBe(false);
    }
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("unknown results, network errors and session failure never claim saved or unchanged", async () => {
    for (const response of [{ data: null, error: { message: "secret sql" } }, { data: { status: "unknown" }, error: null }]) {
      mocks.rpc.mockResolvedValue(response);
      const result = await changeClientGroup({ kind: "create", name: "Active" });
      expect(result.ok).toBe(false); expect(JSON.stringify(result)).toContain("Reload"); expect(JSON.stringify(result)).not.toContain("secret sql");
    }
    mocks.rpc.mockRejectedValue(new Error("transport"));
    expect((await changeClientGroup({ kind: "create", name: "Active" })).ok).toBe(false);
    mocks.identity.mockRejectedValue(new Error("session"));
    expect((await changeClientGroup({ kind: "create", name: "Active" })).ok).toBe(false);
  });
});
