import { beforeEach, describe, expect, it, vi } from "vitest";

// R5 slice 1: client.create is asked before any client write, by both creation actions. The Roles engine has its own tests.
const from = vi.fn(() => { throw new Error("no client write may happen when client.create is denied"); });
const ask = vi.fn();
vi.mock("@/lib/permissions/require-permission", () => ({ requirePermission: (...a: unknown[]) => ask(...a) }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); }, notFound: () => { throw new Error("notFound"); } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: () => undefined }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "p1", active: true, role: "practitioner", display_name: "P", email: "p@example.com" }, studio: { id: "studio-1" } }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from, rpc: vi.fn() }) }));

import { createClientAction } from "@/app/(app)/clients/new/actions";
import { createClientForCalendarBookingAction } from "@/app/(app)/calendar/actions";

const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

describe("client.create is enforced by both client-creation actions", () => {
  beforeEach(() => { from.mockClear(); ask.mockReset(); });

  it("new-client page: denied -> refused with a plain message, nothing read or written", async () => {
    ask.mockResolvedValue({ allowed: false, mode: "enforce", engine: false });
    const res = await createClientAction(form({ name: "Synthetic Person" }));
    expect(res).toEqual({ ok: false, error: "You don't have permission to add clients." });
    expect(ask).toHaveBeenCalledWith(expect.anything(), "studio-1", "client.create");
    expect(from).not.toHaveBeenCalled();
  });

  it("quick-book drawer: denied -> refused, no insert", async () => {
    ask.mockResolvedValue({ allowed: false, mode: "enforce", engine: false });
    const res = await createClientForCalendarBookingAction(form({ name: "Synthetic Person" }));
    expect(res).toEqual({ ok: false, error: "You don't have permission to add clients." });
    expect(ask).toHaveBeenCalledWith(expect.anything(), "studio-1", "client.create");
    expect(from).not.toHaveBeenCalled();
  });

  it("allowed -> the action proceeds to its own checks (it reaches the database)", async () => {
    ask.mockResolvedValue({ allowed: true, mode: "enforce", engine: true });
    await createClientForCalendarBookingAction(form({ name: "Synthetic Person" })).catch(() => undefined);
    expect(from).toHaveBeenCalled();
  });
});
