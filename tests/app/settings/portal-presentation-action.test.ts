import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPortalPresentation } from "@/lib/portal/presentation";
import { editPortalPresentation } from "@/app/(app)/settings/studio/client-portal/actions";

const { actor, client, rpc, invalidate } = vi.hoisted(() => ({
  actor: vi.fn(), client: vi.fn(), rpc: vi.fn(), invalidate: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: actor }));
vi.mock("@/lib/supabase/server", () => ({ createClient: client }));
vi.mock("next/cache", () => ({ revalidatePath: invalidate }));
const studioId = "55555555-1111-4444-8888-111111111111";
const otherId = "55555555-1111-4444-8888-111111111112";

beforeEach(() => {
  vi.stubEnv("HONE_PORTAL_REDESIGN_STUDIO_IDS", studioId + "," + otherId);
  actor.mockResolvedValue({ practitioner: { role: "owner" }, studio: { id: studioId } });
  client.mockResolvedValue({ rpc });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("studio portal editor server action", () => {
  it("refuses a tab left open for another studio, an unenrolled owner and an ordinary staff member", async () => {
    expect((await editPortalPresentation(otherId, 1, "publish")).ok).toBe(false);
    vi.stubEnv("HONE_PORTAL_REDESIGN_STUDIO_IDS", otherId);
    expect((await editPortalPresentation(studioId, 1, "classic")).ok).toBe(false);
    actor.mockResolvedValue({ practitioner: { role: "practitioner" }, studio: { id: otherId } });
    expect((await editPortalPresentation(otherId, 1, "publish")).ok).toBe(false);
    expect(client).not.toHaveBeenCalled();
  });
  it("refuses malformed copy before writing and leaves cached results intact on stale writes", async () => {
    expect((await editPortalPresentation(studioId, 0, "save", {})).ok).toBe(false);
    expect(client).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ data: null, error: { code: "40001" } });
    expect(await editPortalPresentation(studioId, 1, "publish")).toEqual({
      ok: false, reload: true, error: "These settings changed in another window. Reload before editing again.",
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
  it("publishes only the stored draft at that revision; rollback sends no copy", async () => {
    rpc.mockResolvedValue({ data: 3, error: null });
    for (const operation of ["publish", "classic"] as const) {
      expect(await editPortalPresentation(studioId, 2, operation, defaultPortalPresentation())).toEqual({ ok: true, revision: 3 });
      expect(rpc).toHaveBeenLastCalledWith("edit_studio_portal_presentation", {
        p_studio_id: studioId, p_operation: operation, p_revision: 2, p_draft: null,
      });
    }
  });
});
